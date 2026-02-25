/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Shape, Variant } from '../api';

export type AgentRuntimeScope = 'extension' | 'external' | 'all';
export type AgentStartMode = 'latestOrCreate' | 'new';

export interface AgentRuntimeSelection {
  readonly id?: string;
  readonly endpoint?: string;
  readonly label?: string;
  readonly all?: boolean;
}

export interface AgentRuntimeRecord {
  readonly owner: 'extension' | 'external';
  readonly id?: string;
  readonly label: string;
  readonly endpoint: string;
  readonly variant: Variant;
  readonly accelerator?: string;
  readonly shape?: Shape;
  readonly version?: string;
  readonly dateAssigned?: string;
  readonly baseUrl?: string;
  readonly tokenExpiry?: string;
}

export interface AgentListRuntimesArgs {
  readonly from?: AgentRuntimeScope;
}

export interface AgentListRuntimesResult {
  readonly scope: AgentRuntimeScope;
  readonly assigned: readonly AgentRuntimeRecord[];
  readonly unowned: readonly AgentRuntimeRecord[];
  readonly counts: {
    readonly assigned: number;
    readonly unowned: number;
    readonly total: number;
  };
}

export interface AgentRuntimeOptionRecord {
  readonly label: string;
  readonly variant: Variant;
  readonly accelerator?: string;
  readonly shape?: Shape;
  readonly version?: string;
}

export interface AgentRuntimeOptionsArgs {}

export interface AgentRuntimeOptionsResult {
  readonly options: readonly AgentRuntimeOptionRecord[];
  readonly counts: {
    readonly total: number;
    readonly byVariant: {
      readonly DEFAULT: number;
      readonly GPU: number;
      readonly TPU: number;
    };
  };
}

export interface AgentStartRuntimeArgs {
  readonly mode?: AgentStartMode | string;
  readonly label?: string;
  readonly variant?: Variant | string;
  readonly accelerator?: string;
  readonly shape?: Shape | number | string;
  readonly version?: string;
}

export interface AgentStartRuntimeResult {
  readonly mode: AgentStartMode;
  readonly action: 'reused' | 'created';
  readonly runtime: AgentRuntimeRecord;
}

export interface AgentStopRuntimeArgs extends AgentRuntimeSelection {
  readonly from?: AgentRuntimeScope;
}

export interface AgentStopRuntimeResult {
  readonly scope: AgentRuntimeScope;
  readonly requested: {
    readonly id?: string;
    readonly endpoint?: string;
    readonly label?: string;
    readonly all: boolean;
  };
  readonly stopped: readonly AgentRuntimeRecord[];
  readonly failed: readonly { target: AgentRuntimeRecord; error: string }[];
  readonly notFound: boolean;
}

export interface AgentRuntimeStatusArgs extends AgentRuntimeSelection {
  readonly from?: AgentRuntimeScope;
}

export interface AgentRuntimeStatusResult {
  readonly scope: AgentRuntimeScope;
  readonly available: AgentListRuntimesResult;
  readonly selected: readonly AgentRuntimeRecord[];
  readonly latestAssigned?: AgentRuntimeRecord;
  readonly ambiguousLabelSelection: boolean;
}

export interface NotebookRuntimeSelectionArgs {
  readonly from?: AgentRuntimeScope;
  readonly id?: string;
  readonly endpoint?: string;
  readonly label?: string;
}

export interface NotebookExecuteArgs extends NotebookRuntimeSelectionArgs {
  readonly code: string;
  readonly timeoutMs?: number;
  readonly kernelName?: string;
  readonly cleanupSession?: boolean;
}

export interface NotebookRunAllArgs extends NotebookRuntimeSelectionArgs {
  readonly notebookPath: string;
  readonly timeoutMsPerCell?: number;
  readonly stopOnError?: boolean;
  readonly kernelName?: string;
  readonly cleanupSession?: boolean;
  readonly saveCellsRuntimeDir?: string;
}

export interface RuntimeFilesWriteTextArgs extends NotebookRuntimeSelectionArgs {
  readonly runtimePath: string;
  readonly text: string;
  readonly createDirectories?: boolean;
}

export interface RuntimeSecretsSyncArgs extends NotebookRuntimeSelectionArgs {
  readonly hfToken: string;
  readonly writeIpythonStartup?: boolean;
  readonly writeHfHomeTokenFile?: boolean;
  readonly writeHfCacheTokenFile?: boolean;
  readonly verifyRuntimeEnv?: boolean;
}

export interface NotebookExecutionOutput {
  readonly type: 'stream' | 'execute_result' | 'display_data' | 'error';
  readonly text?: string;
  readonly name?: string;
  readonly data?: Record<string, unknown>;
  readonly executionCount?: number;
  readonly ename?: string;
  readonly evalue?: string;
  readonly traceback?: readonly string[];
}

export interface NotebookExecuteResult {
  readonly runtime: AgentRuntimeRecord;
  readonly sessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly status: 'ok' | 'error';
  readonly outputs: readonly NotebookExecutionOutput[];
  readonly reply: Record<string, unknown>;
  readonly elapsedMs: number;
  readonly cleanedUpSession: boolean;
}

export interface NotebookRunCellResult {
  readonly cellIndex: number;
  readonly executionIndex: number;
  readonly status: 'ok' | 'error';
  readonly elapsedMs: number;
  readonly sourcePreview: string;
  readonly outputs: readonly NotebookExecutionOutput[];
  readonly reply: Record<string, unknown>;
  readonly runtimeSavePath?: string;
  readonly runtimeSaveStatus?: 'saved' | 'failed';
  readonly runtimeSaveError?: string;
}

export interface NotebookRunAllResult {
  readonly runtime: AgentRuntimeRecord;
  readonly notebookPath: string;
  readonly sessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly status: 'ok' | 'error';
  readonly totalCodeCells: number;
  readonly executedCells: number;
  readonly failedCells: number;
  readonly stoppedOnError: boolean;
  readonly elapsedMs: number;
  readonly cleanedUpSession: boolean;
  readonly saveCellsRuntimeDir?: string;
  readonly cells: readonly NotebookRunCellResult[];
}

export interface RuntimeFilesWriteTextResult {
  readonly runtime: AgentRuntimeRecord;
  readonly runtimePath: string;
  readonly bytes: number;
}

export interface RuntimeSecretsSyncResult {
  readonly runtime: AgentRuntimeRecord;
  readonly wrotePaths: readonly string[];
  readonly verifyRuntimeEnv: boolean;
  readonly hfTokenVisibleInNewKernel?: boolean;
}

export type AgentRunKind = 'notebook.execute' | 'notebook.runAll';
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface AgentRunStartArgs {
  readonly kind: AgentRunKind;
  readonly notebookExecuteArgs?: NotebookExecuteArgs;
  readonly notebookRunAllArgs?: NotebookRunAllArgs;
}

export interface AgentRunStartResult {
  readonly runId: string;
  readonly kind: AgentRunKind;
  readonly status: AgentRunStatus;
  readonly createdAt: string;
  readonly cancelRequested: boolean;
}

export interface AgentRunStatusArgs {
  readonly runId: string;
}

export interface AgentRunProgress {
  readonly executedCells: number;
  readonly failedCells: number;
  readonly totalCodeCells?: number;
  readonly lastCellIndex?: number;
  readonly updatedAt: string;
}

export interface AgentRunStatusResult {
  readonly runId: string;
  readonly kind: AgentRunKind;
  readonly status: AgentRunStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly cancelRequested: boolean;
  readonly progress?: AgentRunProgress;
  readonly error?: string;
  readonly result?: NotebookExecuteResult | NotebookRunAllResult;
}

export interface AgentRunListArgs {
  readonly limit?: number;
  readonly status?: AgentRunStatus;
}

export interface AgentRunListResult {
  readonly runs: readonly Omit<AgentRunStatusResult, 'result'>[];
  readonly count: number;
}

export interface AgentRunCancelArgs {
  readonly runId: string;
}

export interface AgentRunCancelResult {
  readonly runId: string;
  readonly cancelRequested: boolean;
  readonly status: AgentRunStatus;
}
