/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const JSON_RPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';
const DEFAULT_TOKEN_FILE = '~/.colab-agent-bridge.token';
const SERVER_NAME = 'colab-agent-bridge-mcp';
const SERVER_VERSION = '0.1.0';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

interface BridgeState {
  readonly endpoint?: string;
  readonly host: string;
  readonly port: number;
}

interface ToolDefinition {
  readonly name: string;
  readonly bridgeMethod?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface ToolCallResult {
  readonly content: readonly {
    readonly type: 'text';
    readonly text: string;
  }[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

const DEBUG = process.env.COLAB_AGENT_MCP_DEBUG?.trim() === '1';

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'colab_bridge_call',
    description:
      'Call any bridge method by name with params. Use when a dedicated tool is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description: 'Bridge method name, e.g. "runtimes.start".',
        },
        params: {
          type: 'object',
          description: 'Bridge method params object.',
        },
      },
      required: ['method'],
      additionalProperties: false,
    },
  },
  {
    name: 'colab_ping',
    bridgeMethod: 'ping',
    description: 'Bridge health ping.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'colab_bridge_capabilities',
    bridgeMethod: 'bridge.capabilities',
    description: 'List bridge capabilities and supported methods.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'colab_runtimes_list',
    bridgeMethod: 'runtimes.list',
    description: 'List runtimes from extension/external/all scopes.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: ['extension', 'external', 'all'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runtimes_options',
    bridgeMethod: 'runtimes.options',
    description: 'List account-eligible runtime descriptors.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'colab_runtimes_start',
    bridgeMethod: 'runtimes.start',
    description: 'Start/reuse runtime with optional descriptor.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['latestOrCreate', 'new'] },
        label: { type: 'string' },
        variant: { type: 'string', enum: ['DEFAULT', 'GPU', 'TPU'] },
        accelerator: { type: 'string' },
        shape: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        version: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runtimes_stop',
    bridgeMethod: 'runtimes.stop',
    description: 'Stop runtime by selector or all.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: ['extension', 'external', 'all'] },
        id: { type: 'string' },
        endpoint: { type: 'string' },
        label: { type: 'string' },
        all: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runtimes_status',
    bridgeMethod: 'runtimes.status',
    description: 'Get runtime status by selector.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: ['extension', 'external', 'all'] },
        id: { type: 'string' },
        endpoint: { type: 'string' },
        label: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_notebook_execute',
    bridgeMethod: 'notebook.execute',
    description: 'Execute one code snippet in runtime kernel.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        from: { type: 'string', enum: ['extension', 'all'] },
        id: { type: 'string' },
        endpoint: { type: 'string' },
        label: { type: 'string' },
        timeoutMs: { type: 'number' },
        kernelName: { type: 'string' },
        cleanupSession: { type: 'boolean' },
        outputMode: { type: 'string', enum: ['compact', 'raw'] },
        render: { type: 'string', enum: ['markdown', 'none'] },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'colab_notebook_run_all',
    bridgeMethod: 'notebook.runAll',
    description: 'Execute all code cells from local .ipynb.',
    inputSchema: {
      type: 'object',
      properties: {
        notebookPath: { type: 'string' },
        from: { type: 'string', enum: ['extension', 'all'] },
        id: { type: 'string' },
        endpoint: { type: 'string' },
        label: { type: 'string' },
        timeoutMsPerCell: { type: 'number' },
        stopOnError: { type: 'boolean' },
        kernelName: { type: 'string' },
        cleanupSession: { type: 'boolean' },
        saveCellsRuntimeDir: { type: 'string' },
        outputMode: { type: 'string', enum: ['compact', 'raw'] },
        render: { type: 'string', enum: ['markdown', 'none'] },
      },
      required: ['notebookPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runtime_files_write_text',
    bridgeMethod: 'runtime.files.writeText',
    description: 'Write text file into runtime filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        runtimePath: { type: 'string' },
        text: { type: 'string' },
        createDirectories: { type: 'boolean' },
        from: { type: 'string', enum: ['extension', 'all'] },
        id: { type: 'string' },
        endpoint: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['runtimePath', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runtime_secrets_sync',
    bridgeMethod: 'runtime.secrets.sync',
    description: 'Sync HF token and startup hooks into runtime.',
    inputSchema: {
      type: 'object',
      properties: {
        hfToken: { type: 'string' },
        HF_TOKEN: { type: 'string' },
        hfAccessToken: { type: 'string' },
        HF_ACCESS_TOKEN: { type: 'string' },
        from: { type: 'string', enum: ['extension', 'all'] },
        id: { type: 'string' },
        endpoint: { type: 'string' },
        label: { type: 'string' },
        writeIpythonStartup: { type: 'boolean' },
        writeHfHomeTokenFile: { type: 'boolean' },
        writeHfCacheTokenFile: { type: 'boolean' },
        verifyRuntimeEnv: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runs_start',
    bridgeMethod: 'runs.start',
    description: 'Start async job for notebook.execute or notebook.runAll.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['notebook.execute', 'notebook.runAll'],
        },
        args: { type: 'object' },
      },
      required: ['kind', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runs_status',
    bridgeMethod: 'runs.status',
    description: 'Get async run status and optional result.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        includeResult: { type: 'boolean' },
        outputMode: { type: 'string', enum: ['compact', 'raw'] },
        render: { type: 'string', enum: ['markdown', 'none'] },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runs_list',
    bridgeMethod: 'runs.list',
    description: 'List async runs by status with optional limit.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'colab_runs_cancel',
    bridgeMethod: 'runs.cancel',
    description: 'Request cancellation of an async run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

function logDebug(message: string): void {
  if (!DEBUG) {
    return;
  }
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
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

function randomRequestId(): string {
  return `${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string' || typeof value === 'number' || value === null) {
    return value;
  }
  return undefined;
}

function parseContentLength(headerBlock: string): number | undefined {
  const lines = headerBlock.split('\r\n');
  for (const line of lines) {
    const match = /^content-length\s*:\s*(\d+)$/i.exec(line.trim());
    if (!match) {
      continue;
    }
    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return value;
  }
  return undefined;
}

function truncateForMessage(value: string, max = 1200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}... [truncated]`;
}

function toolSuccessResult(result: unknown): ToolCallResult {
  const text = JSON.stringify(result, null, 2);
  const structured =
    isRecord(result) || Array.isArray(result) ? result : { value: result };
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

function toolErrorResult(message: string): ToolCallResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function writeJsonRpcMessage(message: JsonRpcResponse): void {
  const payload = JSON.stringify(message);
  const contentLength = Buffer.byteLength(payload, 'utf8');
  process.stdout.write(
    `Content-Length: ${contentLength.toString()}\r\n\r\n${payload}`,
  );
}

function sendResult(id: JsonRpcId, result: unknown): void {
  writeJsonRpcMessage({
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  });
}

function sendError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  writeJsonRpcMessage({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message, data },
  });
}

let cachedEndpoint: string | undefined;
let cachedToken: string | undefined;

async function resolveBridgeEndpoint(): Promise<string> {
  if (cachedEndpoint) {
    return cachedEndpoint;
  }
  const explicit = process.env.COLAB_AGENT_BRIDGE_ENDPOINT?.trim();
  if (explicit) {
    cachedEndpoint = explicit;
    return cachedEndpoint;
  }
  const stateFilePath = resolvePathWithHome(
    process.env.COLAB_AGENT_BRIDGE_STATE_FILE ?? DEFAULT_STATE_FILE,
  );
  const raw = await readFile(stateFilePath, 'utf8');
  const state = JSON.parse(raw) as BridgeState;
  if (state.endpoint && state.endpoint.trim().length > 0) {
    cachedEndpoint = state.endpoint.trim();
    return cachedEndpoint;
  }
  cachedEndpoint = `http://${state.host}:${state.port.toString()}/v1/colab-agent`;
  return cachedEndpoint;
}

async function resolveBridgeToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }
  const envToken = process.env.COLAB_AGENT_BRIDGE_TOKEN?.trim();
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }
  const tokenFilePath = resolvePathWithHome(
    process.env.COLAB_AGENT_BRIDGE_TOKEN_FILE ?? DEFAULT_TOKEN_FILE,
  );
  const token = (await readFile(tokenFilePath, 'utf8')).trim();
  if (!token) {
    throw new Error(
      `Bridge token is empty. Set COLAB_AGENT_BRIDGE_TOKEN or write token to ${tokenFilePath}.`,
    );
  }
  cachedToken = token;
  return cachedToken;
}

async function callBridgeMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = await resolveBridgeEndpoint();
  const token = await resolveBridgeToken();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: randomRequestId(),
      method,
      params,
    }),
  });

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText.length > 0 ? JSON.parse(responseText) : {};
  } catch (_error) {
    throw new Error(
      `Bridge returned non-JSON response (HTTP ${response.status.toString()}): ${truncateForMessage(
        responseText,
      )}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Bridge HTTP ${response.status.toString()} ${response.statusText}: ${truncateForMessage(
        JSON.stringify(payload),
      )}`,
    );
  }

  if (!isRecord(payload)) {
    throw new Error('Bridge response is not an object.');
  }

  if (payload.ok !== true) {
    const errorValue = payload.error;
    if (isRecord(errorValue)) {
      const code = typeof errorValue.code === 'string' ? errorValue.code : 'ERROR';
      const message =
        typeof errorValue.message === 'string'
          ? errorValue.message
          : 'Unknown bridge error.';
      throw new Error(`${code}: ${message}`);
    }
    throw new Error('Bridge call failed without structured error payload.');
  }

  return payload.result;
}

async function handleToolCall(
  toolName: string,
  argsValue: unknown,
): Promise<ToolCallResult> {
  const args =
    argsValue === undefined
      ? {}
      : isRecord(argsValue)
        ? argsValue
        : undefined;

  if (!args) {
    return toolErrorResult('Tool arguments must be an object.');
  }

  if (toolName === 'colab_bridge_call') {
    const method = args.method;
    if (typeof method !== 'string' || method.trim().length === 0) {
      return toolErrorResult(
        'colab_bridge_call requires non-empty string "method".',
      );
    }
    const params = isRecord(args.params) ? args.params : {};
    try {
      const result = await callBridgeMethod(method.trim(), params);
      return toolSuccessResult(result);
    } catch (error) {
      return toolErrorResult(
        error instanceof Error ? error.message : 'Unknown bridge call error.',
      );
    }
  }

  const tool = TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === toolName,
  );
  if (!tool) {
    return toolErrorResult(`Unknown tool "${toolName}".`);
  }
  if (!tool.bridgeMethod) {
    return toolErrorResult(`Tool "${toolName}" has no bridge method mapping.`);
  }

  try {
    const result = await callBridgeMethod(tool.bridgeMethod, args);
    return toolSuccessResult(result);
  } catch (error) {
    return toolErrorResult(
      error instanceof Error ? error.message : 'Unknown bridge call error.',
    );
  }
}

class StdioJsonRpcReader {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onParseError: (error: string) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headerBlock = this.buffer.subarray(0, headerEnd).toString('utf8');
      const contentLength = parseContentLength(headerBlock);
      if (contentLength === undefined) {
        this.buffer = Buffer.alloc(0);
        this.onParseError('Missing or invalid Content-Length header.');
        return;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.subarray(bodyEnd);

      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.onParseError(
          `Invalid JSON payload: ${error instanceof Error ? error.message : 'unknown parse error'}.`,
        );
        continue;
      }
      this.onMessage(message);
    }
  }
}

const queue: unknown[] = [];
let processingQueue = false;

function enqueueMessage(message: unknown): void {
  queue.push(message);
  if (processingQueue) {
    return;
  }
  processingQueue = true;
  void processQueue();
}

async function processQueue(): Promise<void> {
  try {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) {
        continue;
      }
      await handleIncomingMessage(next);
    }
  } finally {
    processingQueue = false;
  }
}

async function handleIncomingMessage(message: unknown): Promise<void> {
  if (!isRecord(message)) {
    sendError(null, -32600, 'Invalid Request: expected JSON object.');
    return;
  }

  const request = message as JsonRpcRequest;
  if (
    request.jsonrpc !== undefined &&
    request.jsonrpc !== JSON_RPC_VERSION
  ) {
    const badId = asJsonRpcId(request.id) ?? null;
    sendError(
      badId,
      -32600,
      `Invalid Request: jsonrpc must be "${JSON_RPC_VERSION}".`,
    );
    return;
  }

  const id = asJsonRpcId(request.id);
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const method = typeof request.method === 'string' ? request.method : undefined;
  if (!method) {
    if (hasId) {
      sendError(id ?? null, -32600, 'Invalid Request: missing method string.');
    }
    return;
  }

  if (!hasId) {
    handleNotification(method, request.params);
    return;
  }

  const requestId = id ?? null;
  await handleRequest(requestId, method, request.params);
}

function handleNotification(method: string, _params: unknown): void {
  if (
    method === 'notifications/initialized' ||
    method === 'initialized' ||
    method === '$/cancelRequest'
  ) {
    return;
  }
  logDebug(`Ignoring notification: ${method}`);
}

function toolsListResult(): { readonly tools: readonly unknown[] } {
  return {
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

async function handleRequest(
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<void> {
  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions:
          'MCP adapter for the local Colab agent bridge. Use tools to manage runtimes, execute notebooks, sync secrets, and control async runs.',
      });
      return;
    case 'tools/list':
      sendResult(id, toolsListResult());
      return;
    case 'tools/call': {
      if (!isRecord(params)) {
        sendError(id, -32602, 'Invalid params for tools/call.');
        return;
      }
      const name = params.name;
      const args = params.arguments;
      if (typeof name !== 'string' || name.trim().length === 0) {
        sendError(id, -32602, 'tools/call requires non-empty string "name".');
        return;
      }
      const result = await handleToolCall(name.trim(), args);
      sendResult(id, result);
      return;
    }
    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;
    case 'resources/list':
      sendResult(id, { resources: [] });
      return;
    case 'resources/templates/list':
      sendResult(id, { resourceTemplates: [] });
      return;
    case 'ping':
      sendResult(id, {});
      return;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function bootstrapDiagnostics(): void {
  const stateFile = resolvePathWithHome(
    process.env.COLAB_AGENT_BRIDGE_STATE_FILE ?? DEFAULT_STATE_FILE,
  );
  const tokenFromEnv = process.env.COLAB_AGENT_BRIDGE_TOKEN?.trim();
  const tokenSource =
    tokenFromEnv !== undefined && tokenFromEnv.length > 0
      ? 'env'
      : resolvePathWithHome(
          process.env.COLAB_AGENT_BRIDGE_TOKEN_FILE ?? DEFAULT_TOKEN_FILE,
        );
  logDebug(`stateFile=${stateFile}`);
  logDebug(`tokenSource=${tokenSource}`);
}

function main(): void {
  bootstrapDiagnostics();
  const reader = new StdioJsonRpcReader(
    enqueueMessage,
    (error) => {
      sendError(null, -32700, error);
    },
  );

  process.stdin.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    reader.push(buffer);
  });
  process.stdin.on('error', (error) => {
    process.stderr.write(
      `[${SERVER_NAME}] stdin error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
  process.stdin.on('end', () => {
    logDebug('stdin ended');
  });
  process.stdin.resume();
}

main();
