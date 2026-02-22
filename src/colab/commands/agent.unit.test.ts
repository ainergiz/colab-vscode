/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import { Shape, Variant } from '../api';
import { AssignmentManager } from '../../jupyter/assignments';
import { ColabAssignedServer, UnownedServer } from '../../jupyter/servers';
import { newVsCodeStub, VsCodeStub } from '../../test/helpers/vscode';
import {
  agentListRuntimes,
  agentRuntimeStatus,
  agentStartRuntime,
  agentStopRuntime,
} from './agent';

describe('Agent Commands', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let defaultServer: ColabAssignedServer;

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
  });

  afterEach(() => {
    sinon.restore();
  });

  it('lists runtimes across assigned and unowned scopes', async () => {
    const unowned: UnownedServer = {
      label: 'remote-notebook',
      endpoint: 'm-s-remote',
      variant: Variant.GPU,
      accelerator: 'T4',
    };
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('all')
      .resolves({
        assigned: [defaultServer],
        unowned: [unowned],
      });

    const result = await agentListRuntimes(assignmentManagerStub, {
      from: 'all',
    });

    expect(result.counts).to.deep.equal({ assigned: 1, unowned: 1, total: 2 });
    expect(result.assigned[0].owner).to.equal('extension');
    expect(result.unowned[0].owner).to.equal('external');
    expect(result.unowned[0].endpoint).to.equal('m-s-remote');
  });

  it('reuses latest runtime when starting in latestOrCreate mode', async () => {
    assignmentManagerStub.latestServer.resolves(defaultServer);

    const result = await agentStartRuntime(assignmentManagerStub, {});

    expect(result.mode).to.equal('latestOrCreate');
    expect(result.action).to.equal('reused');
    expect(result.runtime.id).to.equal(defaultServer.id);
    sinon.assert.notCalled(assignmentManagerStub.latestOrAutoAssignServer);
  });

  it('creates a new runtime with normalized descriptor values', async () => {
    assignmentManagerStub.getDefaultLabel.resolves('auto-alias');
    assignmentManagerStub.assignServer.resolves(defaultServer);

    const result = await agentStartRuntime(assignmentManagerStub, {
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
  });

  it('stops the latest assigned runtime when no selector is provided', async () => {
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('extension')
      .resolves([defaultServer]);
    assignmentManagerStub.latestServer.resolves(defaultServer);
    assignmentManagerStub.unassignServer.resolves();

    const result = await agentStopRuntime(assignmentManagerStub, {});

    expect(result.notFound).to.equal(false);
    expect(result.stopped).to.have.length(1);
    expect(result.stopped[0].id).to.equal(defaultServer.id);
    sinon.assert.calledOnceWithExactly(
      assignmentManagerStub.unassignServer,
      defaultServer,
    );
  });

  it('fails with an explicit error on ambiguous label selection', async () => {
    const otherServer = { ...defaultServer, id: randomUUID() };
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('extension')
      .resolves([defaultServer, otherServer]);

    await expect(
      agentStopRuntime(assignmentManagerStub, {
        from: 'extension',
        label: defaultServer.label,
      }),
    ).to.eventually.be.rejectedWith('Ambiguous label');
  });

  it('returns runtime status for a specific endpoint selector', async () => {
    const unowned: UnownedServer = {
      label: 'remote-notebook',
      endpoint: 'm-s-remote',
      variant: Variant.GPU,
      accelerator: 'T4',
    };
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('all')
      .resolves({
        assigned: [defaultServer],
        unowned: [unowned],
      });
    assignmentManagerStub.latestServer.resolves(defaultServer);

    const result = await agentRuntimeStatus(assignmentManagerStub, {
      from: 'all',
      endpoint: 'm-s-runtime-a',
    });

    expect(result.selected).to.have.length(1);
    expect(result.selected[0].endpoint).to.equal('m-s-runtime-a');
    expect(result.latestAssigned?.id).to.equal(defaultServer.id);
  });
});

