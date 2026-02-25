/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { AssignmentManager } from '../../../jupyter/assignments';
import { ProxiedJupyterClient } from '../../../jupyter/client';
import { log } from '../../../common/logging';
import { DEFAULT_NOTEBOOK_EXECUTION_TIMEOUT_MS } from '../constants';
import {
  NotebookExecuteArgs,
  NotebookExecuteResult,
  NotebookRunAllArgs,
  NotebookRunAllResult,
  NotebookRunCellResult,
} from '../types';
import {
  selectExecutionServer,
  toRuntimeRecord,
} from '../runtime-selection';
import { ensureFreshRuntimeConnection } from '../runtime-connection';
import {
  executeCodeOnKernel,
  makeSessionName,
  resolveKernelName,
} from './kernel-channel';
import {
  loadNotebookCodeCells,
  sourcePreview,
} from './notebook-io';
import {
  ensureRuntimeDirectory,
  normalizeRuntimePath,
  writeTextFileToRuntime,
} from '../runtime-files';

export interface NotebookRunAllProgressEvent {
  readonly executedCells: number;
  readonly failedCells: number;
  readonly totalCodeCells: number;
  readonly lastCellIndex: number;
}

export interface NotebookExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onRunAllCellComplete?: (
    event: NotebookRunAllProgressEvent,
  ) => void;
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  methodName: string,
): void {
  if (signal?.aborted) {
    const error = new Error(`${methodName} canceled.`);
    error.name = 'AbortError';
    throw error;
  }
}

export async function notebookExecute(
  assignmentManager: AssignmentManager,
  rawArgs: NotebookExecuteArgs,
  options: NotebookExecutionOptions = {},
): Promise<NotebookExecuteResult> {
  throwIfAborted(options.signal, 'notebook.execute');
  let runtime = await selectExecutionServer(
    assignmentManager,
    rawArgs,
    'notebook.execute',
  );
  runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
  let client = ProxiedJupyterClient.withStaticConnection(runtime);
  const kernelName = await resolveKernelName(client, rawArgs.kernelName);
  const sessionName = makeSessionName();
  const sessionPath = `agent/${sessionName}.ipynb`;
  const timeoutMs = rawArgs.timeoutMs ?? DEFAULT_NOTEBOOK_EXECUTION_TIMEOUT_MS;
  const cleanupSession = rawArgs.cleanupSession ?? true;

  const session = await client.sessions.create({
    session: {
      name: sessionName,
      path: sessionPath,
      type: 'notebook',
      kernel: { name: kernelName } as unknown as { id: string; name: string },
    },
  });

  if (!session.id) {
    throw new Error('Notebook session creation did not return a session id.');
  }
  if (!session.kernel?.id) {
    throw new Error('Notebook session creation did not return a kernel id.');
  }

  const startedAt = Date.now();
  try {
    throwIfAborted(options.signal, 'notebook.execute');
    runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
    const execution = await executeCodeOnKernel(
      runtime,
      session.kernel.id,
      rawArgs.code,
      timeoutMs,
      options.signal,
    );

    return {
      runtime: toRuntimeRecord(runtime),
      sessionId: session.id,
      kernelId: session.kernel.id,
      kernelName,
      status: execution.status,
      outputs: execution.outputs,
      reply: execution.reply,
      elapsedMs: Date.now() - startedAt,
      cleanedUpSession: cleanupSession,
    };
  } finally {
    if (cleanupSession) {
      try {
        runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
        client = ProxiedJupyterClient.withStaticConnection(runtime);
        await client.sessions.delete({ session: session.id });
      } catch (error) {
        log.warn(
          `Failed cleaning up notebook session ${session.id} after execution.`,
          error,
        );
      }
    }
  }
}

export async function notebookRunAll(
  assignmentManager: AssignmentManager,
  rawArgs: NotebookRunAllArgs,
  options: NotebookExecutionOptions = {},
): Promise<NotebookRunAllResult> {
  throwIfAborted(options.signal, 'notebook.runAll');
  let runtime = await selectExecutionServer(
    assignmentManager,
    rawArgs,
    'notebook.runAll',
  );
  runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
  let client = ProxiedJupyterClient.withStaticConnection(runtime);
  const kernelName = await resolveKernelName(client, rawArgs.kernelName);
  const notebook = await loadNotebookCodeCells(rawArgs.notebookPath);
  const timeoutMsPerCell =
    rawArgs.timeoutMsPerCell ?? DEFAULT_NOTEBOOK_EXECUTION_TIMEOUT_MS;
  const stopOnError = rawArgs.stopOnError ?? true;
  const cleanupSession = rawArgs.cleanupSession ?? true;
  const sessionName = makeSessionName();
  const sessionPath = `agent/${sessionName}.ipynb`;

  runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
  client = ProxiedJupyterClient.withStaticConnection(runtime);
  const session = await client.sessions.create({
    session: {
      name: sessionName,
      path: sessionPath,
      type: 'notebook',
      kernel: { name: kernelName } as unknown as { id: string; name: string },
    },
  });

  if (!session.id) {
    throw new Error('Notebook session creation did not return a session id.');
  }
  if (!session.kernel?.id) {
    throw new Error('Notebook session creation did not return a kernel id.');
  }

  const saveCellsRuntimeDir = rawArgs.saveCellsRuntimeDir
    ? normalizeRuntimePath(rawArgs.saveCellsRuntimeDir, 'saveCellsRuntimeDir')
    : undefined;
  if (saveCellsRuntimeDir) {
    await ensureRuntimeDirectory(client, saveCellsRuntimeDir);
  }

  const startedAt = Date.now();
  const cells: NotebookRunCellResult[] = [];
  let failedCells = 0;
  let stoppedOnError = false;

  try {
    for (const [executionIndex, codeCell] of notebook.cells.entries()) {
      throwIfAborted(options.signal, 'notebook.runAll');
      runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
      client = ProxiedJupyterClient.withStaticConnection(runtime);
      const cellStartedAt = Date.now();
      const execution = await executeCodeOnKernel(
        runtime,
        session.kernel.id,
        codeCell.source,
        timeoutMsPerCell,
        options.signal,
      );

      let cellResult: NotebookRunCellResult = {
        cellIndex: codeCell.cellIndex,
        executionIndex: executionIndex + 1,
        status: execution.status,
        elapsedMs: Date.now() - cellStartedAt,
        sourcePreview: sourcePreview(codeCell.source),
        outputs: execution.outputs,
        reply: execution.reply,
      };

      if (saveCellsRuntimeDir) {
        const runtimePath = path.posix.join(
          saveCellsRuntimeDir,
          `cell-${(executionIndex + 1).toString().padStart(4, '0')}.json`,
        );
        const payload = {
          cellIndex: codeCell.cellIndex,
          executionIndex: executionIndex + 1,
          source: codeCell.source,
          status: execution.status,
          outputs: execution.outputs,
          reply: execution.reply,
          executedAt: new Date().toISOString(),
        };
        try {
          await writeTextFileToRuntime(
            client,
            runtimePath,
            `${JSON.stringify(payload, undefined, 2)}\n`,
            true,
          );
          cellResult = {
            ...cellResult,
            runtimeSavePath: runtimePath,
            runtimeSaveStatus: 'saved',
          };
        } catch (error) {
          cellResult = {
            ...cellResult,
            runtimeSavePath: runtimePath,
            runtimeSaveStatus: 'failed',
            runtimeSaveError:
              error instanceof Error ? error.message : String(error),
          };
        }
      }

      cells.push(cellResult);

      if (execution.status === 'error') {
        failedCells += 1;
        if (stopOnError) {
          stoppedOnError = true;
        }
      }
      options.onRunAllCellComplete?.({
        executedCells: cells.length,
        failedCells,
        totalCodeCells: notebook.cells.length,
        lastCellIndex: codeCell.cellIndex,
      });
      if (stoppedOnError) {
        break;
      }
    }

    const result: NotebookRunAllResult = {
      runtime: toRuntimeRecord(runtime),
      notebookPath: notebook.notebookPath,
      sessionId: session.id,
      kernelId: session.kernel.id,
      kernelName,
      status: failedCells > 0 ? 'error' : 'ok',
      totalCodeCells: notebook.cells.length,
      executedCells: cells.length,
      failedCells,
      stoppedOnError,
      elapsedMs: Date.now() - startedAt,
      cleanedUpSession: cleanupSession,
      saveCellsRuntimeDir,
      cells,
    };

    return result;
  } finally {
    if (cleanupSession) {
      try {
        runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
        client = ProxiedJupyterClient.withStaticConnection(runtime);
        await client.sessions.delete({ session: session.id });
      } catch (error) {
        log.warn(
          `Failed cleaning up notebook session ${session.id} after runAll.`,
          error,
        );
      }
    }
  }
}
