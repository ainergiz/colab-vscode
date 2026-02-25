/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// cspell:ignore healthz

const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';
const DEFAULT_TOKEN_FILE = '~/.colab-agent-bridge.token';
const DEFAULT_TIMEOUT_MS = 30_000;

type Command = 'up' | 'status' | 'mcp' | 'help';

interface CliOptions {
  readonly json: boolean;
  readonly timeoutMs: number;
  readonly stateFile: string;
  readonly tokenFile: string;
  readonly cursorApp: string;
  readonly workspace?: string;
  readonly openCursor: boolean;
}

interface ParsedArgs {
  readonly command: Command;
  readonly options: CliOptions;
}

interface BridgeState {
  readonly endpoint?: string;
  readonly host?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly startedAt?: string;
}

interface HealthResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

interface PingResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly reason?: string;
}

interface AgentStatusResult {
  readonly ready: boolean;
  readonly endpoint: string;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly stateFile: string;
  readonly tokenSource: string;
  readonly health: HealthResult;
  readonly authPing: PingResult;
}

function usage(): string {
  return [
    'Usage:',
    '  colab-agent [up] [options]',
    '  colab-agent status [options]',
    '  colab-agent mcp [options]',
    '',
    'Options:',
    '  --json                     Print JSON output',
    `  --timeout-ms <n>           Startup timeout (default ${DEFAULT_TIMEOUT_MS.toString()})`,
    `  --state-file <path>        State file (default ${DEFAULT_STATE_FILE})`,
    `  --token-file <path>        Token file (default ${DEFAULT_TOKEN_FILE})`,
    '  --cursor-app <name>        App name for open -a (default Cursor)',
    '  --workspace <path>         Optional path to open in Cursor',
    '  --no-open-cursor           Skip opening Cursor before checks',
    '',
    'Examples:',
    '  colab-agent',
    '  colab-agent up --json',
    '  colab-agent status',
    '  colab-agent mcp',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolvePathWithHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntFlag(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: Command = 'up';
  let startIndex = 0;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const raw = argv[0];
    if (raw === 'up' || raw === 'status' || raw === 'mcp' || raw === 'help') {
      command = raw;
      startIndex = 1;
    } else {
      throw new Error(`Unknown command: ${raw}`);
    }
  }

  let json = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let stateFile =
    process.env.COLAB_AGENT_BRIDGE_STATE_FILE ?? DEFAULT_STATE_FILE;
  let tokenFile =
    process.env.COLAB_AGENT_BRIDGE_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  let cursorApp = process.env.COLAB_AGENT_CURSOR_APP ?? 'Cursor';
  let workspace = process.env.COLAB_AGENT_CURSOR_WORKSPACE;
  let openCursor = true;

  for (let i = startIndex; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--timeout-ms': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('--timeout-ms requires a value.');
        }
        timeoutMs = parseIntFlag(value, '--timeout-ms');
        i += 1;
        break;
      }
      case '--state-file': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('--state-file requires a value.');
        }
        stateFile = value;
        i += 1;
        break;
      }
      case '--token-file': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('--token-file requires a value.');
        }
        tokenFile = value;
        i += 1;
        break;
      }
      case '--cursor-app': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('--cursor-app requires a value.');
        }
        cursorApp = value;
        i += 1;
        break;
      }
      case '--workspace': {
        const value = argv[i + 1];
        if (!value) {
          throw new Error('--workspace requires a value.');
        }
        workspace = value;
        i += 1;
        break;
      }
      case '--no-open-cursor':
        openCursor = false;
        break;
      case '--help':
      case '-h':
        command = 'help';
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    command,
    options: {
      json,
      timeoutMs,
      stateFile,
      tokenFile,
      cursorApp,
      workspace,
      openCursor,
    },
  };
}

async function spawnAndWait(cmd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: false,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} exited with code ${String(code)}`));
    });
  });
}

async function runOpenCursor(options: CliOptions): Promise<void> {
  if (!options.openCursor) {
    return;
  }
  const args: string[] = ['-a', options.cursorApp];
  if (options.workspace) {
    args.push(resolvePathWithHome(options.workspace));
  }
  await spawnAndWait('open', args);
}

function endpointFromState(state: BridgeState): string | undefined {
  if (typeof state.endpoint === 'string' && state.endpoint.trim().length > 0) {
    return state.endpoint.trim();
  }
  if (typeof state.host === 'string' && typeof state.port === 'number') {
    return `http://${state.host}:${state.port.toString()}/v1/colab-agent`;
  }
  return undefined;
}

async function waitForStateFile(
  options: CliOptions,
): Promise<{
  readonly stateFilePath: string;
  readonly state: BridgeState;
  readonly endpoint: string;
}> {
  const stateFilePath = resolvePathWithHome(options.stateFile);
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(stateFilePath)) {
      try {
        const raw = await readFile(stateFilePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (isRecord(parsed)) {
          const state: BridgeState = {
            endpoint:
              typeof parsed.endpoint === 'string' ? parsed.endpoint : undefined,
            host: typeof parsed.host === 'string' ? parsed.host : undefined,
            port: typeof parsed.port === 'number' ? parsed.port : undefined,
            pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
            startedAt:
              typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
          };
          const endpoint = endpointFromState(state);
          if (endpoint) {
            return { stateFilePath, state, endpoint };
          }
        }
      } catch (_error) {
        // The file may still be updating; retry.
      }
    }
    await sleep(400);
  }

  throw new Error(
    `Timed out waiting for bridge state file: ${stateFilePath}`,
  );
}

async function readToken(
  options: CliOptions,
): Promise<{ readonly token: string; readonly source: string }> {
  const envToken = process.env.COLAB_AGENT_BRIDGE_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    return { token: envToken, source: 'env' };
  }

  const tokenFilePath = resolvePathWithHome(options.tokenFile);
  if (!existsSync(tokenFilePath)) {
    return { token: '', source: tokenFilePath };
  }

  const token = (await readFile(tokenFilePath, 'utf8')).trim();
  return { token, source: tokenFilePath };
}

function parseJsonMaybe(raw: string): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (_error) {
    return { raw };
  }
}

function baseFromEndpoint(endpoint: string): string {
  return endpoint.replace(/\/v1\/colab-agent\/?$/, '');
}

async function checkHealth(endpoint: string): Promise<HealthResult> {
  const base = baseFromEndpoint(endpoint);
  const response = await fetch(`${base}/healthz`, { method: 'GET' });
  const body = parseJsonMaybe(await response.text());
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

async function checkPing(endpoint: string, token: string): Promise<PingResult> {
  if (!token) {
    return {
      ok: false,
      status: 0,
      body: null,
      reason: 'TOKEN_MISSING',
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: `ping-${Date.now().toString()}`,
      method: 'ping',
      params: {},
    }),
  });

  const body = parseJsonMaybe(await response.text());
  const ok = response.ok && isRecord(body) && body.ok === true;
  return {
    ok,
    status: response.status,
    body,
  };
}

async function runStatus(options: CliOptions): Promise<AgentStatusResult> {
  const waitOptions: CliOptions = {
    ...options,
    openCursor: false,
    timeoutMs: Math.max(1000, options.timeoutMs),
  };
  const { stateFilePath, state, endpoint } = await waitForStateFile(
    waitOptions,
  );
  const health = await checkHealth(endpoint);
  const tokenInfo = await readToken(options);
  const authPing = await checkPing(endpoint, tokenInfo.token);

  return {
    ready: health.ok && authPing.ok,
    endpoint,
    pid: state.pid ?? null,
    startedAt: state.startedAt ?? null,
    stateFile: stateFilePath,
    tokenSource: tokenInfo.source,
    health,
    authPing,
  };
}

async function runUp(options: CliOptions): Promise<AgentStatusResult> {
  await runOpenCursor(options);
  return await runStatus(options);
}

async function runMcp(options: CliOptions): Promise<void> {
  const status = await runUp(options);
  if (!status.ready) {
    throw new Error(
      'Bridge is not ready. Run "colab-agent status --json" for details.',
    );
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const scriptPath = path.join(
    repoRoot,
    'scripts',
    'colab-agent-bridge-mcp.mts',
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsx', scriptPath], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        COLAB_AGENT_BRIDGE_STATE_FILE: resolvePathWithHome(options.stateFile),
        COLAB_AGENT_BRIDGE_TOKEN_FILE: resolvePathWithHome(options.tokenFile),
      },
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`MCP server exited with code ${String(code)}`));
    });
  });
}

function printStatus(result: AgentStatusResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`ready: ${result.ready ? 'yes' : 'no'}`);
  console.log(`endpoint: ${result.endpoint}`);
  if (result.pid !== null) {
    console.log(`pid: ${result.pid.toString()}`);
  }
  console.log(`health: ${result.health.status.toString()}`);
  if (result.authPing.ok) {
    console.log('authPing: ok');
  } else {
    console.log(`authPing: failed(${result.authPing.status.toString()})`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.command) {
    case 'help':
      console.log(usage());
      return;
    case 'status': {
      const status = await runStatus(parsed.options);
      printStatus(status, parsed.options.json);
      if (!status.ready) {
        process.exitCode = 1;
      }
      return;
    }
    case 'up': {
      const status = await runUp(parsed.options);
      printStatus(status, parsed.options.json);
      if (!status.ready) {
        process.exitCode = 1;
      }
      return;
    }
    case 'mcp':
      await runMcp(parsed.options);
      return;
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  console.error(message);
  process.exitCode = 2;
});
