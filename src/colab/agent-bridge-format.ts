/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  NotebookExecuteResult,
  NotebookExecutionOutput,
  NotebookRunAllResult,
  NotebookRunCellResult,
} from './agent-runtime-service';

export type AgentBridgeOutputMode = 'raw' | 'compact';
export type AgentBridgeRenderMode = 'none' | 'markdown';

interface CompactError {
  readonly name: string;
  readonly message: string;
}

interface CompactNotebookCell {
  readonly cellIndex: number;
  readonly executionIndex: number;
  readonly ok: boolean;
  readonly status: 'ok' | 'error';
  readonly logs: string;
  readonly error?: CompactError;
}

interface CompactNotebookExecuteResult {
  readonly format: 'compact';
  readonly ok: boolean;
  readonly status: 'ok' | 'error';
  readonly runtime: NotebookExecuteResult['runtime'];
  readonly sessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly elapsedMs: number;
  readonly cleanedUpSession: boolean;
  readonly logs: string;
  readonly error?: CompactError;
  readonly summaryMarkdown?: string;
}

interface CompactNotebookRunAllResult {
  readonly format: 'compact';
  readonly ok: boolean;
  readonly status: 'ok' | 'error';
  readonly runtime: NotebookRunAllResult['runtime'];
  readonly notebookPath: string;
  readonly sessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly totalCodeCells: number;
  readonly executedCells: number;
  readonly failedCells: number;
  readonly stoppedOnError: boolean;
  readonly elapsedMs: number;
  readonly cleanedUpSession: boolean;
  readonly cells: readonly CompactNotebookCell[];
  readonly summaryMarkdown?: string;
}

interface MarkdownAttachable {
  readonly summaryMarkdown?: string;
}

function sanitizeText(value: string): string {
  // Strip ANSI escapes for agent readability.
  return value.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function outputText(output: NotebookExecutionOutput): string {
  switch (output.type) {
    case 'stream':
      return output.text ?? '';
    case 'execute_result':
    case 'display_data':
      if (output.text && output.text.length > 0) {
        return output.text;
      }
      return JSON.stringify(output.data ?? {});
    case 'error':
      if (output.traceback && output.traceback.length > 0) {
        return output.traceback.join('\n');
      }
      return `${output.ename ?? 'Error'}: ${output.evalue ?? 'Execution failed.'}`;
    default:
      return '';
  }
}

function collectLogs(outputs: readonly NotebookExecutionOutput[]): string {
  const chunks = outputs
    .map(outputText)
    .map((chunk) => sanitizeText(chunk))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  return chunks.join('\n');
}

function firstErrorFromOutputs(
  outputs: readonly NotebookExecutionOutput[],
): CompactError | undefined {
  for (const output of outputs) {
    if (output.type !== 'error') {
      continue;
    }
    return {
      name: output.ename ?? 'ExecutionError',
      message: output.evalue ?? 'Execution failed.',
    };
  }
  return undefined;
}

function renderExecuteMarkdown(
  result: CompactNotebookExecuteResult,
): string {
  const lines: string[] = [
    '# Notebook Execute Result',
    '',
    `- Status: ${result.ok ? 'ok' : 'error'}`,
    `- Runtime: ${result.runtime.label}`,
    `- ElapsedMs: ${result.elapsedMs.toString()}`,
    '',
  ];
  if (result.error) {
    lines.push(`- Error: ${result.error.name}: ${result.error.message}`);
    lines.push('');
  }
  lines.push('## Logs');
  lines.push('```text');
  lines.push(result.logs.length > 0 ? result.logs : '<no logs>');
  lines.push('```');
  return lines.join('\n');
}

function renderRunAllMarkdown(result: CompactNotebookRunAllResult): string {
  const lines: string[] = [
    '# Notebook RunAll Result',
    '',
    `- Status: ${result.ok ? 'ok' : 'error'}`,
    `- Executed: ${result.executedCells.toString()} / ${result.totalCodeCells.toString()}`,
    `- Failed: ${result.failedCells.toString()}`,
    `- StoppedOnError: ${result.stoppedOnError ? 'true' : 'false'}`,
    `- ElapsedMs: ${result.elapsedMs.toString()}`,
    '',
    '## Cells',
  ];

  for (const cell of result.cells) {
    lines.push(
      `### Cell ${cell.executionIndex.toString()} (index ${cell.cellIndex.toString()}): ${cell.ok ? 'ok' : 'error'}`,
    );
    if (cell.error) {
      lines.push(`- Error: ${cell.error.name}: ${cell.error.message}`);
    }
    lines.push('```text');
    lines.push(cell.logs.length > 0 ? cell.logs : '<no logs>');
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function toCompactCell(cell: NotebookRunCellResult): CompactNotebookCell {
  const error = firstErrorFromOutputs(cell.outputs);
  return {
    cellIndex: cell.cellIndex,
    executionIndex: cell.executionIndex,
    ok: cell.status === 'ok',
    status: cell.status,
    logs: collectLogs(cell.outputs),
    ...(error ? { error } : {}),
  };
}

function toCompactExecuteResult(
  result: NotebookExecuteResult,
): CompactNotebookExecuteResult {
  const error = firstErrorFromOutputs(result.outputs);
  return {
    format: 'compact',
    ok: result.status === 'ok',
    status: result.status,
    runtime: result.runtime,
    sessionId: result.sessionId,
    kernelId: result.kernelId,
    kernelName: result.kernelName,
    elapsedMs: result.elapsedMs,
    cleanedUpSession: result.cleanedUpSession,
    logs: collectLogs(result.outputs),
    ...(error ? { error } : {}),
  };
}

function toCompactRunAllResult(
  result: NotebookRunAllResult,
): CompactNotebookRunAllResult {
  return {
    format: 'compact',
    ok: result.status === 'ok',
    status: result.status,
    runtime: result.runtime,
    notebookPath: result.notebookPath,
    sessionId: result.sessionId,
    kernelId: result.kernelId,
    kernelName: result.kernelName,
    totalCodeCells: result.totalCodeCells,
    executedCells: result.executedCells,
    failedCells: result.failedCells,
    stoppedOnError: result.stoppedOnError,
    elapsedMs: result.elapsedMs,
    cleanedUpSession: result.cleanedUpSession,
    cells: result.cells.map(toCompactCell),
  };
}

export function formatNotebookExecuteResult(
  result: NotebookExecuteResult,
  outputMode: AgentBridgeOutputMode,
  renderMode: AgentBridgeRenderMode,
): NotebookExecuteResult | (CompactNotebookExecuteResult & MarkdownAttachable) {
  if (outputMode === 'raw') {
    if (renderMode === 'none') {
      return result;
    }
    const compact = toCompactExecuteResult(result);
    return {
      ...result,
      summaryMarkdown: renderExecuteMarkdown(compact),
    };
  }

  const compact = toCompactExecuteResult(result);

  if (renderMode === 'none') {
    return compact;
  }
  return {
    ...compact,
    summaryMarkdown: renderExecuteMarkdown(compact),
  };
}

export function formatNotebookRunAllResult(
  result: NotebookRunAllResult,
  outputMode: AgentBridgeOutputMode,
  renderMode: AgentBridgeRenderMode,
): NotebookRunAllResult | (CompactNotebookRunAllResult & MarkdownAttachable) {
  if (outputMode === 'raw') {
    if (renderMode === 'none') {
      return result;
    }
    const compact = toCompactRunAllResult(result);
    return {
      ...result,
      summaryMarkdown: renderRunAllMarkdown(compact),
    };
  }

  const compact = toCompactRunAllResult(result);

  if (renderMode === 'none') {
    return compact;
  }
  return {
    ...compact,
    summaryMarkdown: renderRunAllMarkdown(compact),
  };
}
