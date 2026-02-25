/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssignmentManager } from '../../jupyter/assignments';
import { ProxiedJupyterClient } from '../../jupyter/client';
import {
  RuntimeFilesWriteTextArgs,
  RuntimeFilesWriteTextResult,
} from './types';
import {
  normalizeRuntimeFilePath,
  writeTextFileToRuntime,
} from './runtime-files';
import { ensureFreshRuntimeConnection } from './runtime-connection';
import { selectExecutionServer, toRuntimeRecord } from './runtime-selection';

export async function runtimeFilesWriteText(
  assignmentManager: AssignmentManager,
  rawArgs: RuntimeFilesWriteTextArgs,
): Promise<RuntimeFilesWriteTextResult> {
  let runtime = await selectExecutionServer(
    assignmentManager,
    rawArgs,
    'runtime.files.writeText',
  );
  runtime = await ensureFreshRuntimeConnection(assignmentManager, runtime);
  const runtimeRecord = toRuntimeRecord(runtime);
  const client = ProxiedJupyterClient.withStaticConnection(runtime);
  const runtimePath = normalizeRuntimeFilePath(rawArgs.runtimePath, 'runtimePath');
  const createDirectories = rawArgs.createDirectories ?? true;
  await writeTextFileToRuntime(client, runtimePath, rawArgs.text, createDirectories);

  return {
    runtime: runtimeRecord,
    runtimePath,
    bytes: Buffer.byteLength(rawArgs.text, 'utf8'),
  };
}
