/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import {
  ConfigurationChangeEvent,
  WorkspaceConfiguration,
} from 'vscode';
import { AssignmentManager } from '../jupyter/assignments';
import { TestEventEmitter } from '../test/helpers/events';
import { newVsCodeStub, VsCodeStub } from '../test/helpers/vscode';
import { AgentBridgeController } from './agent-bridge-http';

interface BridgeSettings {
  enabled: boolean;
  host: string;
  allowRemoteHost: boolean;
  port: number;
  token: string;
  stateFile: string;
}

interface BridgeState {
  readonly endpoint: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
}

function lockFilePath(stateFilePath: string): string {
  return `${stateFilePath}.lock`;
}

function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function waitForPredicate(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for predicate.');
}

async function waitForBridgeState(
  stateFilePath: string,
  timeoutMs = 2_000,
): Promise<BridgeState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      if (
        typeof parsed.endpoint === 'string' &&
        typeof parsed.host === 'string' &&
        typeof parsed.port === 'number' &&
        typeof parsed.pid === 'number'
      ) {
        return parsed as BridgeState;
      }
    } catch (_error) {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for bridge state file: ${stateFilePath}`);
}

describe('Agent Bridge HTTP Controller', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let configChangeEmitter: TestEventEmitter<ConfigurationChangeEvent>;
  let settings: BridgeSettings;
  let controller: AgentBridgeController | undefined;

  beforeEach(() => {
    vsCodeStub = newVsCodeStub();
    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
    configChangeEmitter = new TestEventEmitter<ConfigurationChangeEvent>();
    vsCodeStub.workspace.onDidChangeConfiguration.callsFake(
      configChangeEmitter.event,
    );

    settings = {
      enabled: true,
      host: '127.0.0.1',
      allowRemoteHost: false,
      port: 0,
      token: 'test-agent-token',
      stateFile: path.join(
        os.tmpdir(),
        `colab-agent-bridge-state-${randomUUID()}.json`,
      ),
    };

    const workspaceConfig = {
      get: <T>(section: string, defaultValue: T): T => {
        const value = (settings as unknown as Record<string, unknown>)[section];
        if (value === undefined) {
          return defaultValue;
        }
        return value as T;
      },
    } as Pick<WorkspaceConfiguration, 'get'> as WorkspaceConfiguration;

    vsCodeStub.workspace.getConfiguration
      .withArgs('colab.agentBridge')
      .returns(workspaceConfig);
  });

  afterEach(async () => {
    if (controller) {
      controller.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller = undefined;
    }
    await fs.rm(settings.stateFile, { force: true });
    await fs.rm(lockFilePath(settings.stateFile), { force: true });
    sinon.restore();
  });

  it('serves authorized bridge requests', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'req-1',
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly status: string };
    };
    expect(body.ok).to.equal(true);
    expect(body.result.status).to.equal('ok');
  });

  it('serves health endpoint without authorization', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);
    const healthEndpoint = state.endpoint.replace('/v1/colab-agent', '/healthz');

    const response = await fetch(healthEndpoint);

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly status: string };
    };
    expect(body.ok).to.equal(true);
    expect(body.result.status).to.equal('ok');
  });

  it('supports query parameters for the bridge endpoint', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(`${state.endpoint}?trace=1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly status: string };
    };
    expect(body.ok).to.equal(true);
    expect(body.result.status).to.equal('ok');
  });

  it('returns 401 when token is missing', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(401);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly name: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.name).to.equal('UnauthorizedError');
  });

  it('returns 415 for non-json content type', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'text/plain',
      },
      body: '{"method":"ping"}',
    });

    expect(response.status).to.equal(415);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly name: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.name).to.equal('UnsupportedMediaTypeError');
  });

  it('returns 404 for unknown endpoints', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);
    const unknownEndpoint = state.endpoint.replace(
      '/v1/colab-agent',
      '/v1/not-found',
    );

    const response = await fetch(unknownEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(404);
  });

  it('returns 405 for OPTIONS requests', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'OPTIONS',
    });

    expect(response.status).to.equal(405);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code?: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.code).to.equal('METHOD_NOT_ALLOWED');
  });

  it('returns 413 when request payload exceeds limit', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);
    const oversizedPayload = 'x'.repeat(1024 * 1024);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
        params: {
          oversizedPayload,
        },
      }),
    });

    expect(response.status).to.equal(413);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code?: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.code).to.equal('PAYLOAD_TOO_LARGE');
  });

  it('returns stable error codes for RPC failures', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'unsupported-method',
      }),
    });

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code?: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.code).to.equal('UNSUPPORTED_METHOD');
  });

  it('refuses to start when token is empty', async () => {
    settings.token = '';
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );

    await waitForPredicate(() =>
      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
    );
    expect(await exists(settings.stateFile)).to.equal(false);
  });

  it('blocks non-loopback host unless allowRemoteHost is enabled', async () => {
    settings.host = '0.0.0.0';
    settings.allowRemoteHost = false;
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );

    await waitForPredicate(() =>
      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
    );
    expect(await exists(settings.stateFile)).to.equal(false);
  });

  it('blocks wildcard host even when allowRemoteHost is enabled', async () => {
    settings.host = '0.0.0.0';
    settings.allowRemoteHost = true;
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );

    await waitForPredicate(() =>
      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
    );
    expect(await exists(settings.stateFile)).to.equal(false);
  });

  it('does not start when lock is held by another live process', async () => {
    await fs.writeFile(
      lockFilePath(settings.stateFile),
      `${JSON.stringify(
        {
          pid: process.pid,
          instanceId: 'another-live-instance',
          startedAt: new Date().toISOString(),
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await exists(settings.stateFile)).to.equal(false);
    expect(await exists(lockFilePath(settings.stateFile))).to.equal(true);
  });

  it('reclaims stale lock and starts successfully', async () => {
    await fs.writeFile(
      lockFilePath(settings.stateFile),
      `${JSON.stringify(
        {
          pid: 999_999,
          instanceId: 'stale-instance',
          startedAt: new Date().toISOString(),
        },
        undefined,
        2,
      )}\n`,
      'utf8',
    );

    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    expect(state.pid).to.equal(process.pid);
    const rawLock = await fs.readFile(lockFilePath(settings.stateFile), 'utf8');
    const parsedLock = JSON.parse(rawLock) as { pid: number; instanceId: string };
    expect(parsedLock.pid).to.equal(process.pid);
    expect(parsedLock.instanceId).to.not.equal('stale-instance');
  });

  it('removes lock file when owned on shutdown', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    await waitForBridgeState(settings.stateFile);
    expect(await exists(lockFilePath(settings.stateFile))).to.equal(true);

    controller.dispose();
    controller = undefined;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await exists(lockFilePath(settings.stateFile))).to.equal(false);
  });

  it('keeps state file when ownership does not match on shutdown', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    await fs.writeFile(
      settings.stateFile,
      `${JSON.stringify({ ...state, pid: state.pid + 1 }, undefined, 2)}\n`,
      'utf8',
    );

    controller.dispose();
    controller = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await exists(settings.stateFile)).to.equal(true);
  });
});
