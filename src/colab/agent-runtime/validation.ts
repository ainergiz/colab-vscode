/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Shape, Variant } from '../api';
import { MAX_NOTEBOOK_EXECUTION_TIMEOUT_MS } from './constants';
import { AgentStartRuntimeArgs } from './types';

export function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeAccelerator(value: string | undefined): string | undefined {
  const normalized = normalizeString(value);
  return normalized?.toUpperCase();
}

export function normalizeVariant(
  value: Variant | string | undefined,
): Variant | undefined {
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

export function normalizeShape(
  value: Shape | number | string | undefined,
): Shape | undefined {
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

export function shouldCreateNewRuntime(args: AgentStartRuntimeArgs): boolean {
  return (
    args.label !== undefined ||
    args.variant !== undefined ||
    args.accelerator !== undefined ||
    args.shape !== undefined ||
    args.version !== undefined
  );
}

export function validateTimeoutMs(
  value: number | undefined,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer.`);
  }
  if (value <= 0 || value > MAX_NOTEBOOK_EXECUTION_TIMEOUT_MS) {
    throw new Error(
      `${fieldName} must be in the range 1..${MAX_NOTEBOOK_EXECUTION_TIMEOUT_MS.toString()}.`,
    );
  }
  return value;
}
