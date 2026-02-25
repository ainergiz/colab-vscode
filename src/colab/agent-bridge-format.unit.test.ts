/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai';
import { Variant } from './api';
import {
  formatNotebookExecuteResult,
  formatNotebookRunAllResult,
} from './agent-bridge-format';
import { NotebookExecuteResult, NotebookRunAllResult } from './agent-runtime-service';

const RUNTIME = {
  owner: 'extension' as const,
  id: 'runtime-id',
  label: 'Colab CPU',
  endpoint: 'm-s-test',
  variant: Variant.DEFAULT,
  accelerator: 'NONE',
  dateAssigned: '2026-02-22T00:00:00.000Z',
  baseUrl: 'https://example.com/',
  tokenExpiry: '2026-02-22T01:00:00.000Z',
};

describe('Agent Bridge Output Formatter', () => {
  it('formats notebook.execute to compact output by default shape', () => {
    const raw: NotebookExecuteResult = {
      runtime: RUNTIME,
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'error',
      outputs: [
        { type: 'stream', name: 'stdout', text: 'line-1\n' },
        {
          type: 'error',
          ename: 'ValueError',
          evalue: 'bad input',
          traceback: ['Traceback line 1', 'Traceback line 2'],
        },
      ],
      reply: {},
      elapsedMs: 123,
      cleanedUpSession: true,
    };

    const compact = formatNotebookExecuteResult(raw, 'compact', 'none') as {
      readonly format: string;
      readonly ok: boolean;
      readonly logs: string;
      readonly error?: { readonly name: string; readonly message: string };
      readonly outputs?: unknown;
    };

    expect(compact.format).to.equal('compact');
    expect(compact.ok).to.equal(false);
    expect(compact.logs).to.contain('line-1');
    expect(compact.logs).to.contain('Traceback line 1');
    expect(compact.error).to.deep.equal({
      name: 'ValueError',
      message: 'bad input',
    });
    expect(compact.outputs).to.equal(undefined);
  });

  it('attaches markdown summary when requested', () => {
    const raw: NotebookExecuteResult = {
      runtime: RUNTIME,
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      outputs: [{ type: 'stream', name: 'stdout', text: 'hello\n' }],
      reply: {},
      elapsedMs: 77,
      cleanedUpSession: true,
    };

    const compact = formatNotebookExecuteResult(raw, 'compact', 'markdown') as {
      readonly summaryMarkdown?: string;
    };

    expect(compact.summaryMarkdown).to.contain('# Notebook Execute Result');
    expect(compact.summaryMarkdown).to.contain('hello');
  });

  it('keeps raw payload in raw mode while adding markdown optionally', () => {
    const raw: NotebookExecuteResult = {
      runtime: RUNTIME,
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      outputs: [{ type: 'stream', name: 'stdout', text: 'hello\n' }],
      reply: { status: 'ok' },
      elapsedMs: 88,
      cleanedUpSession: true,
    };

    const result = formatNotebookExecuteResult(raw, 'raw', 'markdown') as {
      readonly outputs: readonly unknown[];
      readonly reply: unknown;
      readonly summaryMarkdown?: string;
    };

    expect(result.outputs).to.have.length(1);
    expect(result.reply).to.deep.equal({ status: 'ok' });
    expect(result.summaryMarkdown).to.contain('# Notebook Execute Result');
  });

  it('formats notebook.runAll into per-cell compact logs', () => {
    const raw: NotebookRunAllResult = {
      runtime: RUNTIME,
      notebookPath: '/tmp/example.ipynb',
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'error',
      totalCodeCells: 2,
      executedCells: 2,
      failedCells: 1,
      stoppedOnError: false,
      elapsedMs: 222,
      cleanedUpSession: true,
      cells: [
        {
          cellIndex: 0,
          executionIndex: 1,
          status: 'ok',
          elapsedMs: 100,
          sourcePreview: 'print(1)',
          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
          reply: {},
        },
        {
          cellIndex: 1,
          executionIndex: 2,
          status: 'error',
          elapsedMs: 122,
          sourcePreview: 'raise ValueError()',
          outputs: [
            {
              type: 'error',
              ename: 'ValueError',
              evalue: 'boom',
              traceback: ['Traceback...'],
            },
          ],
          reply: {},
        },
      ],
    };

    const compact = formatNotebookRunAllResult(raw, 'compact', 'markdown') as {
      readonly format: string;
      readonly cells: readonly {
        readonly ok: boolean;
        readonly logs: string;
        readonly error?: { readonly name: string; readonly message: string };
      }[];
      readonly summaryMarkdown?: string;
    };

    expect(compact.format).to.equal('compact');
    expect(compact.cells).to.have.length(2);
    expect(compact.cells[0].ok).to.equal(true);
    expect(compact.cells[0].logs).to.contain('1');
    expect(compact.cells[1].ok).to.equal(false);
    expect(compact.cells[1].error).to.deep.equal({
      name: 'ValueError',
      message: 'boom',
    });
    expect(compact.summaryMarkdown).to.contain('# Notebook RunAll Result');
  });
});
