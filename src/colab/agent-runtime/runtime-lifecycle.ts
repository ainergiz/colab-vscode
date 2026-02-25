/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Variant } from '../api';
import { AssignmentManager } from '../../jupyter/assignments';
import { ColabServerDescriptor } from '../../jupyter/servers';
import {
  AgentListRuntimesArgs,
  AgentListRuntimesResult,
  AgentRuntimeOptionRecord,
  AgentRuntimeOptionsArgs,
  AgentRuntimeOptionsResult,
  AgentRuntimeRecord,
  AgentRuntimeStatusArgs,
  AgentRuntimeStatusResult,
  AgentStartMode,
  AgentStartRuntimeArgs,
  AgentStartRuntimeResult,
  AgentStopRuntimeArgs,
  AgentStopRuntimeResult,
} from './types';
import {
  getAllScopedServers,
  getScopedServers,
  normalizeSelection,
  resolveScope,
  selectServers,
  toRuntimeRecord,
} from './runtime-selection';
import {
  normalizeAccelerator,
  normalizeShape,
  normalizeString,
  normalizeVariant,
  shouldCreateNewRuntime,
} from './validation';

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function toRuntimeOptionRecord(
  descriptor: ColabServerDescriptor,
): AgentRuntimeOptionRecord {
  return {
    label: descriptor.label,
    variant: descriptor.variant,
    accelerator: descriptor.accelerator,
    shape: descriptor.shape,
    version: descriptor.version,
  };
}

function toRuntimeOptionsResult(
  descriptors: readonly ColabServerDescriptor[],
): AgentRuntimeOptionsResult {
  const options = descriptors.map(toRuntimeOptionRecord);
  const byVariant = {
    DEFAULT: 0,
    GPU: 0,
    TPU: 0,
  };
  for (const option of options) {
    byVariant[option.variant] += 1;
  }

  return {
    options,
    counts: {
      total: options.length,
      byVariant,
    },
  };
}

function descriptorKey(descriptor: ColabServerDescriptor): string {
  const accelerator = (
    descriptor.accelerator ??
    (descriptor.variant === Variant.DEFAULT ? 'NONE' : '')
  ).toUpperCase();
  return [
    descriptor.variant,
    accelerator,
    descriptor.shape?.toString() ?? '',
  ].join('|');
}

function uniqueDescriptors(
  descriptors: readonly ColabServerDescriptor[],
): ColabServerDescriptor[] {
  const deduped = new Map<string, ColabServerDescriptor>();
  for (const descriptor of descriptors) {
    const key = descriptorKey(descriptor);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, descriptor);
      continue;
    }
    deduped.set(key, {
      label: existing.label,
      variant: existing.variant,
      accelerator: existing.accelerator ?? descriptor.accelerator,
      shape: existing.shape ?? descriptor.shape,
      version: existing.version ?? descriptor.version,
    });
  }
  return [...deduped.values()];
}

async function listRuntimeOptionsFallback(
  assignmentManager: AssignmentManager,
): Promise<readonly ColabServerDescriptor[]> {
  const catalog: ColabServerDescriptor[] = [
    {
      label: 'Colab CPU',
      variant: Variant.DEFAULT,
      accelerator: 'NONE',
      version: 'latest',
    },
    {
      label: 'Colab GPU H100',
      variant: Variant.GPU,
      accelerator: 'H100',
      version: 'latest',
    },
    {
      label: 'Colab GPU A100',
      variant: Variant.GPU,
      accelerator: 'A100',
      version: 'latest',
    },
    {
      label: 'Colab GPU L4',
      variant: Variant.GPU,
      accelerator: 'L4',
      version: 'latest',
    },
    {
      label: 'Colab GPU T4',
      variant: Variant.GPU,
      accelerator: 'T4',
      version: 'latest',
    },
    {
      label: 'Colab TPU v6e-1',
      variant: Variant.TPU,
      accelerator: 'V6E-1',
      version: 'latest',
    },
    {
      label: 'Colab TPU v5e-1',
      variant: Variant.TPU,
      accelerator: 'V5E-1',
      version: 'latest',
    },
  ];

  try {
    const all = await assignmentManager.getServers('all');
    const fromKnownRuntimes = uniqueDescriptors(
      [...all.assigned, ...all.unowned].map((runtime) => ({
        label: runtime.label,
        variant: runtime.variant,
        accelerator: runtime.accelerator,
        shape: runtime.shape,
        version: runtime.version,
      })),
    );
    return uniqueDescriptors([...fromKnownRuntimes, ...catalog]);
  } catch {
    // Keep fallback behavior deterministic; we still return a safe default below.
  }
  return catalog;
}

async function toDescriptor(
  assignmentManager: AssignmentManager,
  args: AgentStartRuntimeArgs,
): Promise<ColabServerDescriptor> {
  const normalizedVariant = normalizeVariant(args.variant);
  if (args.variant !== undefined && normalizedVariant === undefined) {
    throw new Error('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
  }
  const variant = normalizedVariant ?? Variant.DEFAULT;
  const accelerator = normalizeAccelerator(args.accelerator);
  const shape = normalizeShape(args.shape);
  if (args.shape !== undefined && shape === undefined) {
    throw new Error('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }
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

export async function listRuntimes(
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

export async function listRuntimeOptions(
  assignmentManager: AssignmentManager,
  _args: AgentRuntimeOptionsArgs = {},
): Promise<AgentRuntimeOptionsResult> {
  try {
    const descriptors = await assignmentManager.getAvailableServerDescriptors();
    return toRuntimeOptionsResult(descriptors);
  } catch {
    const fallbackDescriptors = await listRuntimeOptionsFallback(
      assignmentManager,
    );
    return toRuntimeOptionsResult(fallbackDescriptors);
  }
}

export async function startRuntime(
  assignmentManager: AssignmentManager,
  args: AgentStartRuntimeArgs = {},
): Promise<AgentStartRuntimeResult> {
  const rawMode =
    args.mode ?? (shouldCreateNewRuntime(args) ? 'new' : 'latestOrCreate');
  if (rawMode !== 'latestOrCreate' && rawMode !== 'new') {
    throw new Error('Invalid "mode" value. Use "latestOrCreate" or "new".');
  }
  const mode: AgentStartMode = rawMode;

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

export async function stopRuntime(
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

export async function runtimeStatus(
  assignmentManager: AssignmentManager,
  args: AgentRuntimeStatusArgs = {},
): Promise<AgentRuntimeStatusResult> {
  const scope = resolveScope(args.from);
  const available = await listRuntimes(assignmentManager, { from: scope });
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
