/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssignmentManager } from '../../jupyter/assignments';
import {
  ColabAssignedServer,
  isColabAssignedServer,
  UnownedServer,
} from '../../jupyter/servers';
import {
  AgentRuntimeRecord,
  AgentRuntimeScope,
  AgentRuntimeSelection,
  NotebookRuntimeSelectionArgs,
} from './types';
import { normalizeString } from './validation';

export interface ScopedServers {
  readonly assigned: readonly ColabAssignedServer[];
  readonly unowned: readonly UnownedServer[];
}

export function resolveScope(from?: AgentRuntimeScope | string): AgentRuntimeScope {
  if (from === undefined) {
    return 'all';
  }
  if (from === 'extension' || from === 'external' || from === 'all') {
    return from;
  }
  throw new Error('Invalid "from" value. Use extension, external, or all.');
}

export function toRuntimeRecord(
  server: ColabAssignedServer | UnownedServer,
): AgentRuntimeRecord {
  if (!isColabAssignedServer(server)) {
    return {
      owner: 'external',
      label: server.label,
      endpoint: server.endpoint,
      variant: server.variant,
      accelerator: server.accelerator,
      shape: server.shape,
      version: server.version,
    };
  }

  return {
    owner: 'extension',
    id: server.id,
    label: server.label,
    endpoint: server.endpoint,
    variant: server.variant,
    accelerator: server.accelerator,
    shape: server.shape,
    version: server.version,
    dateAssigned: server.dateAssigned.toISOString(),
    baseUrl: server.connectionInformation.baseUrl.toString(),
    tokenExpiry: server.connectionInformation.tokenExpiry.toISOString(),
  };
}

export async function getScopedServers(
  assignmentManager: AssignmentManager,
  scope: AgentRuntimeScope,
): Promise<ScopedServers> {
  switch (scope) {
    case 'extension':
      return {
        assigned: await assignmentManager.getServers('extension'),
        unowned: [],
      };
    case 'external':
      return {
        assigned: [],
        unowned: await assignmentManager.getServers('external'),
      };
    default: {
      const all = await assignmentManager.getServers('all');
      return {
        assigned: all.assigned,
        unowned: all.unowned,
      };
    }
  }
}

export function getAllScopedServers(
  servers: ScopedServers,
): readonly (ColabAssignedServer | UnownedServer)[] {
  return [...servers.assigned, ...servers.unowned];
}

export function selectServers(
  servers: readonly (ColabAssignedServer | UnownedServer)[],
  selection: AgentRuntimeSelection,
): readonly (ColabAssignedServer | UnownedServer)[] {
  if (selection.all) {
    return servers;
  }
  if (selection.id) {
    return servers.filter(
      (s): s is ColabAssignedServer =>
        isColabAssignedServer(s) && s.id === selection.id,
    );
  }
  if (selection.endpoint) {
    return servers.filter((s) => s.endpoint === selection.endpoint);
  }
  if (selection.label) {
    return servers.filter((s) => s.label === selection.label);
  }
  return [];
}

export function normalizeSelection(
  args: AgentRuntimeSelection,
): {
  readonly id?: string;
  readonly endpoint?: string;
  readonly label?: string;
  readonly all: boolean;
} {
  return {
    id: normalizeString(args.id),
    endpoint: normalizeString(args.endpoint),
    label: normalizeString(args.label),
    all: Boolean(args.all),
  };
}

export async function selectExecutionServer(
  assignmentManager: AssignmentManager,
  args: NotebookRuntimeSelectionArgs,
  methodName: string,
): Promise<ColabAssignedServer> {
  if (args.from === 'external') {
    throw new Error(
      `${methodName} only supports extension-assigned runtimes (from=extension|all).`,
    );
  }

  const assigned =
    args.from === 'all'
      ? (await assignmentManager.getServers('all')).assigned
      : await assignmentManager.getServers('extension');

  if (assigned.length === 0) {
    throw new Error(
      'No extension-assigned runtimes available. Start or attach a runtime first.',
    );
  }

  let selected = assigned;
  if (args.id) {
    selected = assigned.filter((runtime) => runtime.id === args.id);
  } else if (args.endpoint) {
    selected = assigned.filter((runtime) => runtime.endpoint === args.endpoint);
  } else if (args.label) {
    selected = assigned.filter((runtime) => runtime.label === args.label);
  } else {
    const latest = await assignmentManager.latestServer();
    if (!latest) {
      throw new Error('No extension-assigned runtime is currently available.');
    }
    return latest;
  }

  if (selected.length === 0) {
    throw new Error('No matching extension-assigned runtime was found.');
  }
  if (selected.length > 1) {
    throw new Error('Runtime selection is ambiguous. Select by "id" or "endpoint".');
  }
  return selected[0];
}
