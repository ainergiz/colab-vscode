/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssignmentManager } from '../../jupyter/assignments';
import {
  AgentListRuntimesArgs,
  AgentListRuntimesResult,
  AgentRuntimeOptionsArgs,
  AgentRuntimeOptionsResult,
  AgentRuntimeService,
  AgentRuntimeStatusArgs,
  AgentRuntimeStatusResult,
  AgentStartRuntimeArgs,
  AgentStartRuntimeResult,
  AgentStopRuntimeArgs,
  AgentStopRuntimeResult,
  AgentRuntimeRecord,
  AgentRuntimeScope,
  AgentStartMode,
} from '../agent-runtime-service';

function createAgentRuntimeService(
  assignmentManager: AssignmentManager,
): AgentRuntimeService {
  return new AgentRuntimeService(assignmentManager);
}

export async function agentListRuntimes(
  assignmentManager: AssignmentManager,
  args: AgentListRuntimesArgs = {},
): Promise<AgentListRuntimesResult> {
  return await createAgentRuntimeService(assignmentManager).listRuntimes(args);
}

export async function agentListRuntimeOptions(
  assignmentManager: AssignmentManager,
  args: AgentRuntimeOptionsArgs = {},
): Promise<AgentRuntimeOptionsResult> {
  return await createAgentRuntimeService(assignmentManager).listRuntimeOptions(
    args,
  );
}

export async function agentStartRuntime(
  assignmentManager: AssignmentManager,
  args: AgentStartRuntimeArgs = {},
): Promise<AgentStartRuntimeResult> {
  return await createAgentRuntimeService(assignmentManager).startRuntime(args);
}

export async function agentStopRuntime(
  assignmentManager: AssignmentManager,
  args: AgentStopRuntimeArgs = {},
): Promise<AgentStopRuntimeResult> {
  return await createAgentRuntimeService(assignmentManager).stopRuntime(args);
}

export async function agentRuntimeStatus(
  assignmentManager: AssignmentManager,
  args: AgentRuntimeStatusArgs = {},
): Promise<AgentRuntimeStatusResult> {
  return await createAgentRuntimeService(assignmentManager).runtimeStatus(args);
}

export type {
  AgentListRuntimesArgs,
  AgentListRuntimesResult,
  AgentRuntimeOptionsArgs,
  AgentRuntimeOptionsResult,
  AgentRuntimeRecord,
  AgentRuntimeScope,
  AgentRuntimeStatusArgs,
  AgentRuntimeStatusResult,
  AgentStartMode,
  AgentStartRuntimeArgs,
  AgentStartRuntimeResult,
  AgentStopRuntimeArgs,
  AgentStopRuntimeResult,
};
