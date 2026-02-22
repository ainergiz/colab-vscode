/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Shape, Variant } from '../api';
import { AssignmentManager } from '../../jupyter/assignments';
import {
  AllServers,
  ColabAssignedServer,
  ColabServerDescriptor,
  isColabAssignedServer,
  UnownedServer,
} from '../../jupyter/servers';

type AgentRuntimeScope = 'extension' | 'external' | 'all';
type AgentStartMode = 'latestOrCreate' | 'new';

interface AgentRuntimeSelection {
  id?: string;
  endpoint?: string;
  label?: string;
  all?: boolean;
}

export interface AgentRuntimeRecord {
  readonly owner: 'extension' | 'external';
  readonly id?: string;
  readonly label: string;
  readonly endpoint: string;
  readonly variant: Variant;
  readonly accelerator?: string;
  readonly shape?: Shape;
  readonly version?: string;
  readonly dateAssigned?: string;
  readonly baseUrl?: string;
  readonly tokenExpiry?: string;
}

export interface AgentListRuntimesArgs {
  readonly from?: AgentRuntimeScope;
}

export interface AgentListRuntimesResult {
  readonly scope: AgentRuntimeScope;
  readonly assigned: readonly AgentRuntimeRecord[];
  readonly unowned: readonly AgentRuntimeRecord[];
  readonly counts: {
    readonly assigned: number;
    readonly unowned: number;
    readonly total: number;
  };
}

export interface AgentStartRuntimeArgs {
  readonly mode?: AgentStartMode;
  readonly label?: string;
  readonly variant?: Variant | string;
  readonly accelerator?: string;
  readonly shape?: Shape | number | string;
  readonly version?: string;
}

export interface AgentStartRuntimeResult {
  readonly mode: AgentStartMode;
  readonly action: 'reused' | 'created';
  readonly runtime: AgentRuntimeRecord;
}

export interface AgentStopRuntimeArgs extends AgentRuntimeSelection {
  readonly from?: AgentRuntimeScope;
}

export interface AgentStopRuntimeResult {
  readonly scope: AgentRuntimeScope;
  readonly requested: {
    readonly id?: string;
    readonly endpoint?: string;
    readonly label?: string;
    readonly all: boolean;
  };
  readonly stopped: readonly AgentRuntimeRecord[];
  readonly failed: readonly { target: AgentRuntimeRecord; error: string }[];
  readonly notFound: boolean;
}

export interface AgentRuntimeStatusArgs extends AgentRuntimeSelection {
  readonly from?: AgentRuntimeScope;
}

export interface AgentRuntimeStatusResult {
  readonly scope: AgentRuntimeScope;
  readonly available: AgentListRuntimesResult;
  readonly selected: readonly AgentRuntimeRecord[];
  readonly latestAssigned?: AgentRuntimeRecord;
  readonly ambiguousLabelSelection: boolean;
}

interface ScopedServers {
  readonly assigned: readonly ColabAssignedServer[];
  readonly unowned: readonly UnownedServer[];
}

function resolveScope(from?: AgentRuntimeScope): AgentRuntimeScope {
  return from ?? 'all';
}

function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAccelerator(value: string | undefined): string | undefined {
  const normalized = normalizeString(value);
  return normalized?.toUpperCase();
}

function normalizeVariant(value: Variant | string | undefined): Variant | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === Variant.DEFAULT || value === Variant.GPU || value === Variant.TPU) {
    return value;
  }
  const normalized = value.toUpperCase();
  switch (normalized) {
    case Variant.DEFAULT:
    case Variant.GPU:
    case Variant.TPU:
      return normalized;
    default:
      return undefined;
  }
}

function normalizeShape(value: Shape | number | string | undefined): Shape | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === Shape.STANDARD || value === Shape.HIGHMEM) {
    return value;
  }
  if (typeof value === 'number') {
    return value === Shape.STANDARD || value === Shape.HIGHMEM
      ? value
      : undefined;
  }
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case 'STANDARD':
      return Shape.STANDARD;
    case 'HIGHMEM':
      return Shape.HIGHMEM;
    case '0':
      return Shape.STANDARD;
    case '1':
      return Shape.HIGHMEM;
    default:
      return undefined;
  }
}

function toRuntimeRecord(
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

async function getScopedServers(
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
      const all = (await assignmentManager.getServers('all')) as AllServers;
      return {
        assigned: all.assigned,
        unowned: all.unowned,
      };
    }
  }
}

function getAllScopedServers(
  servers: ScopedServers,
): readonly (ColabAssignedServer | UnownedServer)[] {
  return [...servers.assigned, ...servers.unowned];
}

function selectServers(
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function normalizeSelection(
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

function shouldCreateNewRuntime(args: AgentStartRuntimeArgs): boolean {
  return (
    args.label !== undefined ||
    args.variant !== undefined ||
    args.accelerator !== undefined ||
    args.shape !== undefined ||
    args.version !== undefined
  );
}

async function toDescriptor(
  assignmentManager: AssignmentManager,
  args: AgentStartRuntimeArgs,
): Promise<ColabServerDescriptor> {
  const variant = normalizeVariant(args.variant) ?? Variant.DEFAULT;
  const accelerator = normalizeAccelerator(args.accelerator);
  const shape = normalizeShape(args.shape);
  const version = normalizeString(args.version);
  const label =
    normalizeString(args.label) ??
    (await assignmentManager.getDefaultLabel(variant, accelerator));

  return {
    label,
    variant,
    ...(accelerator ? { accelerator } : {}),
    ...(shape !== undefined ? { shape } : {}),
    ...(version ? { version } : {}),
  };
}

export async function agentListRuntimes(
  assignmentManager: AssignmentManager,
  args: AgentListRuntimesArgs = {},
): Promise<AgentListRuntimesResult> {
  const scope = resolveScope(args.from);
  const scoped = await getScopedServers(assignmentManager, scope);
  const assigned = scoped.assigned.map(toRuntimeRecord);
  const unowned = scoped.unowned.map(toRuntimeRecord);
  const total = assigned.length + unowned.length;
  return {
    scope,
    assigned,
    unowned,
    counts: {
      assigned: assigned.length,
      unowned: unowned.length,
      total,
    },
  };
}

export async function agentStartRuntime(
  assignmentManager: AssignmentManager,
  args: AgentStartRuntimeArgs = {},
): Promise<AgentStartRuntimeResult> {
  const mode =
    args.mode ?? (shouldCreateNewRuntime(args) ? 'new' : 'latestOrCreate');

  if (mode === 'latestOrCreate') {
    const latest = await assignmentManager.latestServer();
    if (latest) {
      return {
        mode,
        action: 'reused',
        runtime: toRuntimeRecord(latest),
      };
    }
    const created = await assignmentManager.latestOrAutoAssignServer();
    return {
      mode,
      action: 'created',
      runtime: toRuntimeRecord(created),
    };
  }

  const descriptor = await toDescriptor(assignmentManager, args);
  const created = await assignmentManager.assignServer(descriptor);
  return {
    mode,
    action: 'created',
    runtime: toRuntimeRecord(created),
  };
}

export async function agentStopRuntime(
  assignmentManager: AssignmentManager,
  args: AgentStopRuntimeArgs = {},
): Promise<AgentStopRuntimeResult> {
  const scope = resolveScope(args.from ?? 'extension');
  const requested = normalizeSelection(args);
  const scoped = await getScopedServers(assignmentManager, scope);
  const allScoped = getAllScopedServers(scoped);

  let selected = selectServers(allScoped, requested);

  if (
    !requested.all &&
    !requested.id &&
    !requested.endpoint &&
    !requested.label &&
    scope === 'extension'
  ) {
    const latest = await assignmentManager.latestServer();
    selected = latest ? [latest] : [];
  }

  if (
    requested.label &&
    !requested.id &&
    !requested.endpoint &&
    selected.length > 1
  ) {
    throw new Error(
      `Ambiguous label "${requested.label}" matched ${selected.length.toString()} runtimes. Use endpoint or id.`,
    );
  }

  if (selected.length === 0) {
    return {
      scope,
      requested,
      stopped: [],
      failed: [],
      notFound: true,
    };
  }

  const stopped: AgentRuntimeRecord[] = [];
  const failed: { target: AgentRuntimeRecord; error: string }[] = [];
  for (const server of selected) {
    const runtime = toRuntimeRecord(server);
    try {
      await assignmentManager.unassignServer(server);
      stopped.push(runtime);
    } catch (error) {
      failed.push({ target: runtime, error: formatError(error) });
    }
  }

  return {
    scope,
    requested,
    stopped,
    failed,
    notFound: false,
  };
}

export async function agentRuntimeStatus(
  assignmentManager: AssignmentManager,
  args: AgentRuntimeStatusArgs = {},
): Promise<AgentRuntimeStatusResult> {
  const scope = resolveScope(args.from);
  const available = await agentListRuntimes(assignmentManager, { from: scope });
  const requested = normalizeSelection(args);
  const all = [...available.assigned, ...available.unowned];
  const selected = requested.all
    ? all
    : all.filter((runtime) => {
        if (requested.id) {
          return runtime.id === requested.id;
        }
        if (requested.endpoint) {
          return runtime.endpoint === requested.endpoint;
        }
        if (requested.label) {
          return runtime.label === requested.label;
        }
        return false;
      });

  const latestAssigned = await assignmentManager.latestServer();
  const ambiguousLabelSelection =
    requested.label !== undefined &&
    requested.id === undefined &&
    requested.endpoint === undefined &&
    selected.length > 1;

  return {
    scope,
    available,
    selected,
    latestAssigned: latestAssigned ? toRuntimeRecord(latestAssigned) : undefined,
    ambiguousLabelSelection,
  };
}
