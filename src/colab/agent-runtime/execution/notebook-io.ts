/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import path from 'path';

interface NotebookCodeCell {
  readonly cellIndex: number;
  readonly source: string;
}

interface NotebookFile {
  readonly cells?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notebookCellSourceToString(source: unknown): string {
  if (typeof source === 'string') {
    return source;
  }
  if (!Array.isArray(source)) {
    return '';
  }
  return source
    .filter((line): line is string => typeof line === 'string')
    .join('');
}

export function sourcePreview(source: string): string {
  const normalized = source.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return '<empty>';
  }
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export async function loadNotebookCodeCells(
  notebookPathArg: string,
): Promise<{ notebookPath: string; cells: readonly NotebookCodeCell[] }> {
  const notebookPath = path.resolve(notebookPathArg);
  let raw: string;
  try {
    raw = await fs.readFile(notebookPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read notebook file "${notebookPath}": ${String(error)}`,
    );
  }

  let parsed: NotebookFile;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) {
      throw new Error('Notebook document is not an object.');
    }
    parsed = value;
  } catch (error) {
    throw new Error(
      `Notebook file "${notebookPath}" is not valid JSON: ${String(error)}`,
    );
  }

  if (!Array.isArray(parsed.cells)) {
    throw new Error(`Notebook file "${notebookPath}" does not contain a "cells" array.`);
  }

  const codeCells: NotebookCodeCell[] = [];
  parsed.cells.forEach((cell, index) => {
    if (!isRecord(cell) || cell.cell_type !== 'code') {
      return;
    }
    codeCells.push({
      cellIndex: index,
      source: notebookCellSourceToString(cell.source),
    });
  });

  return {
    notebookPath,
    cells: codeCells,
  };
}
