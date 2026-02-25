/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { JupyterClient } from '../../jupyter/client';

export function normalizeRuntimePath(rawPath: string, fieldName: string): string {
  const trimmed = rawPath.trim().replaceAll('\\', '/');
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty path.`);
  }
  if (trimmed === '/') {
    return trimmed;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function normalizeRuntimeFilePath(rawPath: string, fieldName: string): string {
  const runtimePath = normalizeRuntimePath(rawPath, fieldName);
  if (runtimePath.endsWith('/')) {
    throw new Error(`${fieldName} must point to a file, not a directory.`);
  }
  return runtimePath;
}

export async function ensureRuntimeDirectory(
  client: JupyterClient,
  directoryPath: string,
): Promise<void> {
  const normalized = normalizeRuntimePath(directoryPath, 'directoryPath');
  if (normalized === '/') {
    return;
  }

  const parts = normalized.split('/').filter((part) => part.length > 0);
  let current = '';
  for (const part of parts) {
    current = `${current}/${part}`;
    try {
      await client.contents.save({
        path: current,
        model: {
          type: 'directory',
        },
      });
    } catch (saveError) {
      try {
        const existing = await client.contents.get({
          path: current,
          content: 0,
        });
        if (existing.type === 'directory') {
          continue;
        }
      } catch (_lookupError) {
        // Preserve original save error for clearer context.
      }
      throw saveError;
    }
  }
}

export async function writeTextFileToRuntime(
  client: JupyterClient,
  runtimePath: string,
  text: string,
  createDirectories: boolean,
): Promise<void> {
  const normalizedPath = normalizeRuntimeFilePath(runtimePath, 'runtimePath');
  if (createDirectories) {
    const parent = path.posix.dirname(normalizedPath);
    if (parent !== '.' && parent !== '/') {
      await ensureRuntimeDirectory(client, parent);
    }
  }

  await client.contents.save({
    path: normalizedPath,
    model: {
      type: 'file',
      format: 'text',
      content: text,
    },
  });
}
