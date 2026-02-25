/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { AssignmentManager } from '../../jupyter/assignments';
import { DEFAULT_NOTEBOOK_EXECUTION_TIMEOUT_MS } from './constants';
import {
  AgentListRuntimesArgs,
  AgentListRuntimesResult,
  AgentRunCancelArgs,
  AgentRunCancelResult,
  AgentRunKind,
  AgentRunListArgs,
  AgentRunListResult,
  AgentRuntimeOptionsArgs,
  AgentRuntimeOptionsResult,
  AgentRunStartArgs,
  AgentRunStartResult,
  AgentRunStatus,
  AgentRunStatusArgs,
  AgentRunStatusResult,
  AgentRuntimeStatusArgs,
  AgentRuntimeStatusResult,
  AgentStartRuntimeArgs,
  AgentStartRuntimeResult,
  AgentStopRuntimeArgs,
  AgentStopRuntimeResult,
  NotebookExecuteArgs,
  NotebookExecuteResult,
  NotebookRunAllArgs,
  NotebookRunAllResult,
  RuntimeFilesWriteTextArgs,
  RuntimeFilesWriteTextResult,
  RuntimeSecretsSyncArgs,
  RuntimeSecretsSyncResult,
} from './types';
import {
  listRuntimes,
  listRuntimeOptions,
  runtimeStatus,
  startRuntime,
  stopRuntime,
} from './runtime-lifecycle';
import {
  notebookExecute,
  notebookRunAll,
  NotebookExecutionOptions,
} from './execution/notebook-execution';
import { runtimeFilesWriteText } from './runtime-ops';
import { runtimeSecretsSync } from './secrets-sync';
import { validateTimeoutMs } from './validation';

interface AgentRunInternal {
  runId: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested: boolean;
  progress?: AgentRunStatusResult['progress'];
  error?: string;
  result?: AgentRunStatusResult['result'];
  controller?: AbortController;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export class AgentRuntimeService {
  private static readonly DEFAULT_RUN_LIST_LIMIT = 20;
  private static readonly MAX_RUN_LIST_LIMIT = 200;
  private static readonly MAX_TERMINAL_RUN_HISTORY = 200;
  private readonly runs = new Map<string, AgentRunInternal>();
  private readonly runOrder: string[] = [];

  constructor(private readonly assignmentManager: AssignmentManager) {}

  async listRuntimes(
    args: AgentListRuntimesArgs = {},
  ): Promise<AgentListRuntimesResult> {
    return await listRuntimes(this.assignmentManager, args);
  }

  async listRuntimeOptions(
    args: AgentRuntimeOptionsArgs = {},
  ): Promise<AgentRuntimeOptionsResult> {
    return await listRuntimeOptions(this.assignmentManager, args);
  }

  async startRuntime(
    args: AgentStartRuntimeArgs = {},
  ): Promise<AgentStartRuntimeResult> {
    return await startRuntime(this.assignmentManager, args);
  }

  async stopRuntime(
    args: AgentStopRuntimeArgs = {},
  ): Promise<AgentStopRuntimeResult> {
    return await stopRuntime(this.assignmentManager, args);
  }

  async runtimeStatus(
    args: AgentRuntimeStatusArgs = {},
  ): Promise<AgentRuntimeStatusResult> {
    return await runtimeStatus(this.assignmentManager, args);
  }

  async notebookExecute(
    rawArgs: NotebookExecuteArgs,
    options: NotebookExecutionOptions = {},
  ): Promise<NotebookExecuteResult> {
    return await notebookExecute(this.assignmentManager, rawArgs, options);
  }

  async notebookRunAll(
    rawArgs: NotebookRunAllArgs,
    options: NotebookExecutionOptions = {},
  ): Promise<NotebookRunAllResult> {
    return await notebookRunAll(this.assignmentManager, rawArgs, options);
  }

  async runtimeFilesWriteText(
    rawArgs: RuntimeFilesWriteTextArgs,
  ): Promise<RuntimeFilesWriteTextResult> {
    return await runtimeFilesWriteText(this.assignmentManager, rawArgs);
  }

  async runtimeSecretsSync(
    rawArgs: RuntimeSecretsSyncArgs,
  ): Promise<RuntimeSecretsSyncResult> {
    return await runtimeSecretsSync(this.assignmentManager, rawArgs);
  }

  async startRun(args: AgentRunStartArgs): Promise<AgentRunStartResult> {
    if (args.kind === 'notebook.execute' && !args.notebookExecuteArgs) {
      throw new Error('runs.start kind=notebook.execute requires execute args.');
    }
    if (args.kind === 'notebook.runAll' && !args.notebookRunAllArgs) {
      throw new Error('runs.start kind=notebook.runAll requires runAll args.');
    }

    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    const run: AgentRunInternal = {
      runId,
      kind: args.kind,
      status: 'queued',
      createdAt,
      cancelRequested: false,
      controller: new AbortController(),
    };
    this.runs.set(runId, run);
    this.runOrder.push(runId);
    this.pruneRunHistory();

    void this.executeRun(runId, args);

    return {
      runId,
      kind: run.kind,
      status: run.status,
      createdAt: run.createdAt,
      cancelRequested: run.cancelRequested,
    };
  }

  async runStatus(args: AgentRunStatusArgs): Promise<AgentRunStatusResult> {
    const run = this.runs.get(args.runId);
    if (!run) {
      throw new Error(`Run "${args.runId}" was not found.`);
    }
    return this.toRunStatusResult(run);
  }

  async listRuns(args: AgentRunListArgs = {}): Promise<AgentRunListResult> {
    const limit = this.normalizeRunListLimit(args.limit);
    const matchingRuns = [...this.runOrder]
      .reverse()
      .map((runId) => this.runs.get(runId))
      .filter((run): run is AgentRunInternal => run !== undefined)
      .filter((run) => (args.status ? run.status === args.status : true))
      .slice(0, limit)
      .map((run) => this.toRunSummary(run));

    return {
      runs: matchingRuns,
      count: matchingRuns.length,
    };
  }

  async cancelRun(args: AgentRunCancelArgs): Promise<AgentRunCancelResult> {
    const run = this.runs.get(args.runId);
    if (!run) {
      throw new Error(`Run "${args.runId}" was not found.`);
    }
    if (isTerminalRunStatus(run.status)) {
      return {
        runId: run.runId,
        cancelRequested: run.cancelRequested,
        status: run.status,
      };
    }

    run.cancelRequested = true;
    if (run.status === 'queued') {
      run.status = 'canceled';
      run.finishedAt = new Date().toISOString();
      run.error = 'Run canceled before execution started.';
    }
    run.controller?.abort();

    return {
      runId: run.runId,
      cancelRequested: run.cancelRequested,
      status: run.status,
    };
  }

  private async executeRun(runId: string, args: AgentRunStartArgs): Promise<void> {
    await Promise.resolve();

    const run = this.runs.get(runId);
    if (!run || run.status === 'canceled') {
      return;
    }

    run.status = 'running';
    run.startedAt = new Date().toISOString();

    try {
      switch (args.kind) {
        case 'notebook.execute':
          run.result = await this.notebookExecute(args.notebookExecuteArgs!, {
            signal: run.controller?.signal,
          });
          break;
        case 'notebook.runAll':
          run.result = await this.notebookRunAll(args.notebookRunAllArgs!, {
            signal: run.controller?.signal,
            onRunAllCellComplete: (event) => {
              const activeRun = this.runs.get(runId);
              if (!activeRun) {
                return;
              }
              activeRun.progress = {
                executedCells: event.executedCells,
                failedCells: event.failedCells,
                totalCodeCells: event.totalCodeCells,
                lastCellIndex: event.lastCellIndex,
                updatedAt: new Date().toISOString(),
              };
            },
          });
          break;
      }

      if (run.cancelRequested || run.controller?.signal.aborted) {
        run.status = 'canceled';
        run.error ??= 'Run canceled.';
      } else {
        run.status = 'succeeded';
      }
    } catch (error) {
      if (run.cancelRequested || run.controller?.signal.aborted || isAbortError(error)) {
        run.status = 'canceled';
        run.error ??= 'Run canceled.';
      } else {
        run.status = 'failed';
        run.error = formatError(error);
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      run.controller = undefined;
      this.pruneRunHistory();
    }
  }

  private toRunSummary(run: AgentRunInternal): Omit<AgentRunStatusResult, 'result'> {
    return {
      runId: run.runId,
      kind: run.kind,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      cancelRequested: run.cancelRequested,
      progress: run.progress,
      error: run.error,
    };
  }

  private toRunStatusResult(run: AgentRunInternal): AgentRunStatusResult {
    return {
      ...this.toRunSummary(run),
      result: run.result,
    };
  }

  private normalizeRunListLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return AgentRuntimeService.DEFAULT_RUN_LIST_LIMIT;
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > AgentRuntimeService.MAX_RUN_LIST_LIMIT
    ) {
      throw new Error(
        `limit must be an integer in the range 1..${AgentRuntimeService.MAX_RUN_LIST_LIMIT.toString()}.`,
      );
    }
    return limit;
  }

  private pruneRunHistory(): void {
    const terminalRunIds = this.runOrder.filter((runId) => {
      const run = this.runs.get(runId);
      return run ? isTerminalRunStatus(run.status) : false;
    });
    const overflow =
      terminalRunIds.length - AgentRuntimeService.MAX_TERMINAL_RUN_HISTORY;
    if (overflow <= 0) {
      return;
    }

    const removeSet = new Set(terminalRunIds.slice(0, overflow));
    for (const runId of removeSet) {
      const run = this.runs.get(runId);
      if (run && isTerminalRunStatus(run.status)) {
        this.runs.delete(runId);
      }
    }
    const retained = this.runOrder.filter((runId) => !removeSet.has(runId));
    this.runOrder.length = 0;
    this.runOrder.push(...retained);
  }

  static validateTimeoutMs(value: number | undefined, fieldName: string): number {
    return validateTimeoutMs(
      value,
      fieldName,
      DEFAULT_NOTEBOOK_EXECUTION_TIMEOUT_MS,
    );
  }
}
