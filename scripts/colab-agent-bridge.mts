/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';

interface BridgeState {
  readonly endpoint?: string;
  readonly host: string;
  readonly port: number;
}

function resolveStateFilePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/colab-agent-bridge.mts <method> [json-params|@params-file|-]',
    '',
    'Examples:',
    '  npx tsx scripts/colab-agent-bridge.mts ping',
    '  npx tsx scripts/colab-agent-bridge.mts bridge.capabilities',
    '  npx tsx scripts/colab-agent-bridge.mts runtimes.options',
    "  npx tsx scripts/colab-agent-bridge.mts runs.start '{\"kind\":\"notebook.runAll\",\"args\":{\"notebookPath\":\"./notebooks/01_example.ipynb\"}}'",
    "  npx tsx scripts/colab-agent-bridge.mts runs.status '{\"runId\":\"<run-id>\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runs.list '{\"limit\":20}'",
    "  npx tsx scripts/colab-agent-bridge.mts runs.cancel '{\"runId\":\"<run-id>\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtimes.list '{\"from\":\"all\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtimes.start '{\"mode\":\"latestOrCreate\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts notebook.execute '{\"code\":\"print(123)\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts notebook.runAll '{\"notebookPath\":\"./notebooks/00_env_check.ipynb\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtime.files.writeText '{\"runtimePath\":\"/content/drive/MyDrive/voice-moonshot/notes.txt\",\"text\":\"hello\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtime.secrets.sync @/tmp/hf-sync.json",
    "  cat /tmp/hf-sync.json | npx tsx scripts/colab-agent-bridge.mts runtime.secrets.sync -",
    '',
    'Environment:',
    '  COLAB_AGENT_BRIDGE_STATE_FILE (optional)',
    '  COLAB_AGENT_BRIDGE_TOKEN (required)',
  ].join('\n');
}

async function readStdinText(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', reject);
  });
}

async function parseParams(rawParams?: string): Promise<unknown> {
  if (!rawParams) {
    return {};
  }

  let source = rawParams;
  if (rawParams === '-') {
    source = (await readStdinText()).trim();
  } else if (rawParams.startsWith('@')) {
    const paramsFile = path.resolve(rawParams.slice(1));
    source = (await readFile(paramsFile, 'utf8')).trim();
  }

  if (source.length === 0) {
    return {};
  }

  return JSON.parse(source);
}

async function getEndpointFromStateFile(
  stateFilePath: string,
): Promise<string> {
  const raw = await readFile(stateFilePath, 'utf8');
  const state = JSON.parse(raw) as BridgeState;
  if (state.endpoint && state.endpoint.length > 0) {
    return state.endpoint;
  }
  return `http://${state.host}:${state.port.toString()}/v1/colab-agent`;
}

async function main(): Promise<void> {
  const [method, rawParams] = process.argv.slice(2);
  if (!method) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  let params: unknown;
  if (rawParams) {
    try {
      params = await parseParams(rawParams);
    } catch (_error) {
      console.error('json-params must be valid JSON.');
      process.exitCode = 2;
      return;
    }
  } else {
    params = {};
  }

  const stateFile = resolveStateFilePath(
    process.env.COLAB_AGENT_BRIDGE_STATE_FILE ?? DEFAULT_STATE_FILE,
  );
  const endpoint = await getEndpointFromStateFile(stateFile);
  const token = process.env.COLAB_AGENT_BRIDGE_TOKEN?.trim();
  if (!token) {
    console.error('COLAB_AGENT_BRIDGE_TOKEN is required.');
    process.exitCode = 2;
    return;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: `${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
      method,
      params,
    }),
  });
  const payload = (await response.json()) as {
    readonly ok?: boolean;
  };

  console.log(JSON.stringify(payload, undefined, 2));

  if (!response.ok || payload.ok === false) {
    process.exitCode = 1;
  }
}

void main();
