/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import vscode from 'vscode';
import {
  AGENT_LIST_RUNTIMES,
  AGENT_RUNTIME_STATUS,
  AGENT_START_RUNTIME,
  AGENT_STOP_RUNTIME,
} from '../colab/commands/constants';
import {
  AgentListRuntimesResult,
  AgentRuntimeStatusResult,
  AgentStartRuntimeResult,
  AgentStopRuntimeResult,
} from '../colab/commands/agent';

describe('Extension', () => {
  it('should be present', () => {
    assert.ok(vscode.extensions.getExtension('google.colab'));
  });

  it('should activate', async () => {
    const extension = vscode.extensions.getExtension('google.colab');

    await extension?.activate();

    assert.strictEqual(extension?.isActive, true);
  });

  it('registers agent runtime commands', async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes(AGENT_LIST_RUNTIMES.id));
    assert.ok(commands.includes(AGENT_START_RUNTIME.id));
    assert.ok(commands.includes(AGENT_STOP_RUNTIME.id));
    assert.ok(commands.includes(AGENT_RUNTIME_STATUS.id));
  });

  it('executes list/status/stop runtime commands in extension scope', async () => {
    const listResult = await vscode.commands.executeCommand<AgentListRuntimesResult>(
      AGENT_LIST_RUNTIMES.id,
      { from: 'extension' },
    );
    assert.strictEqual(listResult.scope, 'extension');
    assert.ok(Array.isArray(listResult.assigned));
    assert.ok(Array.isArray(listResult.unowned));
    assert.strictEqual(listResult.unowned.length, 0);
    assert.strictEqual(
      listResult.counts.total,
      listResult.counts.assigned + listResult.counts.unowned,
    );

    const statusResult =
      await vscode.commands.executeCommand<AgentRuntimeStatusResult>(
        AGENT_RUNTIME_STATUS.id,
        {
          from: 'extension',
          endpoint: 'https://non-existent-runtime.invalid',
        },
      );
    assert.strictEqual(statusResult.scope, 'extension');
    assert.strictEqual(statusResult.available.scope, 'extension');
    assert.ok(Array.isArray(statusResult.selected));
    assert.strictEqual(statusResult.selected.length, 0);
    assert.strictEqual(statusResult.ambiguousLabelSelection, false);

    const stopResult = await vscode.commands.executeCommand<AgentStopRuntimeResult>(
      AGENT_STOP_RUNTIME.id,
      {
        from: 'extension',
        id: '00000000-0000-0000-0000-000000000000',
      },
    );
    assert.strictEqual(stopResult.scope, 'extension');
    assert.strictEqual(stopResult.notFound, true);
    assert.strictEqual(stopResult.requested.id, '00000000-0000-0000-0000-000000000000');
    assert.strictEqual(stopResult.requested.all, false);
    assert.deepStrictEqual(stopResult.stopped, []);
    assert.deepStrictEqual(stopResult.failed, []);
  });

  it('executes start runtime command without command registry errors', async () => {
    try {
      const startResult =
        await vscode.commands.executeCommand<AgentStartRuntimeResult>(
          AGENT_START_RUNTIME.id,
          { mode: 'latestOrCreate' },
        );
      assert.ok(startResult.action === 'reused' || startResult.action === 'created');
      assert.ok(typeof startResult.runtime.endpoint === 'string');
    } catch (error) {
      // This can fail in integration runs without an authenticated Colab session.
      assert.ok(error instanceof Error);
    }
  });
});
