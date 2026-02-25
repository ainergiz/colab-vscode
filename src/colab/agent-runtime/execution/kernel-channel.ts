/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from '../../headers';
import { log } from '../../../common/logging';
import { JupyterClient } from '../../../jupyter/client';
import { ColabAssignedServer } from '../../../jupyter/servers';
import { NotebookExecutionOutput } from '../types';

export interface KernelExecutionResult {
  readonly status: 'ok' | 'error';
  readonly outputs: readonly NotebookExecutionOutput[];
  readonly reply: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTraceback(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const lines = value.filter((line): line is string => typeof line === 'string');
  return lines.length > 0 ? lines : undefined;
}

function parseKernelMessage(
  rawData: WebSocket.RawData,
): Record<string, unknown> | undefined {
  let rawString: string;
  if (typeof rawData === 'string') {
    rawString = rawData;
  } else if (Buffer.isBuffer(rawData)) {
    rawString = rawData.toString('utf8');
  } else if (Array.isArray(rawData)) {
    rawString = Buffer.concat(rawData).toString('utf8');
  } else if (rawData instanceof ArrayBuffer) {
    rawString = Buffer.from(rawData).toString('utf8');
  } else {
    rawString = Buffer.from(rawData).toString('utf8');
  }

  try {
    const parsed: unknown = JSON.parse(rawString);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function plainTextFromData(data: Record<string, unknown>): string | undefined {
  const textPlain = data['text/plain'];
  if (typeof textPlain === 'string') {
    return textPlain;
  }
  if (Array.isArray(textPlain)) {
    const lines = textPlain.filter((line): line is string => typeof line === 'string');
    if (lines.length > 0) {
      return lines.join('\n');
    }
  }
  return undefined;
}

function buildKernelChannelsUrl(
  baseUrl: string,
  kernelId: string,
  sessionId: string,
): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `api/kernels/${encodeURIComponent(kernelId)}/channels`,
    normalizedBaseUrl,
  );
  url.searchParams.set('session_id', sessionId);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function makeSessionName(): string {
  return `agent-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export async function resolveKernelName(
  client: JupyterClient,
  requestedKernelName?: string,
): Promise<string> {
  if (requestedKernelName) {
    return requestedKernelName;
  }

  try {
    const specs = await client.kernelspecs.list();
    if (specs._default) {
      return specs._default;
    }
    const firstKnown = Object.keys(specs.kernelspecs ?? {})[0];
    if (firstKnown) {
      return firstKnown;
    }
  } catch (error) {
    log.warn('Unable to resolve kernel spec; defaulting to python3.', error);
  }
  return 'python3';
}

export async function executeCodeOnKernel(
  runtime: ColabAssignedServer,
  kernelId: string,
  code: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<KernelExecutionResult> {
  return await new Promise<KernelExecutionResult>((resolve, reject) => {
    const clientSessionId = randomUUID();
    const executionRequestId = randomUUID();
    const outputs: NotebookExecutionOutput[] = [];
    let executeReply: Record<string, unknown> | undefined;
    let idleSeen = false;
    let settled = false;

    const headers: Record<string, string> = {};
    const connectionHeaders = runtime.connectionInformation.headers ?? {};
    for (const [key, value] of Object.entries(connectionHeaders)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
    headers[COLAB_RUNTIME_PROXY_TOKEN_HEADER.key] =
      runtime.connectionInformation.token;
    headers[COLAB_CLIENT_AGENT_HEADER.key] = COLAB_CLIENT_AGENT_HEADER.value;
    const ws = new WebSocket(
      buildKernelChannelsUrl(
        runtime.connectionInformation.baseUrl.toString(),
        kernelId,
        clientSessionId,
      ),
      { headers },
    );

    const timer = setTimeout(() => {
      finish(new Error(`Execution timed out after ${timeoutMs.toString()} ms.`));
    }, timeoutMs);

    const abortHandler = () => {
      const abortError = new Error('Execution canceled.');
      abortError.name = 'AbortError';
      finish(abortError);
    };
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener('abort', abortHandler, { once: true });

    function finish(error?: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      ws.removeAllListeners();
      if (
        ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN
      ) {
        ws.close();
      }
      if (error) {
        reject(error);
        return;
      }

      const reply = executeReply ?? {};
      const statusValue = reply.status;
      const status =
        typeof statusValue === 'string' && statusValue === 'ok' ? 'ok' : 'error';

      if (status === 'error' && outputs.every((o) => o.type !== 'error')) {
        outputs.push({
          type: 'error',
          ename:
            typeof reply.ename === 'string' ? reply.ename : 'ExecutionError',
          evalue:
            typeof reply.evalue === 'string' ? reply.evalue : 'Execution failed.',
          traceback: parseTraceback(reply.traceback),
        });
      }

      resolve({
        status,
        outputs,
        reply,
      });
    }

    ws.on('open', () => {
      const request = {
        channel: 'shell',
        header: {
          msg_id: executionRequestId,
          username: 'colab-agent',
          session: clientSessionId,
          msg_type: 'execute_request',
          version: '5.3',
          date: new Date().toISOString(),
        },
        parent_header: {},
        metadata: {},
        content: {
          code,
          silent: false,
          store_history: true,
          user_expressions: {},
          allow_stdin: false,
          stop_on_error: true,
        },
      };
      ws.send(JSON.stringify(request));
    });

    ws.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    ws.on('close', () => {
      if (!settled) {
        finish(new Error('Kernel channel closed before execution completed.'));
      }
    });

    ws.on('message', (rawData: WebSocket.RawData) => {
      const message = parseKernelMessage(rawData);
      if (!message) {
        return;
      }

      const parentHeader = message.parent_header;
      if (!isRecord(parentHeader)) {
        return;
      }
      if (parentHeader.msg_id !== executionRequestId) {
        return;
      }

      const header = message.header;
      if (!isRecord(header)) {
        return;
      }

      const msgType = header.msg_type;
      if (typeof msgType !== 'string') {
        return;
      }

      const channel = message.channel;
      const content = isRecord(message.content) ? message.content : {};

      if (channel === 'iopub') {
        if (msgType === 'status') {
          if (content.execution_state === 'idle') {
            idleSeen = true;
            if (executeReply) {
              finish();
            }
          }
          return;
        }

        if (msgType === 'stream') {
          outputs.push({
            type: 'stream',
            name: typeof content.name === 'string' ? content.name : 'stdout',
            text: typeof content.text === 'string' ? content.text : '',
          });
          return;
        }

        if (msgType === 'execute_result' || msgType === 'display_data') {
          const data = isRecord(content.data) ? content.data : {};
          const executionCount =
            typeof content.execution_count === 'number'
              ? content.execution_count
              : undefined;
          outputs.push({
            type: msgType,
            data,
            text: plainTextFromData(data),
            executionCount,
          });
          return;
        }

        if (msgType === 'error') {
          outputs.push({
            type: 'error',
            ename: typeof content.ename === 'string' ? content.ename : undefined,
            evalue:
              typeof content.evalue === 'string' ? content.evalue : undefined,
            traceback: parseTraceback(content.traceback),
          });
        }
        return;
      }

      if (channel === 'shell' && msgType === 'execute_reply') {
        executeReply = content;
        if (idleSeen) {
          finish();
        }
      }
    });
  });
}
