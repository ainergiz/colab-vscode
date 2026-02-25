/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import { Variant } from '../api';
import { AssignmentManager } from '../../jupyter/assignments';
import { ColabAssignedServer } from '../../jupyter/servers';
import { newVsCodeStub, VsCodeStub } from '../../test/helpers/vscode';
import {
  ensureFreshRuntimeConnection,
  shouldRefreshRuntimeConnection,
} from './runtime-connection';

describe('Agent Runtime Connection', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let runtime: ColabAssignedServer;

  beforeEach(() => {
    vsCodeStub = newVsCodeStub();
    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
    runtime = {
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

  it('detects when a runtime connection should be refreshed', () => {
    const staleRuntime = {
      ...runtime,
      connectionInformation: {
        ...runtime.connectionInformation,
        tokenExpiry: new Date(Date.now() + 5_000),
      },
    };

    expect(shouldRefreshRuntimeConnection(staleRuntime)).to.equal(true);
    expect(shouldRefreshRuntimeConnection(runtime)).to.equal(false);
  });

  it('refreshes expiring runtime connections', async () => {
    const staleRuntime = {
      ...runtime,
      connectionInformation: {
        ...runtime.connectionInformation,
        tokenExpiry: new Date(Date.now() + 1_000),
      },
    };
    const refreshedRuntime = {
      ...staleRuntime,
      connectionInformation: {
        ...staleRuntime.connectionInformation,
        token: '456',
        tokenExpiry: new Date(Date.now() + 300_000),
      },
    };
    assignmentManagerStub.refreshConnection.resolves(refreshedRuntime);

    const result = await ensureFreshRuntimeConnection(
      assignmentManagerStub,
      staleRuntime,
    );

    expect(result.connectionInformation.token).to.equal('456');
    sinon.assert.calledOnceWithExactly(
      assignmentManagerStub.refreshConnection,
      staleRuntime.id,
    );
  });

  it('reuses runtime connection when token is still fresh', async () => {
    const result = await ensureFreshRuntimeConnection(
      assignmentManagerStub,
      runtime,
    );

    expect(result).to.equal(runtime);
    sinon.assert.notCalled(assignmentManagerStub.refreshConnection);
  });
});
