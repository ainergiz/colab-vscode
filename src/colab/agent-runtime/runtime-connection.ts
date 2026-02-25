/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssignmentManager } from '../../jupyter/assignments';
import { ColabAssignedServer } from '../../jupyter/servers';

const CONNECTION_REFRESH_SKEW_MS = 30_000;

export function shouldRefreshRuntimeConnection(
  runtime: ColabAssignedServer,
  nowMs = Date.now(),
): boolean {
  return (
    runtime.connectionInformation.tokenExpiry.getTime() <=
    nowMs + CONNECTION_REFRESH_SKEW_MS
  );
}

export async function ensureFreshRuntimeConnection(
  assignmentManager: AssignmentManager,
  runtime: ColabAssignedServer,
): Promise<ColabAssignedServer> {
  if (!shouldRefreshRuntimeConnection(runtime)) {
    return runtime;
  }
  return await assignmentManager.refreshConnection(runtime.id);
}
