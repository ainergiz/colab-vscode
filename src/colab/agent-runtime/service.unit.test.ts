/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import { Shape, Variant } from '../api';
import { AssignmentManager } from '../../jupyter/assignments';
import { ColabAssignedServer, UnownedServer } from '../../jupyter/servers';
import { newVsCodeStub, VsCodeStub } from '../../test/helpers/vscode';
import { AgentRuntimeService } from './service';

describe('Agent Runtime Service', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let defaultServer: ColabAssignedServer;
  let service: AgentRuntimeService;

  beforeEach(() => {
    vsCodeStub = newVsCodeStub();
    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
    defaultServer = {
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
    service = new AgentRuntimeService(assignmentManagerStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  async function waitForTerminalRun(runId: string): Promise<{
    readonly status: string;
    readonly cancelRequested: boolean;
    readonly result?: unknown;
  }> {
    const timeoutAt = Date.now() + 2_000;
    while (Date.now() < timeoutAt) {
      const run = await service.runStatus({ runId });
      if (
        run.status === 'succeeded' ||
        run.status === 'failed' ||
        run.status === 'canceled'
      ) {
        return run;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`Timed out waiting for run ${runId} to complete.`);
  }

  it('rejects invalid start mode values', async () => {
    await expect(
      service.startRuntime({ mode: 'invalid-mode' }),
    ).to.eventually.be.rejectedWith(
      'Invalid "mode" value. Use "latestOrCreate" or "new".',
    );
  });

  it('rejects invalid start variant and shape values', async () => {
    await expect(
      service.startRuntime({ mode: 'new', variant: 'not-a-variant' }),
    ).to.eventually.be.rejectedWith(
      'Invalid "variant" value. Use DEFAULT, GPU, or TPU.',
    );

    await expect(
      service.startRuntime({ mode: 'new', shape: 'not-a-shape' }),
    ).to.eventually.be.rejectedWith(
      'Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.',
    );
  });

  it('normalizes descriptor values when creating a new runtime', async () => {
    assignmentManagerStub.getDefaultLabel.resolves('auto-alias');
    assignmentManagerStub.assignServer.resolves(defaultServer);

    const result = await service.startRuntime({
      mode: 'new',
      variant: 'gpu',
      accelerator: 'l4',
      shape: 'highmem',
    });

    sinon.assert.calledOnceWithExactly(assignmentManagerStub.assignServer, {
      label: 'auto-alias',
      variant: Variant.GPU,
      accelerator: 'L4',
      shape: Shape.HIGHMEM,
    });
    expect(result.action).to.equal('created');
    expect(result.mode).to.equal('new');
  });

  it('returns account-eligible runtime options with per-variant counts', async () => {
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

    const result = await service.listRuntimeOptions();

    expect(result.options).to.have.length(4);
    expect(result.options[2]).to.deep.include({
      label: 'Colab GPU T4 Highmem',
      variant: Variant.GPU,
      accelerator: 'T4',
      shape: Shape.HIGHMEM,
    });
    expect(result.counts).to.deep.equal({
      total: 4,
      byVariant: {
        DEFAULT: 1,
        GPU: 2,
        TPU: 1,
      },
    });
  });

  it('merges known runtime descriptors with catalog options when options API is unavailable', async () => {
    (
      assignmentManagerStub.getAvailableServerDescriptors as sinon.SinonStub
    ).rejects(new Error('service disabled'));
    const unownedRuntime: UnownedServer = {
      label: 'External TPU',
      endpoint: 'm-s-external',
      variant: Variant.TPU,
      accelerator: 'V2',
    };
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('all')
      .resolves({
        assigned: [
          {
            ...defaultServer,
            label: 'Colab GPU T4',
            variant: Variant.GPU,
            accelerator: 'T4',
            shape: Shape.HIGHMEM,
          },
        ],
        unowned: [unownedRuntime],
      });

    const result = await service.listRuntimeOptions();

    expect(result.options).to.have.length(9);
    expect(result.options).to.deep.include.members([
      {
        label: 'Colab GPU H100',
        variant: Variant.GPU,
        accelerator: 'H100',
        shape: undefined,
        version: 'latest',
      },
      {
        label: 'External TPU',
        variant: Variant.TPU,
        accelerator: 'V2',
        shape: undefined,
        version: undefined,
      },
    ]);
    expect(result.counts).to.deep.equal({
      total: 9,
      byVariant: {
        DEFAULT: 1,
        GPU: 5,
        TPU: 3,
      },
    });
  });

  it('falls back to catalog options when options and runtime listing fail', async () => {
    (
      assignmentManagerStub.getAvailableServerDescriptors as sinon.SinonStub
    ).rejects(new Error('service disabled'));
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('all')
      .rejects(new Error('list runtimes failed'));

    const result = await service.listRuntimeOptions();

    expect(result.options).to.have.length(7);
    expect(result.options).to.deep.include.members([
      {
        label: 'Colab CPU',
        variant: Variant.DEFAULT,
        accelerator: 'NONE',
        shape: undefined,
        version: 'latest',
      },
      {
        label: 'Colab GPU A100',
        variant: Variant.GPU,
        accelerator: 'A100',
        shape: undefined,
        version: 'latest',
      },
      {
        label: 'Colab TPU v6e-1',
        variant: Variant.TPU,
        accelerator: 'V6E-1',
        shape: undefined,
        version: 'latest',
      },
    ]);
    expect(result.counts).to.deep.equal({
      total: 7,
      byVariant: {
        DEFAULT: 1,
        GPU: 4,
        TPU: 2,
      },
    });
  });

  it('reuses latest runtime in latestOrCreate mode', async () => {
    assignmentManagerStub.latestServer.resolves(defaultServer);

    const result = await service.startRuntime({ mode: 'latestOrCreate' });

    expect(result.action).to.equal('reused');
    expect(result.runtime.id).to.equal(defaultServer.id);
    sinon.assert.notCalled(assignmentManagerStub.latestOrAutoAssignServer);
  });

  it('stops latest assigned runtime by default in extension scope', async () => {
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('extension')
      .resolves([defaultServer]);
    assignmentManagerStub.latestServer.resolves(defaultServer);
    assignmentManagerStub.unassignServer.resolves();

    const result = await service.stopRuntime({});

    expect(result.notFound).to.equal(false);
    expect(result.stopped).to.have.length(1);
    expect(result.stopped[0].id).to.equal(defaultServer.id);
    sinon.assert.calledOnceWithExactly(
      assignmentManagerStub.unassignServer,
      defaultServer,
    );
  });

  it('marks ambiguous label selection in runtime status', async () => {
    const otherServer = { ...defaultServer, id: randomUUID() };

    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('all')
      .resolves({
        assigned: [defaultServer, otherServer],
        unowned: [],
      });
    assignmentManagerStub.latestServer.resolves(defaultServer);

    const result = await service.runtimeStatus({
      from: 'all',
      label: defaultServer.label,
    });

    expect(result.ambiguousLabelSelection).to.equal(true);
    expect(result.selected).to.have.length(2);
  });

  it('rejects invalid runtime scope values', async () => {
    await expect(
      service.listRuntimes({
        from: 'invalid' as unknown as 'extension',
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "from" value. Use extension, external, or all.',
    );
  });

  it('rejects execution methods with from=external', async () => {
    await expect(
      service.notebookExecute({ from: 'external', code: 'print(1)' }),
    ).to.eventually.be.rejectedWith(
      'notebook.execute only supports extension-assigned runtimes',
    );

    await expect(
      service.runtimeFilesWriteText({
        from: 'external',
        runtimePath: '/content/test.txt',
        text: 'hello',
      }),
    ).to.eventually.be.rejectedWith(
      'runtime.files.writeText only supports extension-assigned runtimes',
    );

    await expect(
      service.runtimeSecretsSync({ from: 'external', hfToken: 'token' }),
    ).to.eventually.be.rejectedWith(
      'runtime.secrets.sync only supports extension-assigned runtimes',
    );
  });

  it('starts an async notebook.execute run and returns terminal status with result', async () => {
    const executeResult = {
      runtime: {
        owner: 'extension' as const,
        id: defaultServer.id,
        label: defaultServer.label,
        endpoint: defaultServer.endpoint,
        variant: defaultServer.variant,
        accelerator: defaultServer.accelerator,
        shape: defaultServer.shape,
        version: defaultServer.version,
        dateAssigned: defaultServer.dateAssigned.toISOString(),
        baseUrl: defaultServer.connectionInformation.baseUrl.toString(),
        tokenExpiry: defaultServer.connectionInformation.tokenExpiry.toISOString(),
      },
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok' as const,
      outputs: [],
      reply: {},
      elapsedMs: 5,
      cleanedUpSession: true,
    };
    sinon
      .stub(service, 'notebookExecute')
      .callsFake(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 15);
        });
        return executeResult;
      });

    const started = await service.startRun({
      kind: 'notebook.execute',
      notebookExecuteArgs: { code: 'print(1)' },
    });

    expect(started.status).to.equal('queued');
    const run = await waitForTerminalRun(started.runId);
    expect(run.status).to.equal('succeeded');
    expect(run.result).to.deep.equal(executeResult);

    const listed = await service.listRuns({ limit: 10 });
    expect(listed.count).to.be.greaterThan(0);
    expect(listed.runs[0].runId).to.equal(started.runId);
  });

  it('cancels a running async notebook.runAll job', async () => {
    sinon.stub(service, 'notebookRunAll').callsFake(async (_args, options = {}) => {
      const signal = options.signal;
      if (signal?.aborted) {
        const error = new Error('run canceled');
        error.name = 'AbortError';
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('run canceled');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
      return {
        runtime: {
          owner: 'extension' as const,
          id: defaultServer.id,
          label: defaultServer.label,
          endpoint: defaultServer.endpoint,
          variant: defaultServer.variant,
          accelerator: defaultServer.accelerator,
          shape: defaultServer.shape,
          version: defaultServer.version,
          dateAssigned: defaultServer.dateAssigned.toISOString(),
          baseUrl: defaultServer.connectionInformation.baseUrl.toString(),
          tokenExpiry: defaultServer.connectionInformation.tokenExpiry.toISOString(),
        },
        notebookPath: '/tmp/example.ipynb',
        sessionId: 'session-id',
        kernelId: 'kernel-id',
        kernelName: 'python3',
        status: 'ok' as const,
        totalCodeCells: 1,
        executedCells: 1,
        failedCells: 0,
        stoppedOnError: false,
        elapsedMs: 20,
        cleanedUpSession: true,
        cells: [],
      };
    });

    const started = await service.startRun({
      kind: 'notebook.runAll',
      notebookRunAllArgs: { notebookPath: '/tmp/example.ipynb' },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const cancelResult = await service.cancelRun({ runId: started.runId });
    expect(cancelResult.cancelRequested).to.equal(true);

    const run = await waitForTerminalRun(started.runId);
    expect(run.status).to.equal('canceled');
    expect(run.cancelRequested).to.equal(true);
  });

  it('validates timeout values consistently', () => {
    expect(AgentRuntimeService.validateTimeoutMs(undefined, 'timeoutMs')).to.equal(
      90_000,
    );

    expect(() => AgentRuntimeService.validateTimeoutMs(0, 'timeoutMs')).to.throw(
      'timeoutMs must be in the range 1..600000.',
    );

    expect(() => AgentRuntimeService.validateTimeoutMs(600_001, 'timeoutMs')).to.throw(
      'timeoutMs must be in the range 1..600000.',
    );
  });
});
