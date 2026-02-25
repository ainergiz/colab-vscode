/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_NOTEBOOK_EXECUTION_TIMEOUT_MS = 90_000;
export const MAX_NOTEBOOK_EXECUTION_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_RUNTIME_HF_TOKEN_PATH = '/content/.agent-secrets/hf_token';
export const DEFAULT_RUNTIME_HF_STARTUP_PATH =
  '/root/.ipython/profile_default/startup/00_agent_hf_token.py';
export const DEFAULT_RUNTIME_HF_HOME_TOKEN_PATH = '/root/.huggingface/token';
export const DEFAULT_RUNTIME_HF_CACHE_TOKEN_PATH = '/root/.cache/huggingface/token';
