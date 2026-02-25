/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import { Shape, Variant } from './api';
import { dispatchAgentBridgeRequest } from './agent-bridge';
import { AgentRuntimeService } from './agent-runtime-service';
import { AssignmentManager } from '../jupyter/assignments';
import { ColabAssignedServer } from '../jupyter/servers';
import { newVsCodeStub, VsCodeStub } from '../test/helpers/vscode';

describe('Agent Bridge', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let server: ColabAssignedServer;

  beforeEach(() => {
    vsCodeStub = newVsCodeStub();
    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
    server = {
      id: randomUUID(),
      label: 'runtime-a',
      variant: Variant.DEFAULT,
      endpoint: 'm-s-runtime-a',
      accelerator: undefined,
      shape: undefined,
      version: undefined,
      connectionInformation: {
        baseUrl: vsCodeStub.Uri.parse('https://example.com'),
        token: '123',
        tokenExpiry: new Date(Date.now() + 60_000),
        headers: {},
      },
      dateAssigned: new Date('2026-01-01T00:00:00.000Z'),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('handles ping requests', async () => {
    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'ping',
    })) as {
      status: string;
      now: string;
    };

    expect(response.status).to.equal('ok');
    expect(new Date(response.now).toString()).to.not.equal('Invalid Date');
  });

  it('returns bridge capabilities', async () => {
    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'bridge.capabilities',
    })) as {
      bridgeVersion: number;
      methods: string[];
    };

    expect(response.bridgeVersion).to.equal(1);
    expect(response.methods).to.include('notebook.runAll');
    expect(response.methods).to.include('runtimes.options');
    expect(response.methods).to.include('runs.start');
    expect(response.methods).to.include('runs.status');
    expect(response.methods).to.include('runtime.files.writeText');
    expect(response.methods).to.include('runtime.secrets.sync');
  });

  it('returns account-eligible runtime options', async () => {
    (
      assignmentManagerStub.getAvailableServerDescriptors as sinon.SinonStub
    ).resolves([
      {
        label: 'Colab CPU',
        variant: Variant.DEFAULT,
      },
      {
        label: 'Colab GPU L4',
        variant: Variant.GPU,
        accelerator: 'L4',
        shape: Shape.STANDARD,
      },
      {
        label: 'Colab GPU T4 Highmem',
        variant: Variant.GPU,
        accelerator: 'T4',
        shape: Shape.HIGHMEM,
      },
      {
        label: 'Colab TPU v2',
        variant: Variant.TPU,
        accelerator: 'V2',
      },
    ]);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runtimes.options',
    })) as {
      readonly options: readonly {
        readonly label: string;
        readonly variant: Variant;
        readonly accelerator?: string;
        readonly shape?: Shape;
      }[];
      readonly counts: {
        readonly total: number;
        readonly byVariant: {
          readonly DEFAULT: number;
          readonly GPU: number;
          readonly TPU: number;
        };
      };
    };

    expect(response.options).to.have.length(4);
    expect(response.options[0].label).to.equal('Colab CPU');
    expect(response.options[1].shape).to.equal(Shape.STANDARD);
    expect(response.counts).to.deep.equal({
      total: 4,
      byVariant: {
        DEFAULT: 1,
        GPU: 2,
        TPU: 1,
      },
    });
  });

  it('delegates runtime list requests to agent commands', async () => {
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('extension')
      .resolves([server]);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runtimes.list',
      params: { from: 'extension' },
    })) as {
      scope: string;
      counts: {
        assigned: number;
        unowned: number;
        total: number;
      };
    };

    expect(response.scope).to.equal('extension');
    expect(response.counts).to.deep.equal({
      assigned: 1,
      unowned: 0,
      total: 1,
    });
  });

  it('starts async runs via runs.start', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'startRun').resolves({
      runId: 'run-1',
      kind: 'notebook.execute',
      status: 'queued',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      cancelRequested: false,
    });

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runs.start',
      params: {
        kind: 'notebook.execute',
        args: {
          code: 'print(1)',
        },
      },
    })) as {
      readonly runId: string;
      readonly status: string;
      readonly kind: string;
    };

    expect(response.runId).to.equal('run-1');
    expect(response.status).to.equal('queued');
    expect(response.kind).to.equal('notebook.execute');
  });

  it('formats runs.status notebook results by default and supports includeResult=false', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'runStatus').resolves({
      runId: 'run-1',
      kind: 'notebook.execute',
      status: 'succeeded',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      startedAt: new Date('2026-01-01T00:00:01.000Z').toISOString(),
      finishedAt: new Date('2026-01-01T00:00:02.000Z').toISOString(),
      cancelRequested: false,
      result: {
        runtime: {
          owner: 'extension',
          id: randomUUID(),
          label: 'Colab CPU',
          endpoint: 'm-s-test',
          variant: Variant.DEFAULT,
          accelerator: 'NONE',
        },
        sessionId: 'session-id',
        kernelId: 'kernel-id',
        kernelName: 'python3',
        status: 'ok',
        outputs: [{ type: 'stream', text: 'hello\n', name: 'stdout' }],
        reply: {},
        elapsedMs: 5,
        cleanedUpSession: true,
      },
    });

    const formatted = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runs.status',
      params: {
        runId: 'run-1',
      },
    })) as {
      readonly result: {
        readonly format?: string;
      };
    };
    expect(formatted.result.format).to.equal('compact');

    const hiddenResult = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runs.status',
      params: {
        runId: 'run-1',
        includeResult: false,
      },
    })) as {
      readonly result?: unknown;
    };
    expect(hiddenResult.result).to.equal(undefined);
  });

  it('delegates runs.list and runs.cancel', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'listRuns').resolves({
      runs: [
        {
          runId: 'run-1',
          kind: 'notebook.runAll',
          status: 'running',
          createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
          cancelRequested: false,
        },
      ],
      count: 1,
    });
    sinon.stub(AgentRuntimeService.prototype, 'cancelRun').resolves({
      runId: 'run-1',
      cancelRequested: true,
      status: 'running',
    });

    const listed = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runs.list',
      params: { limit: 10, status: 'running' },
    })) as {
      readonly count: number;
    };
    expect(listed.count).to.equal(1);

    const canceled = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runs.cancel',
      params: { runId: 'run-1' },
    })) as {
      readonly cancelRequested: boolean;
    };
    expect(canceled.cancelRequested).to.equal(true);
  });

  it('rejects non-object params', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.list',
        params: [],
      }),
    ).to.eventually.be.rejectedWith('Request "params" must be an object.');
  });

  it('rejects unknown methods', async () => {
    try {
      await dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'unsupported-method',
      });
      expect.fail('Expected method dispatch to fail.');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      const withCode = error as { code?: string; message?: string };
      expect(withCode.code).to.equal('UNSUPPORTED_METHOD');
      expect(withCode.message).to.equal('Unsupported method "unsupported-method".');
    }
  });

  it('rejects notebook.execute when code is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.execute',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'notebook.execute requires a non-empty "code" string.',
    );
  });

  it('rejects notebook.runAll when notebookPath is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.runAll',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'notebook.runAll requires a non-empty "notebookPath" string.',
    );
  });

  it('rejects runtime.files.writeText when runtimePath is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtime.files.writeText',
        params: { text: 'hello' },
      }),
    ).to.eventually.be.rejectedWith(
      'runtime.files.writeText requires a non-empty "runtimePath" string.',
    );
  });

  it('rejects runtime.secrets.sync when hfToken is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtime.secrets.sync',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'runtime.secrets.sync requires a non-empty "hfToken" string (or HF_TOKEN/HF_ACCESS_TOKEN).',
    );
  });

  it('rejects invalid runtime scope values in execution requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.execute',
        params: {
          code: 'print(1)',
          from: 'invalid-scope',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "from" value. Use extension, external, or all.',
    );
  });

  it('rejects invalid runtime scope values in lifecycle requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.list',
        params: {
          from: 'invalid-scope',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "from" value. Use extension, external, or all.',
    );
  });

  it('rejects non-string selector values in lifecycle requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.status',
        params: {
          id: 123,
        },
      }),
    ).to.eventually.be.rejectedWith('Invalid "id" value. Expected a string.');
  });

  it('rejects invalid start descriptor values', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.start',
        params: {
          mode: 'new',
          variant: 'wrong-variant',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "variant" value. Use DEFAULT, GPU, or TPU.',
    );

    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.start',
        params: {
          mode: 'new',
          shape: 'wrong-shape',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.',
    );
  });

  it('rejects non-integer timeout values in execution requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.execute',
        params: {
          code: 'print(1)',
          timeoutMs: '1000',
        },
      }),
    ).to.eventually.be.rejectedWith('timeoutMs must be an integer.');
  });

  it('rejects notebook.runAll saveResultPath for bridge requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.runAll',
        params: {
          notebookPath: './test.ipynb',
          saveResultPath: '/tmp/results.json',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'notebook.runAll does not support "saveResultPath". Save results in the client process.',
    );
  });

  it('rejects invalid runs.start payloads', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runs.start',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'runs.start requires "kind" as "notebook.execute" or "notebook.runAll".',
    );

    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runs.start',
        params: {
          kind: 'notebook.execute',
          args: 'not-an-object',
        },
      }),
    ).to.eventually.be.rejectedWith('runs.start requires "args" as an object.');
  });

  it('returns compact markdown-friendly output for notebook.runAll by default', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'notebookRunAll').resolves({
      runtime: {
        owner: 'extension',
        id: randomUUID(),
        label: 'Colab CPU',
        endpoint: 'm-s-test',
        variant: Variant.DEFAULT,
        accelerator: 'NONE',
        dateAssigned: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        baseUrl: 'https://example.com/',
        tokenExpiry: new Date('2026-01-01T01:00:00.000Z').toISOString(),
      },
      notebookPath: '/tmp/example.ipynb',
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      totalCodeCells: 1,
      executedCells: 1,
      failedCells: 0,
      stoppedOnError: false,
      elapsedMs: 10,
      cleanedUpSession: true,
      cells: [
        {
          cellIndex: 0,
          executionIndex: 1,
          status: 'ok',
          elapsedMs: 10,
          sourcePreview: 'print(1)',
          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
          reply: {},
        },
      ],
    } as Awaited<ReturnType<AgentRuntimeService['notebookRunAll']>>);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'notebook.runAll',
      params: {
        notebookPath: '/tmp/example.ipynb',
      },
    })) as {
      readonly format: string;
      readonly cells: readonly { readonly logs: string; readonly ok: boolean }[];
      readonly summaryMarkdown?: string;
    };

    expect(response.format).to.equal('compact');
    expect(response.cells).to.have.length(1);
    expect(response.cells[0].ok).to.equal(true);
    expect(response.cells[0].logs).to.equal('1');
    expect(response.summaryMarkdown).to.contain('# Notebook RunAll Result');
  });

  it('supports outputMode=raw to preserve rich notebook payloads', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'notebookRunAll').resolves({
      runtime: {
        owner: 'extension',
        id: randomUUID(),
        label: 'Colab CPU',
        endpoint: 'm-s-test',
        variant: Variant.DEFAULT,
        accelerator: 'NONE',
        dateAssigned: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        baseUrl: 'https://example.com/',
        tokenExpiry: new Date('2026-01-01T01:00:00.000Z').toISOString(),
      },
      notebookPath: '/tmp/example.ipynb',
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      totalCodeCells: 1,
      executedCells: 1,
      failedCells: 0,
      stoppedOnError: false,
      elapsedMs: 10,
      cleanedUpSession: true,
      cells: [
        {
          cellIndex: 0,
          executionIndex: 1,
          status: 'ok',
          elapsedMs: 10,
          sourcePreview: 'print(1)',
          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
          reply: { status: 'ok' },
        },
      ],
    } as Awaited<ReturnType<AgentRuntimeService['notebookRunAll']>>);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'notebook.runAll',
      params: {
        notebookPath: '/tmp/example.ipynb',
        outputMode: 'raw',
        render: 'none',
      },
    })) as {
      readonly format?: string;
      readonly cells: readonly { readonly outputs?: readonly unknown[] }[];
    };

    expect(response.format).to.equal(undefined);
    expect(response.cells).to.have.length(1);
    expect(response.cells[0].outputs).to.have.length(1);
  });
});
