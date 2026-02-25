/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssignmentManager } from '../jupyter/assignments';
import { Shape, Variant } from './api';
import {
  AgentBridgeOutputMode,
  AgentBridgeRenderMode,
  formatNotebookExecuteResult,
  formatNotebookRunAllResult,
} from './agent-bridge-format';
import {
  AgentListRuntimesArgs,
  AgentRunCancelArgs,
  AgentRunListArgs,
  AgentRunStartArgs,
  AgentRunStatusArgs,
  AgentRuntimeOptionsArgs,
  AgentRuntimeScope,
  AgentRuntimeService,
  AgentRuntimeStatusArgs,
  AgentStartMode,
  AgentStartRuntimeArgs,
  AgentStopRuntimeArgs,
  NotebookExecuteResult,
  NotebookExecuteArgs,
  NotebookRunAllResult,
  NotebookRunAllArgs,
  RuntimeFilesWriteTextArgs,
  RuntimeSecretsSyncArgs,
} from './agent-runtime-service';

export type AgentBridgeMethod =
  | 'ping'
  | 'bridge.capabilities'
  | 'runtimes.list'
  | 'runtimes.options'
  | 'runtimes.start'
  | 'runtimes.stop'
  | 'runtimes.status'
  | 'runs.start'
  | 'runs.status'
  | 'runs.list'
  | 'runs.cancel'
  | 'notebook.execute'
  | 'notebook.runAll'
  | 'runtime.files.writeText'
  | 'runtime.secrets.sync';

export type AgentBridgeErrorCode =
  | 'INVALID_PARAMS'
  | 'UNSUPPORTED_METHOD';

const SUPPORTED_METHODS: readonly AgentBridgeMethod[] = [
  'ping',
  'bridge.capabilities',
  'runtimes.list',
  'runtimes.options',
  'runtimes.start',
  'runtimes.stop',
  'runtimes.status',
  'runs.start',
  'runs.status',
  'runs.list',
  'runs.cancel',
  'notebook.execute',
  'notebook.runAll',
  'runtime.files.writeText',
  'runtime.secrets.sync',
];

interface BridgeCapabilitiesResult {
  readonly bridgeVersion: 1;
  readonly methods: readonly AgentBridgeMethod[];
  readonly notes: readonly string[];
}

export interface AgentBridgeRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export class AgentBridgeError extends Error {
  constructor(
    readonly code: AgentBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentBridgeError';
  }
}

const runtimeServiceCache = new WeakMap<AssignmentManager, AgentRuntimeService>();

function getRuntimeService(assignmentManager: AssignmentManager): AgentRuntimeService {
  const existing = runtimeServiceCache.get(assignmentManager);
  if (existing) {
    return existing;
  }
  const created = new AgentRuntimeService(assignmentManager);
  runtimeServiceCache.set(assignmentManager, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): AgentBridgeError {
  return new AgentBridgeError('INVALID_PARAMS', message);
}

function parseParams(params: unknown): Record<string, unknown> {
  if (params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    throw invalidParams('Request "params" must be an object.');
  }
  return params;
}

function parseOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidParams(`Invalid "${fieldName}" value. Expected a string.`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getOptionalBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw invalidParams('Expected a boolean value.');
  }
  return value;
}

function parseStartMode(value: unknown): AgentStartMode | undefined {
  const mode = parseOptionalString(value, 'mode');
  if (!mode) {
    return undefined;
  }
  if (mode === 'latestOrCreate' || mode === 'new') {
    return mode;
  }
  throw invalidParams('Invalid "mode" value. Use "latestOrCreate" or "new".');
}

function parseVariant(value: unknown): Variant | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
  }
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case Variant.DEFAULT:
    case Variant.GPU:
    case Variant.TPU:
      return normalized;
    default:
      throw invalidParams('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
  }
}

function parseShape(value: unknown): Shape | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    if (value === Shape.STANDARD || value === Shape.HIGHMEM) {
      return value;
    }
    throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }

  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case 'STANDARD':
    case '0':
      return Shape.STANDARD;
    case 'HIGHMEM':
    case '1':
      return Shape.HIGHMEM;
    default:
      throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }
}

function parseTimeoutMs(value: unknown, fieldName = 'timeoutMs'): number {
  if (value === undefined) {
    return AgentRuntimeService.validateTimeoutMs(undefined, fieldName);
  }
  if (typeof value !== 'number') {
    throw invalidParams(`${fieldName} must be an integer.`);
  }
  return AgentRuntimeService.validateTimeoutMs(value, fieldName);
}

function parseOutputMode(value: unknown): AgentBridgeOutputMode {
  if (value === undefined) {
    return 'compact';
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "outputMode" value. Use "compact" or "raw".');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'compact' || normalized === 'raw') {
    return normalized;
  }
  throw invalidParams('Invalid "outputMode" value. Use "compact" or "raw".');
}

function parseRenderMode(value: unknown): AgentBridgeRenderMode {
  if (value === undefined) {
    return 'markdown';
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "render" value. Use "none" or "markdown".');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'markdown') {
    return normalized;
  }
  throw invalidParams('Invalid "render" value. Use "none" or "markdown".');
}

function parseRuntimeScope(value: unknown): AgentRuntimeScope | undefined {
  const from = parseOptionalString(value, 'from');
  if (from === undefined) {
    return undefined;
  }
  if (from === 'extension' || from === 'external' || from === 'all') {
    return from;
  }
  throw invalidParams('Invalid "from" value. Use extension, external, or all.');
}

function parseRunKind(value: unknown): AgentRunStartArgs['kind'] {
  const kind = parseOptionalString(value, 'kind');
  if (!kind) {
    throw invalidParams(
      'runs.start requires "kind" as "notebook.execute" or "notebook.runAll".',
    );
  }
  if (kind === 'notebook.execute' || kind === 'notebook.runAll') {
    return kind;
  }
  throw invalidParams(
    'Invalid "kind" value. Use "notebook.execute" or "notebook.runAll".',
  );
}

function parseRunStatusFilter(value: unknown): AgentRunListArgs['status'] {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidParams(
      'Invalid "status" value. Use queued, running, succeeded, failed, or canceled.',
    );
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'queued':
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'canceled':
      return normalized;
    default:
      throw invalidParams(
        'Invalid "status" value. Use queued, running, succeeded, failed, or canceled.',
      );
  }
}

function parseOptionalInteger(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidParams(`${fieldName} must be an integer.`);
  }
  return value;
}

function toListRuntimesArgs(
  params: Record<string, unknown>,
): AgentListRuntimesArgs {
  return {
    from: parseRuntimeScope(params.from),
  };
}

function toRuntimeOptionsArgs(
  _params: Record<string, unknown>,
): AgentRuntimeOptionsArgs {
  return {};
}

function toStartRuntimeArgs(
  params: Record<string, unknown>,
): AgentStartRuntimeArgs {
  return {
    mode: parseStartMode(params.mode),
    label: parseOptionalString(params.label, 'label'),
    variant: parseVariant(params.variant),
    accelerator: parseOptionalString(params.accelerator, 'accelerator'),
    shape: parseShape(params.shape),
    version: parseOptionalString(params.version, 'version'),
  };
}

function toStopRuntimeArgs(
  params: Record<string, unknown>,
): AgentStopRuntimeArgs {
  return {
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    all: getOptionalBoolean(params.all, false),
  };
}

function toRuntimeStatusArgs(
  params: Record<string, unknown>,
): AgentRuntimeStatusArgs {
  return {
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    all: getOptionalBoolean(params.all, false),
  };
}

function toRunStartArgs(params: Record<string, unknown>): AgentRunStartArgs {
  const kind = parseRunKind(params.kind);
  const rawArgs = params.args;
  if (!isRecord(rawArgs)) {
    throw invalidParams('runs.start requires "args" as an object.');
  }

  if (kind === 'notebook.execute') {
    return {
      kind,
      notebookExecuteArgs: toNotebookExecuteArgs(rawArgs).args,
    };
  }
  return {
    kind,
    notebookRunAllArgs: toNotebookRunAllArgs(rawArgs).args,
  };
}

function toRunStatusArgs(params: Record<string, unknown>): AgentRunStatusArgs {
  const runId = parseOptionalString(params.runId, 'runId');
  if (!runId) {
    throw invalidParams('runs.status requires a non-empty "runId" string.');
  }
  return { runId };
}

function toRunListArgs(params: Record<string, unknown>): AgentRunListArgs {
  return {
    limit: parseOptionalInteger(params.limit, 'limit'),
    status: parseRunStatusFilter(params.status),
  };
}

function toRunCancelArgs(params: Record<string, unknown>): AgentRunCancelArgs {
  const runId = parseOptionalString(params.runId, 'runId');
  if (!runId) {
    throw invalidParams('runs.cancel requires a non-empty "runId" string.');
  }
  return { runId };
}

function toNotebookExecuteArgs(
  params: Record<string, unknown>,
): {
  readonly args: NotebookExecuteArgs;
  readonly outputMode: AgentBridgeOutputMode;
  readonly render: AgentBridgeRenderMode;
} {
  const code = params.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw invalidParams('notebook.execute requires a non-empty "code" string.');
  }

  return {
    args: {
      code,
      from: parseRuntimeScope(params.from),
      id: parseOptionalString(params.id, 'id'),
      endpoint: parseOptionalString(params.endpoint, 'endpoint'),
      label: parseOptionalString(params.label, 'label'),
      timeoutMs: parseTimeoutMs(params.timeoutMs, 'timeoutMs'),
      kernelName: parseOptionalString(params.kernelName, 'kernelName'),
      cleanupSession: getOptionalBoolean(params.cleanupSession, true),
    },
    outputMode: parseOutputMode(params.outputMode),
    render: parseRenderMode(params.render),
  };
}

function toNotebookRunAllArgs(
  params: Record<string, unknown>,
): {
  readonly args: NotebookRunAllArgs;
  readonly outputMode: AgentBridgeOutputMode;
  readonly render: AgentBridgeRenderMode;
} {
  const notebookPath = parseOptionalString(params.notebookPath, 'notebookPath');
  if (!notebookPath) {
    throw invalidParams(
      'notebook.runAll requires a non-empty "notebookPath" string.',
    );
  }
  if (params.saveResultPath !== undefined) {
    throw invalidParams(
      'notebook.runAll does not support "saveResultPath". Save results in the client process.',
    );
  }

  return {
    args: {
      notebookPath,
      from: parseRuntimeScope(params.from),
      id: parseOptionalString(params.id, 'id'),
      endpoint: parseOptionalString(params.endpoint, 'endpoint'),
      label: parseOptionalString(params.label, 'label'),
      timeoutMsPerCell: parseTimeoutMs(params.timeoutMsPerCell, 'timeoutMsPerCell'),
      stopOnError: getOptionalBoolean(params.stopOnError, true),
      kernelName: parseOptionalString(params.kernelName, 'kernelName'),
      cleanupSession: getOptionalBoolean(params.cleanupSession, true),
      saveCellsRuntimeDir: parseOptionalString(
        params.saveCellsRuntimeDir,
        'saveCellsRuntimeDir',
      ),
    },
    outputMode: parseOutputMode(params.outputMode),
    render: parseRenderMode(params.render),
  };
}

function toRuntimeFilesWriteTextArgs(
  params: Record<string, unknown>,
): RuntimeFilesWriteTextArgs {
  const runtimePath = parseOptionalString(params.runtimePath, 'runtimePath');
  if (!runtimePath) {
    throw invalidParams(
      'runtime.files.writeText requires a non-empty "runtimePath" string.',
    );
  }

  const text = params.text;
  if (typeof text !== 'string') {
    throw invalidParams('runtime.files.writeText requires a "text" string.');
  }

  return {
    runtimePath,
    text,
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    createDirectories: getOptionalBoolean(params.createDirectories, true),
  };
}

function toRuntimeSecretsSyncArgs(
  params: Record<string, unknown>,
): RuntimeSecretsSyncArgs {
  const tokenCandidates = [
    params.hfToken,
    params.HF_TOKEN,
    params.hfAccessToken,
    params.HF_ACCESS_TOKEN,
  ];
  const hfToken = tokenCandidates.find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  if (!hfToken) {
    throw invalidParams(
      'runtime.secrets.sync requires a non-empty "hfToken" string (or HF_TOKEN/HF_ACCESS_TOKEN).',
    );
  }

  return {
    hfToken: hfToken.trim(),
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    writeIpythonStartup: getOptionalBoolean(params.writeIpythonStartup, true),
    writeHfHomeTokenFile: getOptionalBoolean(params.writeHfHomeTokenFile, true),
    writeHfCacheTokenFile: getOptionalBoolean(params.writeHfCacheTokenFile, true),
    verifyRuntimeEnv: getOptionalBoolean(params.verifyRuntimeEnv, true),
  };
}

function bridgeCapabilities(): BridgeCapabilitiesResult {
  return {
    bridgeVersion: 1,
    methods: SUPPORTED_METHODS,
    notes: [
      'Use runtimes.options to inspect account-eligible runtime descriptors before starting a runtime.',
      'Use runs.start/runs.status/runs.list/runs.cancel for async notebook jobs.',
      'Execution methods reuse extension-assigned runtimes and run headless.',
      'Execution defaults to outputMode=compact with render=markdown for agent readability.',
      'Use notebook.runAll to execute an .ipynb end-to-end in one API call.',
      'runtime.files.writeText can target /content/drive/... when Drive is mounted.',
      'runtime.secrets.sync stores HF token in runtime files and startup hooks without echoing the token.',
    ],
  };
}

function formatRunResult(
  kind: AgentRunStartArgs['kind'],
  result: unknown,
  outputMode: AgentBridgeOutputMode,
  render: AgentBridgeRenderMode,
): unknown {
  if (!result) {
    return result;
  }
  if (kind === 'notebook.execute') {
    return formatNotebookExecuteResult(
      result as NotebookExecuteResult,
      outputMode,
      render,
    );
  }
  return formatNotebookRunAllResult(result as NotebookRunAllResult, outputMode, render);
}

export async function dispatchAgentBridgeRequest(
  assignmentManager: AssignmentManager,
  request: AgentBridgeRequest,
): Promise<unknown> {
  const method = request.method as AgentBridgeMethod;
  const params = parseParams(request.params);
  const runtimeService = getRuntimeService(assignmentManager);

  switch (method) {
    case 'ping':
      return {
        status: 'ok',
        now: new Date().toISOString(),
      };
    case 'bridge.capabilities':
      return bridgeCapabilities();
    case 'runtimes.list':
      return await runtimeService.listRuntimes(toListRuntimesArgs(params));
    case 'runtimes.options':
      return await runtimeService.listRuntimeOptions(
        toRuntimeOptionsArgs(params),
      );
    case 'runtimes.start':
      return await runtimeService.startRuntime(toStartRuntimeArgs(params));
    case 'runtimes.stop':
      return await runtimeService.stopRuntime(toStopRuntimeArgs(params));
    case 'runtimes.status':
      return await runtimeService.runtimeStatus(toRuntimeStatusArgs(params));
    case 'runs.start':
      return await runtimeService.startRun(toRunStartArgs(params));
    case 'runs.list':
      return await runtimeService.listRuns(toRunListArgs(params));
    case 'runs.cancel':
      return await runtimeService.cancelRun(toRunCancelArgs(params));
    case 'runs.status': {
      const runStatus = await runtimeService.runStatus(toRunStatusArgs(params));
      const includeResult = getOptionalBoolean(params.includeResult, true);
      if (!includeResult || runStatus.result === undefined) {
        return {
          ...runStatus,
          result: undefined,
        };
      }
      const outputMode = parseOutputMode(params.outputMode);
      const render = parseRenderMode(params.render);
      return {
        ...runStatus,
        result: formatRunResult(runStatus.kind, runStatus.result, outputMode, render),
      };
    }
    case 'notebook.execute': {
      const requestArgs = toNotebookExecuteArgs(params);
      const raw = await runtimeService.notebookExecute(requestArgs.args);
      return formatNotebookExecuteResult(
        raw,
        requestArgs.outputMode,
        requestArgs.render,
      );
    }
    case 'notebook.runAll': {
      const requestArgs = toNotebookRunAllArgs(params);
      const raw = await runtimeService.notebookRunAll(requestArgs.args);
      return formatNotebookRunAllResult(
        raw,
        requestArgs.outputMode,
        requestArgs.render,
      );
    }
    case 'runtime.files.writeText':
      return await runtimeService.runtimeFilesWriteText(
        toRuntimeFilesWriteTextArgs(params),
      );
    case 'runtime.secrets.sync':
      return await runtimeService.runtimeSecretsSync(
        toRuntimeSecretsSyncArgs(params),
      );
    default:
      throw new AgentBridgeError(
        'UNSUPPORTED_METHOD',
        `Unsupported method "${request.method}".`,
      );
  }
}
