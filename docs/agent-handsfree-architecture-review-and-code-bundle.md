# Agent Hands-Free Architecture Review + Code Bundle

Date: 2026-02-23 22:37:16 UTC
Repo: `voice-browser-control/colab-vscode`
Head: `f0b65ca`
Base: `upstream/main` at `72b0e8c`

## 1) Principal Architecture Assessment

Target architecture remains correct: **core service + thin transport adapters**.

1. Core behavior is centralized in `src/colab/agent-runtime/*`.
2. VS Code commands remain an adapter (`src/colab/commands/agent.ts`).
3. Bridge transport is split into HTTP controller (`src/colab/agent-bridge-http.ts`) and RPC dispatch/validation (`src/colab/agent-bridge-rpc.ts`).
4. Compatibility export surface is preserved (`src/colab/agent-bridge.ts`).

## 2) Security/Reliability Hardening Added

1. Bridge refuses to start when token is empty.
2. Loopback-only host policy by default; non-loopback requires `colab.agentBridge.allowRemoteHost=true`.
3. Wildcard bind hosts `0.0.0.0` and `::` are rejected.
4. JSON content-type enforcement (`415` for non-JSON requests).
5. Oversized request body handling returns `413` with stable error code.
6. HTTP timeout hardening for long notebook runs (request/response/headers timeouts disabled for bridge server).
7. State-file lifecycle hardened with ownership checks (pid/port match) before deletion and best-effort `0600` permissions.
8. Runtime connection refresh path added for expiring Colab proxy tokens.
9. Kernel channels URL construction fixed for base paths; WS headers now merge runtime connection headers.
10. Bridge lifecycle RPC validation tightened (strict parsing for scope/mode/variant/shape).
11. Optional string fields in RPC are strictly typed; wrong types now fail fast.
12. Stable RPC error codes introduced (e.g. `INVALID_PARAMS`, `UNSUPPORTED_METHOD`).
13. `notebook.runAll` local `saveResultPath` removed from bridge contract to eliminate local file-write primitive.

## 3) Output Contract Simplification

Bridge execution methods now support an agent-first output envelope:

1. New params for `notebook.execute` and `notebook.runAll`:
   - `outputMode`: `compact` (default) or `raw`
   - `render`: `markdown` (default) or `none`
2. `compact` output focuses on:
   - per-cell `ok` / `status`
   - per-cell merged `logs`
   - concise `error` object when present
3. `markdown` render adds `summaryMarkdown` for human-readable review while keeping JSON canonical for agents.
4. `raw` mode preserves prior rich Jupyter payloads (outputs/reply), optionally with markdown summary.

## 4) Working Tree Snapshot

```text
 M package.json
 M src/colab/commands/agent.ts
 M src/extension.ts
?? docs/agent-handsfree-architecture-review-and-code-bundle.md
?? docs/agent-runtime-bridge-modification-report.md
?? docs/agent-runtime-service-refactor-notes.md
?? scripts/colab-agent-bridge.mts
?? src/colab/agent-bridge-format.ts
?? src/colab/agent-bridge-format.unit.test.ts
?? src/colab/agent-bridge-http.ts
?? src/colab/agent-bridge-http.unit.test.ts
?? src/colab/agent-bridge-rpc.ts
?? src/colab/agent-bridge.ts
?? src/colab/agent-bridge.unit.test.ts
?? src/colab/agent-runtime-service.ts
?? src/colab/agent-runtime/
?? tmp/
```

## 5) Validation Snapshot

Executed successfully in this workspace:

1. `npm run typecheck`
2. `npm run test:unit -- --grep "Agent Bridge Output Formatter|Agent Bridge HTTP Controller|Agent Bridge|Agent Runtime Service|Agent Runtime Connection"`
3. `npm run test:unit` (full suite, passing)

## 6) Added/Expanded Tests

1. `src/colab/agent-bridge-format.unit.test.ts` for compact/raw/markdown formatting coverage.
2. HTTP controller tests for healthz, query-path matching, OPTIONS, 413, stable error codes, wildcard host blocking.
3. RPC dispatcher tests for strict selector typing and compact-by-default notebook.runAll responses.

## 7) Tracked File Diffs (against HEAD)

### Diff: `package.json`
```diff
diff --git a/package.json b/package.json
index 45d1d41..f29ca53 100644
--- a/package.json
+++ b/package.json
@@ -40,7 +40,8 @@
   ],
   "activationEvents": [
     "onNotebook:jupyter-notebook",
-    "onNotebook:interactive"
+    "onNotebook:interactive",
+    "onStartupFinished"
   ],
   "contributes": {
     "configuration": {
@@ -92,6 +93,50 @@
           "tags": [
             "experimental"
           ]
+        },
+        "colab.agentBridge.enabled": {
+          "type": "boolean",
+          "default": false,
+          "description": "Enables a local HTTP bridge so automation tools can call Colab runtime commands without UI prompts.",
+          "scope": "machine",
+          "tags": [
+            "experimental"
+          ]
+        },
+        "colab.agentBridge.host": {
+          "type": "string",
+          "default": "127.0.0.1",
+          "scope": "machine",
+          "description": "Host interface for the Colab agent bridge listener."
+        },
+        "colab.agentBridge.allowRemoteHost": {
+          "type": "boolean",
+          "default": false,
+          "scope": "machine",
+          "description": "Unsafe: allow specific non-loopback bind hosts for the agent bridge. Wildcard bind hosts (0.0.0.0/::) are not supported. A non-empty token is still required.",
+          "tags": [
+            "experimental"
+          ]
+        },
+        "colab.agentBridge.port": {
+          "type": "number",
+          "default": 0,
+          "minimum": 0,
+          "maximum": 65535,
+          "scope": "machine",
+          "description": "Port for the Colab agent bridge listener. Use 0 for an ephemeral port."
+        },
+        "colab.agentBridge.token": {
+          "type": "string",
+          "default": "",
+          "scope": "machine",
+          "markdownDescription": "Shared token for the bridge API. Required when the bridge is enabled. Callers must send `Authorization: Bearer <token>` or `x-colab-agent-token`."
+        },
+        "colab.agentBridge.stateFile": {
+          "type": "string",
+          "default": "~/.colab-agent-bridge.json",
+          "scope": "machine",
+          "description": "Path to write bridge connection metadata so external agents can discover the endpoint."
         }
       }
     },
@@ -360,6 +405,7 @@
     "pretest:e2e": "npm run build:tests",
     "test:e2e": "scripts/test_e2e.sh",
     "test:e2e:headless": "npm run test:e2e -- --headless",
+    "agent:bridge": "tsx scripts/colab-agent-bridge.mts",
     "vscode:prepublish": "npm run package",
     "package": "concurrently \"npm:typecheck:prod\" \"npm:build:extension -- --production\" --prefixColors=auto"
   },
```

### Diff: `src/extension.ts`
```diff
diff --git a/src/extension.ts b/src/extension.ts
index d30d760..0bb1f36 100644
--- a/src/extension.ts
+++ b/src/extension.ts
@@ -25,6 +25,7 @@ import {
   SIGN_OUT,
   OPEN_TERMINAL,
 } from './colab/commands/constants';
+import { AgentBridgeController } from './colab/agent-bridge';
 import {
   agentListRuntimes,
   AgentListRuntimesArgs,
@@ -106,6 +107,7 @@ export async function activate(context: vscode.ExtensionContext) {
     colabClient,
     serverStorage,
   );
+  const agentBridge = new AgentBridgeController(vscode, assignmentManager);
   const serverProvider = new ColabJupyterServerProvider(
     vscode,
     authProvider.onDidChangeSessions,
@@ -159,6 +161,7 @@ export async function activate(context: vscode.ExtensionContext) {
     disposeAll(authFlows),
     authProvider,
     assignmentManager,
+    agentBridge,
     experimentStateProvider,
     serverProvider,
     jupyterConnections,
```

### Diff: `src/colab/commands/agent.ts`
```diff
diff --git a/src/colab/commands/agent.ts b/src/colab/commands/agent.ts
index 54f5677..700f795 100644
--- a/src/colab/commands/agent.ts
+++ b/src/colab/commands/agent.ts
@@ -1,458 +1,69 @@
 /**
  * @license
- * Copyright 2025 Google LLC
+ * Copyright 2026 Google LLC
  * SPDX-License-Identifier: Apache-2.0
  */
 
-import { Shape, Variant } from '../api';
 import { AssignmentManager } from '../../jupyter/assignments';
 import {
-  AllServers,
-  ColabAssignedServer,
-  ColabServerDescriptor,
-  isColabAssignedServer,
-  UnownedServer,
-} from '../../jupyter/servers';
-
-type AgentRuntimeScope = 'extension' | 'external' | 'all';
-type AgentStartMode = 'latestOrCreate' | 'new';
-
-interface AgentRuntimeSelection {
-  id?: string;
-  endpoint?: string;
-  label?: string;
-  all?: boolean;
-}
-
-export interface AgentRuntimeRecord {
-  readonly owner: 'extension' | 'external';
-  readonly id?: string;
-  readonly label: string;
-  readonly endpoint: string;
-  readonly variant: Variant;
-  readonly accelerator?: string;
-  readonly shape?: Shape;
-  readonly version?: string;
-  readonly dateAssigned?: string;
-  readonly baseUrl?: string;
-  readonly tokenExpiry?: string;
-}
-
-export interface AgentListRuntimesArgs {
-  readonly from?: AgentRuntimeScope;
-}
-
-export interface AgentListRuntimesResult {
-  readonly scope: AgentRuntimeScope;
-  readonly assigned: readonly AgentRuntimeRecord[];
-  readonly unowned: readonly AgentRuntimeRecord[];
-  readonly counts: {
-    readonly assigned: number;
-    readonly unowned: number;
-    readonly total: number;
-  };
-}
-
-export interface AgentStartRuntimeArgs {
-  readonly mode?: AgentStartMode;
-  readonly label?: string;
-  readonly variant?: Variant | string;
-  readonly accelerator?: string;
-  readonly shape?: Shape | number | string;
-  readonly version?: string;
-}
-
-export interface AgentStartRuntimeResult {
-  readonly mode: AgentStartMode;
-  readonly action: 'reused' | 'created';
-  readonly runtime: AgentRuntimeRecord;
-}
-
-export interface AgentStopRuntimeArgs extends AgentRuntimeSelection {
-  readonly from?: AgentRuntimeScope;
-}
-
-export interface AgentStopRuntimeResult {
-  readonly scope: AgentRuntimeScope;
-  readonly requested: {
-    readonly id?: string;
-    readonly endpoint?: string;
-    readonly label?: string;
-    readonly all: boolean;
-  };
-  readonly stopped: readonly AgentRuntimeRecord[];
-  readonly failed: readonly { target: AgentRuntimeRecord; error: string }[];
-  readonly notFound: boolean;
-}
-
-export interface AgentRuntimeStatusArgs extends AgentRuntimeSelection {
-  readonly from?: AgentRuntimeScope;
-}
-
-export interface AgentRuntimeStatusResult {
-  readonly scope: AgentRuntimeScope;
-  readonly available: AgentListRuntimesResult;
-  readonly selected: readonly AgentRuntimeRecord[];
-  readonly latestAssigned?: AgentRuntimeRecord;
-  readonly ambiguousLabelSelection: boolean;
-}
-
-interface ScopedServers {
-  readonly assigned: readonly ColabAssignedServer[];
-  readonly unowned: readonly UnownedServer[];
-}
-
-function resolveScope(from?: AgentRuntimeScope): AgentRuntimeScope {
-  return from ?? 'all';
-}
-
-function normalizeString(value: string | undefined): string | undefined {
-  if (value === undefined) {
-    return undefined;
-  }
-  const trimmed = value.trim();
-  return trimmed.length > 0 ? trimmed : undefined;
-}
-
-function normalizeAccelerator(value: string | undefined): string | undefined {
-  const normalized = normalizeString(value);
-  return normalized?.toUpperCase();
-}
-
-function normalizeVariant(value: Variant | string | undefined): Variant | undefined {
-  if (value === undefined) {
-    return undefined;
-  }
-  if (value === Variant.DEFAULT || value === Variant.GPU || value === Variant.TPU) {
-    return value;
-  }
-  const normalized = value.toUpperCase();
-  switch (normalized) {
-    case Variant.DEFAULT:
-    case Variant.GPU:
-    case Variant.TPU:
-      return normalized;
-    default:
-      return undefined;
-  }
-}
-
-function normalizeShape(value: Shape | number | string | undefined): Shape | undefined {
-  if (value === undefined) {
-    return undefined;
-  }
-  if (value === Shape.STANDARD || value === Shape.HIGHMEM) {
-    return value;
-  }
-  if (typeof value === 'number') {
-    return value === Shape.STANDARD || value === Shape.HIGHMEM
-      ? value
-      : undefined;
-  }
-  const normalized = value.trim().toUpperCase();
-  switch (normalized) {
-    case 'STANDARD':
-      return Shape.STANDARD;
-    case 'HIGHMEM':
-      return Shape.HIGHMEM;
-    case '0':
-      return Shape.STANDARD;
-    case '1':
-      return Shape.HIGHMEM;
-    default:
-      return undefined;
-  }
-}
-
-function toRuntimeRecord(
-  server: ColabAssignedServer | UnownedServer,
-): AgentRuntimeRecord {
-  if (!isColabAssignedServer(server)) {
-    return {
-      owner: 'external',
-      label: server.label,
-      endpoint: server.endpoint,
-      variant: server.variant,
-      accelerator: server.accelerator,
-      shape: server.shape,
-      version: server.version,
-    };
-  }
-  return {
-    owner: 'extension',
-    id: server.id,
-    label: server.label,
-    endpoint: server.endpoint,
-    variant: server.variant,
-    accelerator: server.accelerator,
-    shape: server.shape,
-    version: server.version,
-    dateAssigned: server.dateAssigned.toISOString(),
-    baseUrl: server.connectionInformation.baseUrl.toString(),
-    tokenExpiry: server.connectionInformation.tokenExpiry.toISOString(),
-  };
-}
-
-async function getScopedServers(
-  assignmentManager: AssignmentManager,
-  scope: AgentRuntimeScope,
-): Promise<ScopedServers> {
-  switch (scope) {
-    case 'extension':
-      return {
-        assigned: await assignmentManager.getServers('extension'),
-        unowned: [],
-      };
-    case 'external':
-      return {
-        assigned: [],
-        unowned: await assignmentManager.getServers('external'),
-      };
-    default: {
-      const all = (await assignmentManager.getServers('all')) as AllServers;
-      return {
-        assigned: all.assigned,
-        unowned: all.unowned,
-      };
-    }
-  }
-}
-
-function getAllScopedServers(
-  servers: ScopedServers,
-): readonly (ColabAssignedServer | UnownedServer)[] {
-  return [...servers.assigned, ...servers.unowned];
-}
-
-function selectServers(
-  servers: readonly (ColabAssignedServer | UnownedServer)[],
-  selection: AgentRuntimeSelection,
-): readonly (ColabAssignedServer | UnownedServer)[] {
-  if (selection.all) {
-    return servers;
-  }
-  if (selection.id) {
-    return servers.filter(
-      (s): s is ColabAssignedServer =>
-        isColabAssignedServer(s) && s.id === selection.id,
-    );
-  }
-  if (selection.endpoint) {
-    return servers.filter((s) => s.endpoint === selection.endpoint);
-  }
-  if (selection.label) {
-    return servers.filter((s) => s.label === selection.label);
-  }
-  return [];
-}
-
-function formatError(error: unknown): string {
-  if (error instanceof Error) {
-    return `${error.name}: ${error.message}`;
-  }
-  return String(error);
-}
-
-function normalizeSelection(
-  args: AgentRuntimeSelection,
-): {
-  readonly id?: string;
-  readonly endpoint?: string;
-  readonly label?: string;
-  readonly all: boolean;
-} {
-  return {
-    id: normalizeString(args.id),
-    endpoint: normalizeString(args.endpoint),
-    label: normalizeString(args.label),
-    all: Boolean(args.all),
-  };
-}
-
-function shouldCreateNewRuntime(args: AgentStartRuntimeArgs): boolean {
-  return (
-    args.label !== undefined ||
-    args.variant !== undefined ||
-    args.accelerator !== undefined ||
-    args.shape !== undefined ||
-    args.version !== undefined
-  );
-}
-
-async function toDescriptor(
+  AgentListRuntimesArgs,
+  AgentListRuntimesResult,
+  AgentRuntimeService,
+  AgentRuntimeStatusArgs,
+  AgentRuntimeStatusResult,
+  AgentStartRuntimeArgs,
+  AgentStartRuntimeResult,
+  AgentStopRuntimeArgs,
+  AgentStopRuntimeResult,
+  AgentRuntimeRecord,
+  AgentRuntimeScope,
+  AgentStartMode,
+} from '../agent-runtime-service';
+
+function createAgentRuntimeService(
   assignmentManager: AssignmentManager,
-  args: AgentStartRuntimeArgs,
-): Promise<ColabServerDescriptor> {
-  const variant = normalizeVariant(args.variant) ?? Variant.DEFAULT;
-  const accelerator = normalizeAccelerator(args.accelerator);
-  const shape = normalizeShape(args.shape);
-  const version = normalizeString(args.version);
-  const label =
-    normalizeString(args.label) ??
-    (await assignmentManager.getDefaultLabel(variant, accelerator));
-
-  return {
-    label,
-    variant,
-    ...(accelerator ? { accelerator } : {}),
-    ...(shape !== undefined ? { shape } : {}),
-    ...(version ? { version } : {}),
-  };
+): AgentRuntimeService {
+  return new AgentRuntimeService(assignmentManager);
 }
 
 export async function agentListRuntimes(
   assignmentManager: AssignmentManager,
   args: AgentListRuntimesArgs = {},
 ): Promise<AgentListRuntimesResult> {
-  const scope = resolveScope(args.from);
-  const scoped = await getScopedServers(assignmentManager, scope);
-  const assigned = scoped.assigned.map(toRuntimeRecord);
-  const unowned = scoped.unowned.map(toRuntimeRecord);
-  const total = assigned.length + unowned.length;
-  return {
-    scope,
-    assigned,
-    unowned,
-    counts: {
-      assigned: assigned.length,
-      unowned: unowned.length,
-      total,
-    },
-  };
+  return await createAgentRuntimeService(assignmentManager).listRuntimes(args);
 }
 
 export async function agentStartRuntime(
   assignmentManager: AssignmentManager,
   args: AgentStartRuntimeArgs = {},
 ): Promise<AgentStartRuntimeResult> {
-  const mode =
-    args.mode ?? (shouldCreateNewRuntime(args) ? 'new' : 'latestOrCreate');
-
-  if (mode === 'latestOrCreate') {
-    const latest = await assignmentManager.latestServer();
-    if (latest) {
-      return {
-        mode,
-        action: 'reused',
-        runtime: toRuntimeRecord(latest),
-      };
-    }
-    const created = await assignmentManager.latestOrAutoAssignServer();
-    return {
-      mode,
-      action: 'created',
-      runtime: toRuntimeRecord(created),
-    };
-  }
-
-  const descriptor = await toDescriptor(assignmentManager, args);
-  const created = await assignmentManager.assignServer(descriptor);
-  return {
-    mode,
-    action: 'created',
-    runtime: toRuntimeRecord(created),
-  };
+  return await createAgentRuntimeService(assignmentManager).startRuntime(args);
 }
 
 export async function agentStopRuntime(
   assignmentManager: AssignmentManager,
   args: AgentStopRuntimeArgs = {},
 ): Promise<AgentStopRuntimeResult> {
-  const scope = resolveScope(args.from ?? 'extension');
-  const requested = normalizeSelection(args);
-  const scoped = await getScopedServers(assignmentManager, scope);
-  const allScoped = getAllScopedServers(scoped);
-
-  let selected = selectServers(allScoped, requested);
-
-  if (
-    !requested.all &&
-    !requested.id &&
-    !requested.endpoint &&
-    !requested.label &&
-    scope === 'extension'
-  ) {
-    const latest = await assignmentManager.latestServer();
-    selected = latest ? [latest] : [];
-  }
-
-  if (
-    requested.label &&
-    !requested.id &&
-    !requested.endpoint &&
-    selected.length > 1
-  ) {
-    throw new Error(
-      `Ambiguous label "${requested.label}" matched ${selected.length.toString()} runtimes. Use endpoint or id.`,
-    );
-  }
-
-  if (selected.length === 0) {
-    return {
-      scope,
-      requested,
-      stopped: [],
-      failed: [],
-      notFound: true,
-    };
-  }
-
-  const stopped: AgentRuntimeRecord[] = [];
-  const failed: { target: AgentRuntimeRecord; error: string }[] = [];
-  for (const server of selected) {
-    const runtime = toRuntimeRecord(server);
-    try {
-      await assignmentManager.unassignServer(server);
-      stopped.push(runtime);
-    } catch (error) {
-      failed.push({ target: runtime, error: formatError(error) });
-    }
-  }
-
-  return {
-    scope,
-    requested,
-    stopped,
-    failed,
-    notFound: false,
-  };
+  return await createAgentRuntimeService(assignmentManager).stopRuntime(args);
 }
 
 export async function agentRuntimeStatus(
   assignmentManager: AssignmentManager,
   args: AgentRuntimeStatusArgs = {},
 ): Promise<AgentRuntimeStatusResult> {
-  const scope = resolveScope(args.from);
-  const available = await agentListRuntimes(assignmentManager, { from: scope });
-  const requested = normalizeSelection(args);
-  const all = [...available.assigned, ...available.unowned];
-  const selected = requested.all
-    ? all
-    : all.filter((runtime) => {
-        if (requested.id) {
-          return runtime.id === requested.id;
-        }
-        if (requested.endpoint) {
-          return runtime.endpoint === requested.endpoint;
-        }
-        if (requested.label) {
-          return runtime.label === requested.label;
-        }
-        return false;
-      });
-
-  const latestAssigned = await assignmentManager.latestServer();
-  const ambiguousLabelSelection =
-    requested.label !== undefined &&
-    requested.id === undefined &&
-    requested.endpoint === undefined &&
-    selected.length > 1;
-
-  return {
-    scope,
-    available,
-    selected,
-    latestAssigned: latestAssigned ? toRuntimeRecord(latestAssigned) : undefined,
-    ambiguousLabelSelection,
-  };
-}
+  return await createAgentRuntimeService(assignmentManager).runtimeStatus(args);
+}
+
+export type {
+  AgentListRuntimesArgs,
+  AgentListRuntimesResult,
+  AgentRuntimeRecord,
+  AgentRuntimeScope,
+  AgentRuntimeStatusArgs,
+  AgentRuntimeStatusResult,
+  AgentStartMode,
+  AgentStartRuntimeArgs,
+  AgentStartRuntimeResult,
+  AgentStopRuntimeArgs,
+  AgentStopRuntimeResult,
+};
```

## 8) Untracked File Diffs (against /dev/null)

### Diff: `scripts/colab-agent-bridge.mts`
```diff
diff --git a/scripts/colab-agent-bridge.mts b/scripts/colab-agent-bridge.mts
new file mode 100644
index 0000000..9cc37e0
--- /dev/null
+++ b/scripts/colab-agent-bridge.mts
@@ -0,0 +1,152 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { readFile } from 'fs/promises';
+import os from 'os';
+import path from 'path';
+
+const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';
+
+interface BridgeState {
+  readonly endpoint?: string;
+  readonly host: string;
+  readonly port: number;
+}
+
+function resolveStateFilePath(filePath: string): string {
+  if (filePath === '~') {
+    return os.homedir();
+  }
+  if (filePath.startsWith('~/')) {
+    return path.join(os.homedir(), filePath.slice(2));
+  }
+  return path.resolve(filePath);
+}
+
+function usage(): string {
+  return [
+    'Usage:',
+    '  npx tsx scripts/colab-agent-bridge.mts <method> [json-params|@params-file|-]',
+    '',
+    'Examples:',
+    '  npx tsx scripts/colab-agent-bridge.mts ping',
+    '  npx tsx scripts/colab-agent-bridge.mts bridge.capabilities',
+    "  npx tsx scripts/colab-agent-bridge.mts runtimes.list '{\"from\":\"all\"}'",
+    "  npx tsx scripts/colab-agent-bridge.mts runtimes.start '{\"mode\":\"latestOrCreate\"}'",
+    "  npx tsx scripts/colab-agent-bridge.mts notebook.execute '{\"code\":\"print(123)\"}'",
+    "  npx tsx scripts/colab-agent-bridge.mts notebook.runAll '{\"notebookPath\":\"./notebooks/00_env_check.ipynb\"}'",
+    "  npx tsx scripts/colab-agent-bridge.mts runtime.files.writeText '{\"runtimePath\":\"/content/drive/MyDrive/voice-moonshot/notes.txt\",\"text\":\"hello\"}'",
+    "  npx tsx scripts/colab-agent-bridge.mts runtime.secrets.sync @/tmp/hf-sync.json",
+    "  cat /tmp/hf-sync.json | npx tsx scripts/colab-agent-bridge.mts runtime.secrets.sync -",
+    '',
+    'Environment:',
+    '  COLAB_AGENT_BRIDGE_STATE_FILE (optional)',
+    '  COLAB_AGENT_BRIDGE_TOKEN (required)',
+  ].join('\n');
+}
+
+async function readStdinText(): Promise<string> {
+  return await new Promise<string>((resolve, reject) => {
+    const chunks: Buffer[] = [];
+    process.stdin.on('data', (chunk: Buffer | string) => {
+      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
+    });
+    process.stdin.on('end', () => {
+      resolve(Buffer.concat(chunks).toString('utf8'));
+    });
+    process.stdin.on('error', reject);
+  });
+}
+
+async function parseParams(rawParams?: string): Promise<unknown> {
+  if (!rawParams) {
+    return {};
+  }
+
+  let source = rawParams;
+  if (rawParams === '-') {
+    source = (await readStdinText()).trim();
+  } else if (rawParams.startsWith('@')) {
+    const paramsFile = path.resolve(rawParams.slice(1));
+    source = (await readFile(paramsFile, 'utf8')).trim();
+  }
+
+  if (source.length === 0) {
+    return {};
+  }
+
+  return JSON.parse(source);
+}
+
+async function getEndpointFromStateFile(
+  stateFilePath: string,
+): Promise<string> {
+  const raw = await readFile(stateFilePath, 'utf8');
+  const state = JSON.parse(raw) as BridgeState;
+  if (state.endpoint && state.endpoint.length > 0) {
+    return state.endpoint;
+  }
+  return `http://${state.host}:${state.port.toString()}/v1/colab-agent`;
+}
+
+async function main(): Promise<void> {
+  const [method, rawParams] = process.argv.slice(2);
+  if (!method) {
+    console.error(usage());
+    process.exitCode = 2;
+    return;
+  }
+
+  let params: unknown;
+  if (rawParams) {
+    try {
+      params = await parseParams(rawParams);
+    } catch (_error) {
+      console.error('json-params must be valid JSON.');
+      process.exitCode = 2;
+      return;
+    }
+  } else {
+    params = {};
+  }
+
+  const stateFile = resolveStateFilePath(
+    process.env.COLAB_AGENT_BRIDGE_STATE_FILE ?? DEFAULT_STATE_FILE,
+  );
+  const endpoint = await getEndpointFromStateFile(stateFile);
+  const token = process.env.COLAB_AGENT_BRIDGE_TOKEN?.trim();
+  if (!token) {
+    console.error('COLAB_AGENT_BRIDGE_TOKEN is required.');
+    process.exitCode = 2;
+    return;
+  }
+
+  const headers: Record<string, string> = {
+    'content-type': 'application/json',
+    authorization: `Bearer ${token}`,
+  };
+
+  const response = await fetch(endpoint, {
+    method: 'POST',
+    headers,
+    body: JSON.stringify({
+      id: `${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
+      method,
+      params,
+    }),
+  });
+  const payload = (await response.json()) as {
+    readonly ok?: boolean;
+  };
+
+  console.log(JSON.stringify(payload, undefined, 2));
+
+  if (!response.ok || payload.ok === false) {
+    process.exitCode = 1;
+  }
+}
+
+void main();
```

### Diff: `src/colab/agent-bridge-format.ts`
```diff
diff --git a/src/colab/agent-bridge-format.ts b/src/colab/agent-bridge-format.ts
new file mode 100644
index 0000000..48aa19a
--- /dev/null
+++ b/src/colab/agent-bridge-format.ts
@@ -0,0 +1,274 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import {
+  NotebookExecuteResult,
+  NotebookExecutionOutput,
+  NotebookRunAllResult,
+  NotebookRunCellResult,
+} from './agent-runtime-service';
+
+export type AgentBridgeOutputMode = 'raw' | 'compact';
+export type AgentBridgeRenderMode = 'none' | 'markdown';
+
+interface CompactError {
+  readonly name: string;
+  readonly message: string;
+}
+
+interface CompactNotebookCell {
+  readonly cellIndex: number;
+  readonly executionIndex: number;
+  readonly ok: boolean;
+  readonly status: 'ok' | 'error';
+  readonly logs: string;
+  readonly error?: CompactError;
+}
+
+interface CompactNotebookExecuteResult {
+  readonly format: 'compact';
+  readonly ok: boolean;
+  readonly status: 'ok' | 'error';
+  readonly runtime: NotebookExecuteResult['runtime'];
+  readonly sessionId: string;
+  readonly kernelId: string;
+  readonly kernelName: string;
+  readonly elapsedMs: number;
+  readonly cleanedUpSession: boolean;
+  readonly logs: string;
+  readonly error?: CompactError;
+  readonly summaryMarkdown?: string;
+}
+
+interface CompactNotebookRunAllResult {
+  readonly format: 'compact';
+  readonly ok: boolean;
+  readonly status: 'ok' | 'error';
+  readonly runtime: NotebookRunAllResult['runtime'];
+  readonly notebookPath: string;
+  readonly sessionId: string;
+  readonly kernelId: string;
+  readonly kernelName: string;
+  readonly totalCodeCells: number;
+  readonly executedCells: number;
+  readonly failedCells: number;
+  readonly stoppedOnError: boolean;
+  readonly elapsedMs: number;
+  readonly cleanedUpSession: boolean;
+  readonly cells: readonly CompactNotebookCell[];
+  readonly summaryMarkdown?: string;
+}
+
+interface MarkdownAttachable {
+  readonly summaryMarkdown?: string;
+}
+
+function sanitizeText(value: string): string {
+  // Strip ANSI escapes for agent readability.
+  return value.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
+}
+
+function outputText(output: NotebookExecutionOutput): string {
+  switch (output.type) {
+    case 'stream':
+      return output.text ?? '';
+    case 'execute_result':
+    case 'display_data':
+      if (output.text && output.text.length > 0) {
+        return output.text;
+      }
+      return JSON.stringify(output.data ?? {});
+    case 'error':
+      if (output.traceback && output.traceback.length > 0) {
+        return output.traceback.join('\n');
+      }
+      return `${output.ename ?? 'Error'}: ${output.evalue ?? 'Execution failed.'}`;
+    default:
+      return '';
+  }
+}
+
+function collectLogs(outputs: readonly NotebookExecutionOutput[]): string {
+  const chunks = outputs
+    .map(outputText)
+    .map((chunk) => sanitizeText(chunk))
+    .map((chunk) => chunk.trim())
+    .filter((chunk) => chunk.length > 0);
+  return chunks.join('\n');
+}
+
+function firstErrorFromOutputs(
+  outputs: readonly NotebookExecutionOutput[],
+): CompactError | undefined {
+  for (const output of outputs) {
+    if (output.type !== 'error') {
+      continue;
+    }
+    return {
+      name: output.ename ?? 'ExecutionError',
+      message: output.evalue ?? 'Execution failed.',
+    };
+  }
+  return undefined;
+}
+
+function renderExecuteMarkdown(
+  result: CompactNotebookExecuteResult,
+): string {
+  const lines: string[] = [
+    '# Notebook Execute Result',
+    '',
+    `- Status: ${result.ok ? 'ok' : 'error'}`,
+    `- Runtime: ${result.runtime.label}`,
+    `- ElapsedMs: ${result.elapsedMs.toString()}`,
+    '',
+  ];
+  if (result.error) {
+    lines.push(`- Error: ${result.error.name}: ${result.error.message}`);
+    lines.push('');
+  }
+  lines.push('## Logs');
+  lines.push('```text');
+  lines.push(result.logs.length > 0 ? result.logs : '<no logs>');
+  lines.push('```');
+  return lines.join('\n');
+}
+
+function renderRunAllMarkdown(result: CompactNotebookRunAllResult): string {
+  const lines: string[] = [
+    '# Notebook RunAll Result',
+    '',
+    `- Status: ${result.ok ? 'ok' : 'error'}`,
+    `- Executed: ${result.executedCells.toString()} / ${result.totalCodeCells.toString()}`,
+    `- Failed: ${result.failedCells.toString()}`,
+    `- StoppedOnError: ${result.stoppedOnError ? 'true' : 'false'}`,
+    `- ElapsedMs: ${result.elapsedMs.toString()}`,
+    '',
+    '## Cells',
+  ];
+
+  for (const cell of result.cells) {
+    lines.push(
+      `### Cell ${cell.executionIndex.toString()} (index ${cell.cellIndex.toString()}): ${cell.ok ? 'ok' : 'error'}`,
+    );
+    if (cell.error) {
+      lines.push(`- Error: ${cell.error.name}: ${cell.error.message}`);
+    }
+    lines.push('```text');
+    lines.push(cell.logs.length > 0 ? cell.logs : '<no logs>');
+    lines.push('```');
+    lines.push('');
+  }
+
+  return lines.join('\n');
+}
+
+function toCompactCell(cell: NotebookRunCellResult): CompactNotebookCell {
+  const error = firstErrorFromOutputs(cell.outputs);
+  return {
+    cellIndex: cell.cellIndex,
+    executionIndex: cell.executionIndex,
+    ok: cell.status === 'ok',
+    status: cell.status,
+    logs: collectLogs(cell.outputs),
+    ...(error ? { error } : {}),
+  };
+}
+
+function toCompactExecuteResult(
+  result: NotebookExecuteResult,
+): CompactNotebookExecuteResult {
+  const error = firstErrorFromOutputs(result.outputs);
+  return {
+    format: 'compact',
+    ok: result.status === 'ok',
+    status: result.status,
+    runtime: result.runtime,
+    sessionId: result.sessionId,
+    kernelId: result.kernelId,
+    kernelName: result.kernelName,
+    elapsedMs: result.elapsedMs,
+    cleanedUpSession: result.cleanedUpSession,
+    logs: collectLogs(result.outputs),
+    ...(error ? { error } : {}),
+  };
+}
+
+function toCompactRunAllResult(
+  result: NotebookRunAllResult,
+): CompactNotebookRunAllResult {
+  return {
+    format: 'compact',
+    ok: result.status === 'ok',
+    status: result.status,
+    runtime: result.runtime,
+    notebookPath: result.notebookPath,
+    sessionId: result.sessionId,
+    kernelId: result.kernelId,
+    kernelName: result.kernelName,
+    totalCodeCells: result.totalCodeCells,
+    executedCells: result.executedCells,
+    failedCells: result.failedCells,
+    stoppedOnError: result.stoppedOnError,
+    elapsedMs: result.elapsedMs,
+    cleanedUpSession: result.cleanedUpSession,
+    cells: result.cells.map(toCompactCell),
+  };
+}
+
+export function formatNotebookExecuteResult(
+  result: NotebookExecuteResult,
+  outputMode: AgentBridgeOutputMode,
+  renderMode: AgentBridgeRenderMode,
+): NotebookExecuteResult | (CompactNotebookExecuteResult & MarkdownAttachable) {
+  if (outputMode === 'raw') {
+    if (renderMode === 'none') {
+      return result;
+    }
+    const compact = toCompactExecuteResult(result);
+    return {
+      ...result,
+      summaryMarkdown: renderExecuteMarkdown(compact),
+    };
+  }
+
+  const compact = toCompactExecuteResult(result);
+
+  if (renderMode === 'none') {
+    return compact;
+  }
+  return {
+    ...compact,
+    summaryMarkdown: renderExecuteMarkdown(compact),
+  };
+}
+
+export function formatNotebookRunAllResult(
+  result: NotebookRunAllResult,
+  outputMode: AgentBridgeOutputMode,
+  renderMode: AgentBridgeRenderMode,
+): NotebookRunAllResult | (CompactNotebookRunAllResult & MarkdownAttachable) {
+  if (outputMode === 'raw') {
+    if (renderMode === 'none') {
+      return result;
+    }
+    const compact = toCompactRunAllResult(result);
+    return {
+      ...result,
+      summaryMarkdown: renderRunAllMarkdown(compact),
+    };
+  }
+
+  const compact = toCompactRunAllResult(result);
+
+  if (renderMode === 'none') {
+    return compact;
+  }
+  return {
+    ...compact,
+    summaryMarkdown: renderRunAllMarkdown(compact),
+  };
+}
```

### Diff: `src/colab/agent-bridge-format.unit.test.ts`
```diff
diff --git a/src/colab/agent-bridge-format.unit.test.ts b/src/colab/agent-bridge-format.unit.test.ts
new file mode 100644
index 0000000..80186d5
--- /dev/null
+++ b/src/colab/agent-bridge-format.unit.test.ts
@@ -0,0 +1,177 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { expect } from 'chai';
+import { Variant } from './api';
+import {
+  formatNotebookExecuteResult,
+  formatNotebookRunAllResult,
+} from './agent-bridge-format';
+import { NotebookExecuteResult, NotebookRunAllResult } from './agent-runtime-service';
+
+const RUNTIME = {
+  owner: 'extension' as const,
+  id: 'runtime-id',
+  label: 'Colab CPU',
+  endpoint: 'm-s-test',
+  variant: Variant.DEFAULT,
+  accelerator: 'NONE',
+  dateAssigned: '2026-02-22T00:00:00.000Z',
+  baseUrl: 'https://example.com/',
+  tokenExpiry: '2026-02-22T01:00:00.000Z',
+};
+
+describe('Agent Bridge Output Formatter', () => {
+  it('formats notebook.execute to compact output by default shape', () => {
+    const raw: NotebookExecuteResult = {
+      runtime: RUNTIME,
+      sessionId: 'session-id',
+      kernelId: 'kernel-id',
+      kernelName: 'python3',
+      status: 'error',
+      outputs: [
+        { type: 'stream', name: 'stdout', text: 'line-1\n' },
+        {
+          type: 'error',
+          ename: 'ValueError',
+          evalue: 'bad input',
+          traceback: ['Traceback line 1', 'Traceback line 2'],
+        },
+      ],
+      reply: {},
+      elapsedMs: 123,
+      cleanedUpSession: true,
+    };
+
+    const compact = formatNotebookExecuteResult(raw, 'compact', 'none') as {
+      readonly format: string;
+      readonly ok: boolean;
+      readonly logs: string;
+      readonly error?: { readonly name: string; readonly message: string };
+      readonly outputs?: unknown;
+    };
+
+    expect(compact.format).to.equal('compact');
+    expect(compact.ok).to.equal(false);
+    expect(compact.logs).to.contain('line-1');
+    expect(compact.logs).to.contain('Traceback line 1');
+    expect(compact.error).to.deep.equal({
+      name: 'ValueError',
+      message: 'bad input',
+    });
+    expect(compact.outputs).to.equal(undefined);
+  });
+
+  it('attaches markdown summary when requested', () => {
+    const raw: NotebookExecuteResult = {
+      runtime: RUNTIME,
+      sessionId: 'session-id',
+      kernelId: 'kernel-id',
+      kernelName: 'python3',
+      status: 'ok',
+      outputs: [{ type: 'stream', name: 'stdout', text: 'hello\n' }],
+      reply: {},
+      elapsedMs: 77,
+      cleanedUpSession: true,
+    };
+
+    const compact = formatNotebookExecuteResult(raw, 'compact', 'markdown') as {
+      readonly summaryMarkdown?: string;
+    };
+
+    expect(compact.summaryMarkdown).to.contain('# Notebook Execute Result');
+    expect(compact.summaryMarkdown).to.contain('hello');
+  });
+
+  it('keeps raw payload in raw mode while adding markdown optionally', () => {
+    const raw: NotebookExecuteResult = {
+      runtime: RUNTIME,
+      sessionId: 'session-id',
+      kernelId: 'kernel-id',
+      kernelName: 'python3',
+      status: 'ok',
+      outputs: [{ type: 'stream', name: 'stdout', text: 'hello\n' }],
+      reply: { status: 'ok' },
+      elapsedMs: 88,
+      cleanedUpSession: true,
+    };
+
+    const result = formatNotebookExecuteResult(raw, 'raw', 'markdown') as {
+      readonly outputs: readonly unknown[];
+      readonly reply: unknown;
+      readonly summaryMarkdown?: string;
+    };
+
+    expect(result.outputs).to.have.length(1);
+    expect(result.reply).to.deep.equal({ status: 'ok' });
+    expect(result.summaryMarkdown).to.contain('# Notebook Execute Result');
+  });
+
+  it('formats notebook.runAll into per-cell compact logs', () => {
+    const raw: NotebookRunAllResult = {
+      runtime: RUNTIME,
+      notebookPath: '/tmp/example.ipynb',
+      sessionId: 'session-id',
+      kernelId: 'kernel-id',
+      kernelName: 'python3',
+      status: 'error',
+      totalCodeCells: 2,
+      executedCells: 2,
+      failedCells: 1,
+      stoppedOnError: false,
+      elapsedMs: 222,
+      cleanedUpSession: true,
+      cells: [
+        {
+          cellIndex: 0,
+          executionIndex: 1,
+          status: 'ok',
+          elapsedMs: 100,
+          sourcePreview: 'print(1)',
+          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
+          reply: {},
+        },
+        {
+          cellIndex: 1,
+          executionIndex: 2,
+          status: 'error',
+          elapsedMs: 122,
+          sourcePreview: 'raise ValueError()',
+          outputs: [
+            {
+              type: 'error',
+              ename: 'ValueError',
+              evalue: 'boom',
+              traceback: ['Traceback...'],
+            },
+          ],
+          reply: {},
+        },
+      ],
+    };
+
+    const compact = formatNotebookRunAllResult(raw, 'compact', 'markdown') as {
+      readonly format: string;
+      readonly cells: readonly {
+        readonly ok: boolean;
+        readonly logs: string;
+        readonly error?: { readonly name: string; readonly message: string };
+      }[];
+      readonly summaryMarkdown?: string;
+    };
+
+    expect(compact.format).to.equal('compact');
+    expect(compact.cells).to.have.length(2);
+    expect(compact.cells[0].ok).to.equal(true);
+    expect(compact.cells[0].logs).to.contain('1');
+    expect(compact.cells[1].ok).to.equal(false);
+    expect(compact.cells[1].error).to.deep.equal({
+      name: 'ValueError',
+      message: 'boom',
+    });
+    expect(compact.summaryMarkdown).to.contain('# Notebook RunAll Result');
+  });
+});
```

### Diff: `src/colab/agent-bridge-http.ts`
```diff
diff --git a/src/colab/agent-bridge-http.ts b/src/colab/agent-bridge-http.ts
new file mode 100644
index 0000000..a916819
--- /dev/null
+++ b/src/colab/agent-bridge-http.ts
@@ -0,0 +1,690 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import * as fs from 'fs/promises';
+import * as http from 'http';
+import * as os from 'os';
+import * as path from 'path';
+import vscode from 'vscode';
+import { log } from '../common/logging';
+import { AssignmentManager } from '../jupyter/assignments';
+import {
+  AgentBridgeRequest,
+  dispatchAgentBridgeRequest,
+} from './agent-bridge-rpc';
+
+const BRIDGE_ENDPOINT = '/v1/colab-agent';
+const BRIDGE_HEALTH_ENDPOINT = '/healthz';
+const DEFAULT_HOST = '127.0.0.1';
+const DEFAULT_PORT = 0;
+const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';
+const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
+const LOCALHOST_HOST = 'localhost';
+const IPV6_LOOPBACK_HOST = '::1';
+const IPV6_UNSPECIFIED_HOST = '::';
+const IPV4_UNSPECIFIED_HOST = '0.0.0.0';
+const LOOPBACK_V4_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/;
+
+interface AgentBridgeConfig {
+  readonly enabled: boolean;
+  readonly host: string;
+  readonly port: number;
+  readonly token: string;
+  readonly allowRemoteHost: boolean;
+  readonly stateFile: string;
+}
+
+interface AgentBridgeStateFile {
+  readonly version: 1;
+  readonly host: string;
+  readonly port: number;
+  readonly endpoint: string;
+  readonly tokenRequired: boolean;
+  readonly pid: number;
+  readonly startedAt: string;
+}
+
+interface AgentBridgeErrorResponse {
+  readonly id?: string | number;
+  readonly ok: false;
+  readonly error: {
+    readonly name: string;
+    readonly code?: string;
+    readonly message: string;
+  };
+}
+
+interface AgentBridgeSuccessResponse {
+  readonly id?: string | number;
+  readonly ok: true;
+  readonly result: unknown;
+}
+
+interface AgentBridgeServerIdentity {
+  readonly pid: number;
+  readonly port: number;
+}
+
+class HttpRequestError extends Error {
+  constructor(
+    readonly code: string,
+    readonly statusCode: number,
+    message: string,
+  ) {
+    super(message);
+    this.name = 'HttpRequestError';
+  }
+}
+
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
+}
+
+function toErrorResponse(
+  error: unknown,
+  id?: string | number,
+): AgentBridgeErrorResponse {
+  if (error instanceof Error) {
+    const errorCode =
+      'code' in error && typeof error.code === 'string'
+        ? error.code
+        : undefined;
+    return {
+      id,
+      ok: false,
+      error: {
+        name: error.name,
+        code: errorCode,
+        message: error.message,
+      },
+    };
+  }
+  return {
+    id,
+    ok: false,
+    error: {
+      name: 'Error',
+      message: String(error),
+    },
+  };
+}
+
+function writeJson(
+  res: http.ServerResponse,
+  statusCode: number,
+  body: AgentBridgeErrorResponse | AgentBridgeSuccessResponse,
+): void {
+  res.statusCode = statusCode;
+  res.setHeader('cache-control', 'no-store');
+  res.setHeader('content-type', 'application/json; charset=utf-8');
+  res.end(`${JSON.stringify(body)}\n`);
+}
+
+function resolveStateFilePath(filePath: string): string {
+  if (filePath === '~') {
+    return os.homedir();
+  }
+  if (filePath.startsWith('~/')) {
+    return path.join(os.homedir(), filePath.slice(2));
+  }
+  return path.resolve(filePath);
+}
+
+function isLoopbackHost(host: string): boolean {
+  const normalizedHost = host.trim().toLowerCase();
+  if (
+    normalizedHost === LOCALHOST_HOST ||
+    normalizedHost === IPV6_LOOPBACK_HOST
+  ) {
+    return true;
+  }
+  if (!LOOPBACK_V4_HOST_PATTERN.test(normalizedHost)) {
+    return false;
+  }
+  return normalizedHost
+    .split('.')
+    .map(Number)
+    .every(
+      (octet, index) =>
+        Number.isInteger(octet) &&
+        octet >= 0 &&
+        octet <= 255 &&
+        (index > 0 || octet === 127),
+    );
+}
+
+function isWildcardBindHost(host: string): boolean {
+  const normalizedHost = host.trim().toLowerCase();
+  return (
+    normalizedHost === IPV4_UNSPECIFIED_HOST ||
+    normalizedHost === IPV6_UNSPECIFIED_HOST
+  );
+}
+
+function formatHostForEndpoint(host: string): string {
+  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
+}
+
+function parseRequestPath(rawUrl: string | undefined): string | undefined {
+  if (rawUrl === undefined) {
+    return undefined;
+  }
+  try {
+    return new URL(rawUrl, 'http://localhost').pathname;
+  } catch {
+    return undefined;
+  }
+}
+
+function hasJsonContentType(req: http.IncomingMessage): boolean {
+  const contentType = getHeader(req, 'content-type');
+  if (!contentType) {
+    return false;
+  }
+  const [mimeType] = contentType.split(';', 1);
+  return mimeType.trim().toLowerCase() === 'application/json';
+}
+
+function parseStateFileIdentity(
+  value: unknown,
+): AgentBridgeServerIdentity | undefined {
+  if (!isRecord(value)) {
+    return undefined;
+  }
+  const pid = value.pid;
+  const port = value.port;
+  if (
+    typeof pid !== 'number' ||
+    !Number.isInteger(pid) ||
+    typeof port !== 'number' ||
+    !Number.isInteger(port)
+  ) {
+    return undefined;
+  }
+  return { pid, port };
+}
+
+function readConfig(vs: typeof vscode): AgentBridgeConfig {
+  const config = vs.workspace.getConfiguration('colab.agentBridge');
+
+  const enabled = config.get<boolean>('enabled', false);
+  const rawHost = config.get<string>('host', DEFAULT_HOST).trim();
+  const host = rawHost.length > 0 ? rawHost : DEFAULT_HOST;
+  const rawPort = config.get<number>('port', DEFAULT_PORT);
+  const port =
+    Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535
+      ? rawPort
+      : DEFAULT_PORT;
+  const token = config.get<string>('token', '').trim();
+  const allowRemoteHost = config.get<boolean>('allowRemoteHost', false);
+  const rawStateFile = config.get<string>('stateFile', DEFAULT_STATE_FILE);
+  const stateFile = resolveStateFilePath(rawStateFile.trim());
+
+  return {
+    enabled,
+    host,
+    port,
+    token,
+    allowRemoteHost,
+    stateFile,
+  };
+}
+
+function configsEqual(a?: AgentBridgeConfig, b?: AgentBridgeConfig): boolean {
+  if (!a || !b) {
+    return false;
+  }
+  return (
+    a.enabled === b.enabled &&
+    a.host === b.host &&
+    a.port === b.port &&
+    a.token === b.token &&
+    a.allowRemoteHost === b.allowRemoteHost &&
+    a.stateFile === b.stateFile
+  );
+}
+
+async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
+  return await new Promise<unknown>((resolve, reject) => {
+    const chunks: Buffer[] = [];
+    let totalBytes = 0;
+    let rejected = false;
+
+    req.on('data', (chunk: Buffer | string) => {
+      if (rejected) {
+        return;
+      }
+      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
+      totalBytes += buffer.byteLength;
+      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
+        rejected = true;
+        reject(
+          new HttpRequestError(
+            'PAYLOAD_TOO_LARGE',
+            413,
+            'Request body exceeds 1 MiB limit.',
+          ),
+        );
+        return;
+      }
+      chunks.push(buffer);
+    });
+
+    req.on('end', () => {
+      if (rejected) {
+        return;
+      }
+      if (chunks.length === 0) {
+        resolve({});
+        return;
+      }
+      const raw = Buffer.concat(chunks).toString('utf-8');
+      try {
+        resolve(JSON.parse(raw));
+      } catch (_error) {
+        reject(
+          new HttpRequestError(
+            'INVALID_JSON',
+            400,
+            'Request body must be valid JSON.',
+          ),
+        );
+      }
+    });
+
+    req.on('error', (error) => {
+      if (rejected) {
+        return;
+      }
+      reject(error);
+    });
+  });
+}
+
+function parseRequest(body: unknown): AgentBridgeRequest {
+  if (!isRecord(body)) {
+    throw new HttpRequestError(
+      'INVALID_REQUEST',
+      400,
+      'Request body must be a JSON object.',
+    );
+  }
+
+  const method = body.method;
+  if (typeof method !== 'string' || method.trim().length === 0) {
+    throw new HttpRequestError(
+      'INVALID_REQUEST',
+      400,
+      'Request "method" must be a non-empty string.',
+    );
+  }
+
+  const id = body.id;
+  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
+    throw new HttpRequestError(
+      'INVALID_REQUEST',
+      400,
+      'Request "id" must be a string or number.',
+    );
+  }
+
+  return {
+    id,
+    method,
+    params: body.params,
+  };
+}
+
+function getHeader(
+  req: http.IncomingMessage,
+  name: string,
+): string | undefined {
+  const value = req.headers[name];
+  if (value === undefined) {
+    return undefined;
+  }
+  if (Array.isArray(value)) {
+    return value[0];
+  }
+  return value;
+}
+
+function isAuthorizedRequest(
+  req: http.IncomingMessage,
+  config: AgentBridgeConfig,
+): boolean {
+  if (config.token.length === 0) {
+    return false;
+  }
+
+  const authHeader = getHeader(req, 'authorization');
+  if (authHeader === `Bearer ${config.token}`) {
+    return true;
+  }
+
+  const tokenHeader = getHeader(req, 'x-colab-agent-token');
+  return tokenHeader === config.token;
+}
+
+async function writeStateFile(
+  stateFilePath: string,
+  state: AgentBridgeStateFile,
+): Promise<void> {
+  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
+  await fs.writeFile(
+    stateFilePath,
+    `${JSON.stringify(state, undefined, 2)}\n`,
+    {
+      encoding: 'utf8',
+      mode: 0o600,
+    },
+  );
+  // Keep the discovery file readable only by the local user when possible.
+  try {
+    await fs.chmod(stateFilePath, 0o600);
+  } catch (_error) {
+    // Best-effort on platforms without chmod support.
+  }
+}
+
+async function removeStateFile(
+  stateFilePath: string,
+  expectedIdentity: AgentBridgeServerIdentity,
+): Promise<void> {
+  let shouldRemove = false;
+  try {
+    const raw = await fs.readFile(stateFilePath, 'utf8');
+    const parsed = JSON.parse(raw) as unknown;
+    const identity = parseStateFileIdentity(parsed);
+    shouldRemove =
+      identity !== undefined &&
+      identity.pid === expectedIdentity.pid &&
+      identity.port === expectedIdentity.port;
+  } catch (error: unknown) {
+    if (
+      typeof error === 'object' &&
+      error !== null &&
+      'code' in error &&
+      (error as { code?: string }).code === 'ENOENT'
+    ) {
+      return;
+    }
+    log.warn(`Unable to inspect agent bridge state file: ${stateFilePath}`, error);
+    return;
+  }
+
+  if (!shouldRemove) {
+    return;
+  }
+
+  try {
+    await fs.rm(stateFilePath, { force: true });
+  } catch (error: unknown) {
+    log.warn(`Unable to remove agent bridge state file: ${stateFilePath}`, error);
+  }
+}
+
+export class AgentBridgeController implements vscode.Disposable {
+  private readonly configListener: vscode.Disposable;
+  private refreshQueue: Promise<void> = Promise.resolve();
+  private isDisposed = false;
+  private activeConfig?: AgentBridgeConfig;
+  private activeStateIdentity?: AgentBridgeServerIdentity;
+  private server?: http.Server;
+
+  constructor(
+    private readonly vs: typeof vscode,
+    private readonly assignmentManager: AssignmentManager,
+  ) {
+    this.configListener = vs.workspace.onDidChangeConfiguration((event) => {
+      if (event.affectsConfiguration('colab.agentBridge')) {
+        this.scheduleRefresh();
+      }
+    });
+    this.scheduleRefresh();
+  }
+
+  dispose(): void {
+    if (this.isDisposed) {
+      return;
+    }
+    this.isDisposed = true;
+    this.configListener.dispose();
+    this.refreshQueue = this.refreshQueue
+      .then(() => this.stopServer())
+      .catch((error) => {
+        log.error('Error while stopping agent bridge during dispose.', error);
+      });
+  }
+
+  private scheduleRefresh(): void {
+    this.refreshQueue = this.refreshQueue
+      .then(async () => {
+        if (this.isDisposed) {
+          return;
+        }
+        await this.applyConfig();
+      })
+      .catch((error) => {
+        log.error('Error while refreshing agent bridge configuration.', error);
+      });
+  }
+
+  private async applyConfig(): Promise<void> {
+    const nextConfig = readConfig(this.vs);
+    if (!nextConfig.enabled) {
+      await this.stopServer();
+      return;
+    }
+
+    if (isWildcardBindHost(nextConfig.host)) {
+      await this.stopServer();
+      log.error(
+        `Agent bridge host "${nextConfig.host}" is not supported. Use a specific loopback or interface address.`,
+      );
+      void this.vs.window.showErrorMessage(
+        `Colab agent bridge host "${nextConfig.host}" is not supported.`,
+      );
+      return;
+    }
+
+    if (nextConfig.token.length === 0) {
+      await this.stopServer();
+      log.error(
+        'Agent bridge is enabled but colab.agentBridge.token is empty. Refusing to start.',
+      );
+      void this.vs.window.showErrorMessage(
+        'Colab agent bridge requires colab.agentBridge.token when enabled.',
+      );
+      return;
+    }
+
+    if (!nextConfig.allowRemoteHost && !isLoopbackHost(nextConfig.host)) {
+      await this.stopServer();
+      log.error(
+        `Agent bridge host "${nextConfig.host}" is not loopback. Set colab.agentBridge.allowRemoteHost=true only if you understand the security risks.`,
+      );
+      void this.vs.window.showErrorMessage(
+        `Colab agent bridge host "${nextConfig.host}" is blocked because it is not loopback.`,
+      );
+      return;
+    }
+
+    if (nextConfig.allowRemoteHost && !isLoopbackHost(nextConfig.host)) {
+      log.warn(
+        `Agent bridge is listening on non-loopback host "${nextConfig.host}".`,
+      );
+    }
+
+    if (this.server && configsEqual(this.activeConfig, nextConfig)) {
+      return;
+    }
+
+    await this.stopServer();
+    await this.startServer(nextConfig);
+  }
+
+  private async startServer(config: AgentBridgeConfig): Promise<void> {
+    const server = http.createServer((req, res) => {
+      void this.handleRequest(req, res, config);
+    });
+    // Notebook execution can exceed the default HTTP server request timeout.
+    server.requestTimeout = 0;
+    server.headersTimeout = 0;
+
+    await new Promise<void>((resolve, reject) => {
+      server.once('error', reject);
+      server.listen(config.port, config.host, () => {
+        server.off('error', reject);
+        resolve();
+      });
+    });
+
+    const address = server.address();
+    if (!address || typeof address === 'string') {
+      throw new Error('Failed to determine agent bridge listening address.');
+    }
+
+    this.server = server;
+    this.activeConfig = config;
+    this.activeStateIdentity = {
+      pid: process.pid,
+      port: address.port,
+    };
+
+    const endpointHost = formatHostForEndpoint(config.host);
+    const endpoint = `http://${endpointHost}:${address.port.toString()}${BRIDGE_ENDPOINT}`;
+    log.info(`Agent bridge listening at ${endpoint}`);
+
+    await writeStateFile(config.stateFile, {
+      version: 1,
+      host: config.host,
+      port: address.port,
+      endpoint,
+      tokenRequired: config.token.length > 0,
+      pid: process.pid,
+      startedAt: new Date().toISOString(),
+    });
+  }
+
+  private async stopServer(): Promise<void> {
+    const server = this.server;
+    const stateFilePath = this.activeConfig?.stateFile;
+    const stateIdentity = this.activeStateIdentity;
+    this.server = undefined;
+    this.activeConfig = undefined;
+    this.activeStateIdentity = undefined;
+
+    if (server) {
+      await new Promise<void>((resolve) => {
+        if (!server.listening) {
+          resolve();
+          return;
+        }
+        server.close((_error) => {
+          resolve();
+        });
+      });
+    }
+
+    if (stateFilePath && stateIdentity) {
+      await removeStateFile(stateFilePath, stateIdentity);
+    }
+  }
+
+  private async handleRequest(
+    req: http.IncomingMessage,
+    res: http.ServerResponse,
+    config: AgentBridgeConfig,
+  ): Promise<void> {
+    req.setTimeout(0);
+    res.setTimeout(0);
+    const requestPath = parseRequestPath(req.url);
+
+    if (requestPath === BRIDGE_HEALTH_ENDPOINT && req.method === 'GET') {
+      writeJson(res, 200, {
+        ok: true,
+        result: {
+          status: 'ok',
+        },
+      });
+      return;
+    }
+
+    if (requestPath !== BRIDGE_ENDPOINT) {
+      writeJson(res, 404, {
+        ok: false,
+        error: {
+          name: 'NotFoundError',
+          code: 'NOT_FOUND',
+          message: `Unknown endpoint "${req.url ?? ''}".`,
+        },
+      });
+      return;
+    }
+
+    if (req.method !== 'POST') {
+      writeJson(res, 405, {
+        ok: false,
+        error: {
+          name: 'MethodNotAllowedError',
+          code: 'METHOD_NOT_ALLOWED',
+          message: 'Use POST for bridge requests.',
+        },
+      });
+      return;
+    }
+
+    if (!hasJsonContentType(req)) {
+      writeJson(res, 415, {
+        ok: false,
+        error: {
+          name: 'UnsupportedMediaTypeError',
+          code: 'UNSUPPORTED_MEDIA_TYPE',
+          message: 'Requests must use Content-Type: application/json.',
+        },
+      });
+      return;
+    }
+
+    if (!isAuthorizedRequest(req, config)) {
+      writeJson(res, 401, {
+        ok: false,
+        error: {
+          name: 'UnauthorizedError',
+          code: 'UNAUTHORIZED',
+          message:
+            'Missing or invalid token. Use Authorization: Bearer <token>.',
+        },
+      });
+      return;
+    }
+
+    let request: AgentBridgeRequest;
+    try {
+      request = parseRequest(await readRequestBody(req));
+    } catch (error: unknown) {
+      const statusCode =
+        error instanceof HttpRequestError ? error.statusCode : 400;
+      writeJson(res, statusCode, toErrorResponse(error));
+      return;
+    }
+
+    try {
+      const result = await dispatchAgentBridgeRequest(
+        this.assignmentManager,
+        request,
+      );
+      writeJson(res, 200, {
+        id: request.id,
+        ok: true,
+        result,
+      });
+    } catch (error: unknown) {
+      writeJson(res, 200, toErrorResponse(error, request.id));
+    }
+  }
+}
```

### Diff: `src/colab/agent-bridge-http.unit.test.ts`
```diff
diff --git a/src/colab/agent-bridge-http.unit.test.ts b/src/colab/agent-bridge-http.unit.test.ts
new file mode 100644
index 0000000..bec5132
--- /dev/null
+++ b/src/colab/agent-bridge-http.unit.test.ts
@@ -0,0 +1,424 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { randomUUID } from 'crypto';
+import * as fs from 'fs/promises';
+import os from 'os';
+import path from 'path';
+import { expect } from 'chai';
+import sinon, { SinonStubbedInstance } from 'sinon';
+import {
+  ConfigurationChangeEvent,
+  WorkspaceConfiguration,
+} from 'vscode';
+import { AssignmentManager } from '../jupyter/assignments';
+import { TestEventEmitter } from '../test/helpers/events';
+import { newVsCodeStub, VsCodeStub } from '../test/helpers/vscode';
+import { AgentBridgeController } from './agent-bridge-http';
+
+interface BridgeSettings {
+  enabled: boolean;
+  host: string;
+  allowRemoteHost: boolean;
+  port: number;
+  token: string;
+  stateFile: string;
+}
+
+interface BridgeState {
+  readonly endpoint: string;
+  readonly host: string;
+  readonly port: number;
+  readonly pid: number;
+}
+
+function exists(filePath: string): Promise<boolean> {
+  return fs
+    .access(filePath)
+    .then(() => true)
+    .catch(() => false);
+}
+
+async function waitForPredicate(
+  predicate: () => boolean,
+  timeoutMs = 2_000,
+): Promise<void> {
+  const deadline = Date.now() + timeoutMs;
+  while (Date.now() < deadline) {
+    if (predicate()) {
+      return;
+    }
+    await new Promise((resolve) => setTimeout(resolve, 20));
+  }
+  throw new Error('Timed out waiting for predicate.');
+}
+
+async function waitForBridgeState(
+  stateFilePath: string,
+  timeoutMs = 2_000,
+): Promise<BridgeState> {
+  const deadline = Date.now() + timeoutMs;
+  while (Date.now() < deadline) {
+    try {
+      const raw = await fs.readFile(stateFilePath, 'utf8');
+      const parsed = JSON.parse(raw) as Partial<BridgeState>;
+      if (
+        typeof parsed.endpoint === 'string' &&
+        typeof parsed.host === 'string' &&
+        typeof parsed.port === 'number' &&
+        typeof parsed.pid === 'number'
+      ) {
+        return parsed as BridgeState;
+      }
+    } catch (_error) {
+      // Retry until timeout.
+    }
+    await new Promise((resolve) => setTimeout(resolve, 20));
+  }
+  throw new Error(`Timed out waiting for bridge state file: ${stateFilePath}`);
+}
+
+describe('Agent Bridge HTTP Controller', () => {
+  let vsCodeStub: VsCodeStub;
+  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
+  let configChangeEmitter: TestEventEmitter<ConfigurationChangeEvent>;
+  let settings: BridgeSettings;
+  let controller: AgentBridgeController | undefined;
+
+  beforeEach(() => {
+    vsCodeStub = newVsCodeStub();
+    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
+    configChangeEmitter = new TestEventEmitter<ConfigurationChangeEvent>();
+    vsCodeStub.workspace.onDidChangeConfiguration.callsFake(
+      configChangeEmitter.event,
+    );
+
+    settings = {
+      enabled: true,
+      host: '127.0.0.1',
+      allowRemoteHost: false,
+      port: 0,
+      token: 'test-agent-token',
+      stateFile: path.join(
+        os.tmpdir(),
+        `colab-agent-bridge-state-${randomUUID()}.json`,
+      ),
+    };
+
+    const workspaceConfig = {
+      get: <T>(section: string, defaultValue: T): T => {
+        const value = (settings as unknown as Record<string, unknown>)[section];
+        if (value === undefined) {
+          return defaultValue;
+        }
+        return value as T;
+      },
+    } as Pick<WorkspaceConfiguration, 'get'> as WorkspaceConfiguration;
+
+    vsCodeStub.workspace.getConfiguration
+      .withArgs('colab.agentBridge')
+      .returns(workspaceConfig);
+  });
+
+  afterEach(async () => {
+    if (controller) {
+      controller.dispose();
+      await new Promise((resolve) => setTimeout(resolve, 50));
+      controller = undefined;
+    }
+    await fs.rm(settings.stateFile, { force: true });
+    sinon.restore();
+  });
+
+  it('serves authorized bridge requests', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    const response = await fetch(state.endpoint, {
+      method: 'POST',
+      headers: {
+        authorization: `Bearer ${settings.token}`,
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        id: 'req-1',
+        method: 'ping',
+      }),
+    });
+
+    expect(response.status).to.equal(200);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly result: { readonly status: string };
+    };
+    expect(body.ok).to.equal(true);
+    expect(body.result.status).to.equal('ok');
+  });
+
+  it('serves health endpoint without authorization', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+    const healthEndpoint = state.endpoint.replace('/v1/colab-agent', '/healthz');
+
+    const response = await fetch(healthEndpoint);
+
+    expect(response.status).to.equal(200);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly result: { readonly status: string };
+    };
+    expect(body.ok).to.equal(true);
+    expect(body.result.status).to.equal('ok');
+  });
+
+  it('supports query parameters for the bridge endpoint', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    const response = await fetch(`${state.endpoint}?trace=1`, {
+      method: 'POST',
+      headers: {
+        authorization: `Bearer ${settings.token}`,
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        method: 'ping',
+      }),
+    });
+
+    expect(response.status).to.equal(200);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly result: { readonly status: string };
+    };
+    expect(body.ok).to.equal(true);
+    expect(body.result.status).to.equal('ok');
+  });
+
+  it('returns 401 when token is missing', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    const response = await fetch(state.endpoint, {
+      method: 'POST',
+      headers: {
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        method: 'ping',
+      }),
+    });
+
+    expect(response.status).to.equal(401);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly error: { readonly name: string };
+    };
+    expect(body.ok).to.equal(false);
+    expect(body.error.name).to.equal('UnauthorizedError');
+  });
+
+  it('returns 415 for non-json content type', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    const response = await fetch(state.endpoint, {
+      method: 'POST',
+      headers: {
+        authorization: `Bearer ${settings.token}`,
+        'content-type': 'text/plain',
+      },
+      body: '{"method":"ping"}',
+    });
+
+    expect(response.status).to.equal(415);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly error: { readonly name: string };
+    };
+    expect(body.ok).to.equal(false);
+    expect(body.error.name).to.equal('UnsupportedMediaTypeError');
+  });
+
+  it('returns 404 for unknown endpoints', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+    const unknownEndpoint = state.endpoint.replace(
+      '/v1/colab-agent',
+      '/v1/not-found',
+    );
+
+    const response = await fetch(unknownEndpoint, {
+      method: 'POST',
+      headers: {
+        authorization: `Bearer ${settings.token}`,
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        method: 'ping',
+      }),
+    });
+
+    expect(response.status).to.equal(404);
+  });
+
+  it('returns 405 for OPTIONS requests', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    const response = await fetch(state.endpoint, {
+      method: 'OPTIONS',
+    });
+
+    expect(response.status).to.equal(405);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly error: { readonly code?: string };
+    };
+    expect(body.ok).to.equal(false);
+    expect(body.error.code).to.equal('METHOD_NOT_ALLOWED');
+  });
+
+  it('returns 413 when request payload exceeds limit', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+    const oversizedPayload = 'x'.repeat(1024 * 1024);
+
+    const response = await fetch(state.endpoint, {
+      method: 'POST',
+      headers: {
+        authorization: `Bearer ${settings.token}`,
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        method: 'ping',
+        params: {
+          oversizedPayload,
+        },
+      }),
+    });
+
+    expect(response.status).to.equal(413);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly error: { readonly code?: string };
+    };
+    expect(body.ok).to.equal(false);
+    expect(body.error.code).to.equal('PAYLOAD_TOO_LARGE');
+  });
+
+  it('returns stable error codes for RPC failures', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    const response = await fetch(state.endpoint, {
+      method: 'POST',
+      headers: {
+        authorization: `Bearer ${settings.token}`,
+        'content-type': 'application/json',
+      },
+      body: JSON.stringify({
+        method: 'unsupported-method',
+      }),
+    });
+
+    expect(response.status).to.equal(200);
+    const body = (await response.json()) as {
+      readonly ok: boolean;
+      readonly error: { readonly code?: string };
+    };
+    expect(body.ok).to.equal(false);
+    expect(body.error.code).to.equal('UNSUPPORTED_METHOD');
+  });
+
+  it('refuses to start when token is empty', async () => {
+    settings.token = '';
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+
+    await waitForPredicate(() =>
+      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
+    );
+    expect(await exists(settings.stateFile)).to.equal(false);
+  });
+
+  it('blocks non-loopback host unless allowRemoteHost is enabled', async () => {
+    settings.host = '0.0.0.0';
+    settings.allowRemoteHost = false;
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+
+    await waitForPredicate(() =>
+      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
+    );
+    expect(await exists(settings.stateFile)).to.equal(false);
+  });
+
+  it('blocks wildcard host even when allowRemoteHost is enabled', async () => {
+    settings.host = '0.0.0.0';
+    settings.allowRemoteHost = true;
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+
+    await waitForPredicate(() =>
+      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
+    );
+    expect(await exists(settings.stateFile)).to.equal(false);
+  });
+
+  it('keeps state file when ownership does not match on shutdown', async () => {
+    controller = new AgentBridgeController(
+      vsCodeStub.asVsCode(),
+      assignmentManagerStub,
+    );
+    const state = await waitForBridgeState(settings.stateFile);
+
+    await fs.writeFile(
+      settings.stateFile,
+      `${JSON.stringify({ ...state, pid: state.pid + 1 }, undefined, 2)}\n`,
+      'utf8',
+    );
+
+    controller.dispose();
+    controller = undefined;
+    await new Promise((resolve) => setTimeout(resolve, 50));
+
+    expect(await exists(settings.stateFile)).to.equal(true);
+  });
+});
```

### Diff: `src/colab/agent-bridge-rpc.ts`
```diff
diff --git a/src/colab/agent-bridge-rpc.ts b/src/colab/agent-bridge-rpc.ts
new file mode 100644
index 0000000..259cd26
--- /dev/null
+++ b/src/colab/agent-bridge-rpc.ts
@@ -0,0 +1,468 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { AssignmentManager } from '../jupyter/assignments';
+import { Shape, Variant } from './api';
+import {
+  AgentBridgeOutputMode,
+  AgentBridgeRenderMode,
+  formatNotebookExecuteResult,
+  formatNotebookRunAllResult,
+} from './agent-bridge-format';
+import {
+  AgentListRuntimesArgs,
+  AgentRuntimeScope,
+  AgentRuntimeService,
+  AgentRuntimeStatusArgs,
+  AgentStartMode,
+  AgentStartRuntimeArgs,
+  AgentStopRuntimeArgs,
+  NotebookExecuteArgs,
+  NotebookRunAllArgs,
+  RuntimeFilesWriteTextArgs,
+  RuntimeSecretsSyncArgs,
+} from './agent-runtime-service';
+
+export type AgentBridgeMethod =
+  | 'ping'
+  | 'bridge.capabilities'
+  | 'runtimes.list'
+  | 'runtimes.start'
+  | 'runtimes.stop'
+  | 'runtimes.status'
+  | 'notebook.execute'
+  | 'notebook.runAll'
+  | 'runtime.files.writeText'
+  | 'runtime.secrets.sync';
+
+export type AgentBridgeErrorCode =
+  | 'INVALID_PARAMS'
+  | 'UNSUPPORTED_METHOD';
+
+const SUPPORTED_METHODS: readonly AgentBridgeMethod[] = [
+  'ping',
+  'bridge.capabilities',
+  'runtimes.list',
+  'runtimes.start',
+  'runtimes.stop',
+  'runtimes.status',
+  'notebook.execute',
+  'notebook.runAll',
+  'runtime.files.writeText',
+  'runtime.secrets.sync',
+];
+
+interface BridgeCapabilitiesResult {
+  readonly bridgeVersion: 1;
+  readonly methods: readonly AgentBridgeMethod[];
+  readonly notes: readonly string[];
+}
+
+export interface AgentBridgeRequest {
+  readonly id?: string | number;
+  readonly method: string;
+  readonly params?: unknown;
+}
+
+export class AgentBridgeError extends Error {
+  constructor(
+    readonly code: AgentBridgeErrorCode,
+    message: string,
+  ) {
+    super(message);
+    this.name = 'AgentBridgeError';
+  }
+}
+
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
+}
+
+function invalidParams(message: string): AgentBridgeError {
+  return new AgentBridgeError('INVALID_PARAMS', message);
+}
+
+function parseParams(params: unknown): Record<string, unknown> {
+  if (params === undefined) {
+    return {};
+  }
+  if (!isRecord(params)) {
+    throw invalidParams('Request "params" must be an object.');
+  }
+  return params;
+}
+
+function parseOptionalString(
+  value: unknown,
+  fieldName: string,
+): string | undefined {
+  if (value === undefined) {
+    return undefined;
+  }
+  if (typeof value !== 'string') {
+    throw invalidParams(`Invalid "${fieldName}" value. Expected a string.`);
+  }
+  const trimmed = value.trim();
+  return trimmed.length > 0 ? trimmed : undefined;
+}
+
+function getOptionalBoolean(value: unknown, defaultValue: boolean): boolean {
+  if (value === undefined) {
+    return defaultValue;
+  }
+  if (typeof value !== 'boolean') {
+    throw invalidParams('Expected a boolean value.');
+  }
+  return value;
+}
+
+function parseStartMode(value: unknown): AgentStartMode | undefined {
+  const mode = parseOptionalString(value, 'mode');
+  if (!mode) {
+    return undefined;
+  }
+  if (mode === 'latestOrCreate' || mode === 'new') {
+    return mode;
+  }
+  throw invalidParams('Invalid "mode" value. Use "latestOrCreate" or "new".');
+}
+
+function parseVariant(value: unknown): Variant | undefined {
+  if (value === undefined) {
+    return undefined;
+  }
+  if (typeof value !== 'string') {
+    throw invalidParams('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
+  }
+  const normalized = value.trim().toUpperCase();
+  switch (normalized) {
+    case Variant.DEFAULT:
+    case Variant.GPU:
+    case Variant.TPU:
+      return normalized;
+    default:
+      throw invalidParams('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
+  }
+}
+
+function parseShape(value: unknown): Shape | undefined {
+  if (value === undefined) {
+    return undefined;
+  }
+  if (typeof value === 'number') {
+    if (value === Shape.STANDARD || value === Shape.HIGHMEM) {
+      return value;
+    }
+    throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
+  }
+  if (typeof value !== 'string') {
+    throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
+  }
+
+  const normalized = value.trim().toUpperCase();
+  switch (normalized) {
+    case 'STANDARD':
+    case '0':
+      return Shape.STANDARD;
+    case 'HIGHMEM':
+    case '1':
+      return Shape.HIGHMEM;
+    default:
+      throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
+  }
+}
+
+function parseTimeoutMs(value: unknown, fieldName = 'timeoutMs'): number {
+  if (value === undefined) {
+    return AgentRuntimeService.validateTimeoutMs(undefined, fieldName);
+  }
+  if (typeof value !== 'number') {
+    throw invalidParams(`${fieldName} must be an integer.`);
+  }
+  return AgentRuntimeService.validateTimeoutMs(value, fieldName);
+}
+
+function parseOutputMode(value: unknown): AgentBridgeOutputMode {
+  if (value === undefined) {
+    return 'compact';
+  }
+  if (typeof value !== 'string') {
+    throw invalidParams('Invalid "outputMode" value. Use "compact" or "raw".');
+  }
+  const normalized = value.trim().toLowerCase();
+  if (normalized === 'compact' || normalized === 'raw') {
+    return normalized;
+  }
+  throw invalidParams('Invalid "outputMode" value. Use "compact" or "raw".');
+}
+
+function parseRenderMode(value: unknown): AgentBridgeRenderMode {
+  if (value === undefined) {
+    return 'markdown';
+  }
+  if (typeof value !== 'string') {
+    throw invalidParams('Invalid "render" value. Use "none" or "markdown".');
+  }
+  const normalized = value.trim().toLowerCase();
+  if (normalized === 'none' || normalized === 'markdown') {
+    return normalized;
+  }
+  throw invalidParams('Invalid "render" value. Use "none" or "markdown".');
+}
+
+function parseRuntimeScope(value: unknown): AgentRuntimeScope | undefined {
+  const from = parseOptionalString(value, 'from');
+  if (from === undefined) {
+    return undefined;
+  }
+  if (from === 'extension' || from === 'external' || from === 'all') {
+    return from;
+  }
+  throw invalidParams('Invalid "from" value. Use extension, external, or all.');
+}
+
+function toListRuntimesArgs(
+  params: Record<string, unknown>,
+): AgentListRuntimesArgs {
+  return {
+    from: parseRuntimeScope(params.from),
+  };
+}
+
+function toStartRuntimeArgs(
+  params: Record<string, unknown>,
+): AgentStartRuntimeArgs {
+  return {
+    mode: parseStartMode(params.mode),
+    label: parseOptionalString(params.label, 'label'),
+    variant: parseVariant(params.variant),
+    accelerator: parseOptionalString(params.accelerator, 'accelerator'),
+    shape: parseShape(params.shape),
+    version: parseOptionalString(params.version, 'version'),
+  };
+}
+
+function toStopRuntimeArgs(
+  params: Record<string, unknown>,
+): AgentStopRuntimeArgs {
+  return {
+    from: parseRuntimeScope(params.from),
+    id: parseOptionalString(params.id, 'id'),
+    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
+    label: parseOptionalString(params.label, 'label'),
+    all: getOptionalBoolean(params.all, false),
+  };
+}
+
+function toRuntimeStatusArgs(
+  params: Record<string, unknown>,
+): AgentRuntimeStatusArgs {
+  return {
+    from: parseRuntimeScope(params.from),
+    id: parseOptionalString(params.id, 'id'),
+    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
+    label: parseOptionalString(params.label, 'label'),
+    all: getOptionalBoolean(params.all, false),
+  };
+}
+
+function toNotebookExecuteArgs(
+  params: Record<string, unknown>,
+): {
+  readonly args: NotebookExecuteArgs;
+  readonly outputMode: AgentBridgeOutputMode;
+  readonly render: AgentBridgeRenderMode;
+} {
+  const code = params.code;
+  if (typeof code !== 'string' || code.trim().length === 0) {
+    throw invalidParams('notebook.execute requires a non-empty "code" string.');
+  }
+
+  return {
+    args: {
+      code,
+      from: parseRuntimeScope(params.from),
+      id: parseOptionalString(params.id, 'id'),
+      endpoint: parseOptionalString(params.endpoint, 'endpoint'),
+      label: parseOptionalString(params.label, 'label'),
+      timeoutMs: parseTimeoutMs(params.timeoutMs, 'timeoutMs'),
+      kernelName: parseOptionalString(params.kernelName, 'kernelName'),
+      cleanupSession: getOptionalBoolean(params.cleanupSession, true),
+    },
+    outputMode: parseOutputMode(params.outputMode),
+    render: parseRenderMode(params.render),
+  };
+}
+
+function toNotebookRunAllArgs(
+  params: Record<string, unknown>,
+): {
+  readonly args: NotebookRunAllArgs;
+  readonly outputMode: AgentBridgeOutputMode;
+  readonly render: AgentBridgeRenderMode;
+} {
+  const notebookPath = parseOptionalString(params.notebookPath, 'notebookPath');
+  if (!notebookPath) {
+    throw invalidParams(
+      'notebook.runAll requires a non-empty "notebookPath" string.',
+    );
+  }
+  if (params.saveResultPath !== undefined) {
+    throw invalidParams(
+      'notebook.runAll does not support "saveResultPath". Save results in the client process.',
+    );
+  }
+
+  return {
+    args: {
+      notebookPath,
+      from: parseRuntimeScope(params.from),
+      id: parseOptionalString(params.id, 'id'),
+      endpoint: parseOptionalString(params.endpoint, 'endpoint'),
+      label: parseOptionalString(params.label, 'label'),
+      timeoutMsPerCell: parseTimeoutMs(params.timeoutMsPerCell, 'timeoutMsPerCell'),
+      stopOnError: getOptionalBoolean(params.stopOnError, true),
+      kernelName: parseOptionalString(params.kernelName, 'kernelName'),
+      cleanupSession: getOptionalBoolean(params.cleanupSession, true),
+      saveCellsRuntimeDir: parseOptionalString(
+        params.saveCellsRuntimeDir,
+        'saveCellsRuntimeDir',
+      ),
+    },
+    outputMode: parseOutputMode(params.outputMode),
+    render: parseRenderMode(params.render),
+  };
+}
+
+function toRuntimeFilesWriteTextArgs(
+  params: Record<string, unknown>,
+): RuntimeFilesWriteTextArgs {
+  const runtimePath = parseOptionalString(params.runtimePath, 'runtimePath');
+  if (!runtimePath) {
+    throw invalidParams(
+      'runtime.files.writeText requires a non-empty "runtimePath" string.',
+    );
+  }
+
+  const text = params.text;
+  if (typeof text !== 'string') {
+    throw invalidParams('runtime.files.writeText requires a "text" string.');
+  }
+
+  return {
+    runtimePath,
+    text,
+    from: parseRuntimeScope(params.from),
+    id: parseOptionalString(params.id, 'id'),
+    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
+    label: parseOptionalString(params.label, 'label'),
+    createDirectories: getOptionalBoolean(params.createDirectories, true),
+  };
+}
+
+function toRuntimeSecretsSyncArgs(
+  params: Record<string, unknown>,
+): RuntimeSecretsSyncArgs {
+  const tokenCandidates = [
+    params.hfToken,
+    params.HF_TOKEN,
+    params.hfAccessToken,
+    params.HF_ACCESS_TOKEN,
+  ];
+  const hfToken = tokenCandidates.find(
+    (value): value is string =>
+      typeof value === 'string' && value.trim().length > 0,
+  );
+  if (!hfToken) {
+    throw invalidParams(
+      'runtime.secrets.sync requires a non-empty "hfToken" string (or HF_TOKEN/HF_ACCESS_TOKEN).',
+    );
+  }
+
+  return {
+    hfToken: hfToken.trim(),
+    from: parseRuntimeScope(params.from),
+    id: parseOptionalString(params.id, 'id'),
+    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
+    label: parseOptionalString(params.label, 'label'),
+    writeIpythonStartup: getOptionalBoolean(params.writeIpythonStartup, true),
+    writeHfHomeTokenFile: getOptionalBoolean(params.writeHfHomeTokenFile, true),
+    writeHfCacheTokenFile: getOptionalBoolean(params.writeHfCacheTokenFile, true),
+    verifyRuntimeEnv: getOptionalBoolean(params.verifyRuntimeEnv, true),
+  };
+}
+
+function bridgeCapabilities(): BridgeCapabilitiesResult {
+  return {
+    bridgeVersion: 1,
+    methods: SUPPORTED_METHODS,
+    notes: [
+      'Execution methods reuse extension-assigned runtimes and run headless.',
+      'Execution defaults to outputMode=compact with render=markdown for agent readability.',
+      'Use notebook.runAll to execute an .ipynb end-to-end in one API call.',
+      'runtime.files.writeText can target /content/drive/... when Drive is mounted.',
+      'runtime.secrets.sync stores HF token in runtime files and startup hooks without echoing the token.',
+    ],
+  };
+}
+
+export async function dispatchAgentBridgeRequest(
+  assignmentManager: AssignmentManager,
+  request: AgentBridgeRequest,
+): Promise<unknown> {
+  const method = request.method as AgentBridgeMethod;
+  const params = parseParams(request.params);
+  const runtimeService = new AgentRuntimeService(assignmentManager);
+
+  switch (method) {
+    case 'ping':
+      return {
+        status: 'ok',
+        now: new Date().toISOString(),
+      };
+    case 'bridge.capabilities':
+      return bridgeCapabilities();
+    case 'runtimes.list':
+      return await runtimeService.listRuntimes(toListRuntimesArgs(params));
+    case 'runtimes.start':
+      return await runtimeService.startRuntime(toStartRuntimeArgs(params));
+    case 'runtimes.stop':
+      return await runtimeService.stopRuntime(toStopRuntimeArgs(params));
+    case 'runtimes.status':
+      return await runtimeService.runtimeStatus(toRuntimeStatusArgs(params));
+    case 'notebook.execute': {
+      const requestArgs = toNotebookExecuteArgs(params);
+      const raw = await runtimeService.notebookExecute(requestArgs.args);
+      return formatNotebookExecuteResult(
+        raw,
+        requestArgs.outputMode,
+        requestArgs.render,
+      );
+    }
+    case 'notebook.runAll': {
+      const requestArgs = toNotebookRunAllArgs(params);
+      const raw = await runtimeService.notebookRunAll(requestArgs.args);
+      return formatNotebookRunAllResult(
+        raw,
+        requestArgs.outputMode,
+        requestArgs.render,
+      );
+    }
+    case 'runtime.files.writeText':
+      return await runtimeService.runtimeFilesWriteText(
+        toRuntimeFilesWriteTextArgs(params),
+      );
+    case 'runtime.secrets.sync':
+      return await runtimeService.runtimeSecretsSync(
+        toRuntimeSecretsSyncArgs(params),
+      );
+    default:
+      throw new AgentBridgeError(
+        'UNSUPPORTED_METHOD',
+        `Unsupported method "${request.method}".`,
+      );
+  }
+}
```

### Diff: `src/colab/agent-bridge.ts`
```diff
diff --git a/src/colab/agent-bridge.ts b/src/colab/agent-bridge.ts
new file mode 100644
index 0000000..5c066e5
--- /dev/null
+++ b/src/colab/agent-bridge.ts
@@ -0,0 +1,12 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+export { AgentBridgeController } from './agent-bridge-http';
+export {
+  dispatchAgentBridgeRequest,
+  type AgentBridgeMethod,
+  type AgentBridgeRequest,
+} from './agent-bridge-rpc';
```

### Diff: `src/colab/agent-bridge.unit.test.ts`
```diff
diff --git a/src/colab/agent-bridge.unit.test.ts b/src/colab/agent-bridge.unit.test.ts
new file mode 100644
index 0000000..28f532d
--- /dev/null
+++ b/src/colab/agent-bridge.unit.test.ts
@@ -0,0 +1,363 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { randomUUID } from 'crypto';
+import { expect } from 'chai';
+import sinon, { SinonStubbedInstance } from 'sinon';
+import { Variant } from './api';
+import { dispatchAgentBridgeRequest } from './agent-bridge';
+import { AgentRuntimeService } from './agent-runtime-service';
+import { AssignmentManager } from '../jupyter/assignments';
+import { ColabAssignedServer } from '../jupyter/servers';
+import { newVsCodeStub, VsCodeStub } from '../test/helpers/vscode';
+
+describe('Agent Bridge', () => {
+  let vsCodeStub: VsCodeStub;
+  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
+  let server: ColabAssignedServer;
+
+  beforeEach(() => {
+    vsCodeStub = newVsCodeStub();
+    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
+    server = {
+      id: randomUUID(),
+      label: 'runtime-a',
+      variant: Variant.DEFAULT,
+      endpoint: 'm-s-runtime-a',
+      accelerator: undefined,
+      shape: undefined,
+      version: undefined,
+      connectionInformation: {
+        baseUrl: vsCodeStub.Uri.parse('https://example.com'),
+        token: '123',
+        tokenExpiry: new Date(Date.now() + 60_000),
+        headers: {},
+      },
+      dateAssigned: new Date('2026-01-01T00:00:00.000Z'),
+    };
+  });
+
+  afterEach(() => {
+    sinon.restore();
+  });
+
+  it('handles ping requests', async () => {
+    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
+      method: 'ping',
+    })) as {
+      status: string;
+      now: string;
+    };
+
+    expect(response.status).to.equal('ok');
+    expect(new Date(response.now).toString()).to.not.equal('Invalid Date');
+  });
+
+  it('returns bridge capabilities', async () => {
+    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
+      method: 'bridge.capabilities',
+    })) as {
+      bridgeVersion: number;
+      methods: string[];
+    };
+
+    expect(response.bridgeVersion).to.equal(1);
+    expect(response.methods).to.include('notebook.runAll');
+    expect(response.methods).to.include('runtime.files.writeText');
+    expect(response.methods).to.include('runtime.secrets.sync');
+  });
+
+  it('delegates runtime list requests to agent commands', async () => {
+    (assignmentManagerStub.getServers as sinon.SinonStub)
+      .withArgs('extension')
+      .resolves([server]);
+
+    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
+      method: 'runtimes.list',
+      params: { from: 'extension' },
+    })) as {
+      scope: string;
+      counts: {
+        assigned: number;
+        unowned: number;
+        total: number;
+      };
+    };
+
+    expect(response.scope).to.equal('extension');
+    expect(response.counts).to.deep.equal({
+      assigned: 1,
+      unowned: 0,
+      total: 1,
+    });
+  });
+
+  it('rejects non-object params', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtimes.list',
+        params: [],
+      }),
+    ).to.eventually.be.rejectedWith('Request "params" must be an object.');
+  });
+
+  it('rejects unknown methods', async () => {
+    try {
+      await dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'unsupported-method',
+      });
+      expect.fail('Expected method dispatch to fail.');
+    } catch (error) {
+      expect(error).to.be.instanceOf(Error);
+      const withCode = error as { code?: string; message?: string };
+      expect(withCode.code).to.equal('UNSUPPORTED_METHOD');
+      expect(withCode.message).to.equal('Unsupported method "unsupported-method".');
+    }
+  });
+
+  it('rejects notebook.execute when code is missing', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'notebook.execute',
+        params: {},
+      }),
+    ).to.eventually.be.rejectedWith(
+      'notebook.execute requires a non-empty "code" string.',
+    );
+  });
+
+  it('rejects notebook.runAll when notebookPath is missing', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'notebook.runAll',
+        params: {},
+      }),
+    ).to.eventually.be.rejectedWith(
+      'notebook.runAll requires a non-empty "notebookPath" string.',
+    );
+  });
+
+  it('rejects runtime.files.writeText when runtimePath is missing', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtime.files.writeText',
+        params: { text: 'hello' },
+      }),
+    ).to.eventually.be.rejectedWith(
+      'runtime.files.writeText requires a non-empty "runtimePath" string.',
+    );
+  });
+
+  it('rejects runtime.secrets.sync when hfToken is missing', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtime.secrets.sync',
+        params: {},
+      }),
+    ).to.eventually.be.rejectedWith(
+      'runtime.secrets.sync requires a non-empty "hfToken" string (or HF_TOKEN/HF_ACCESS_TOKEN).',
+    );
+  });
+
+  it('rejects invalid runtime scope values in execution requests', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'notebook.execute',
+        params: {
+          code: 'print(1)',
+          from: 'invalid-scope',
+        },
+      }),
+    ).to.eventually.be.rejectedWith(
+      'Invalid "from" value. Use extension, external, or all.',
+    );
+  });
+
+  it('rejects invalid runtime scope values in lifecycle requests', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtimes.list',
+        params: {
+          from: 'invalid-scope',
+        },
+      }),
+    ).to.eventually.be.rejectedWith(
+      'Invalid "from" value. Use extension, external, or all.',
+    );
+  });
+
+  it('rejects non-string selector values in lifecycle requests', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtimes.status',
+        params: {
+          id: 123,
+        },
+      }),
+    ).to.eventually.be.rejectedWith('Invalid "id" value. Expected a string.');
+  });
+
+  it('rejects invalid start descriptor values', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtimes.start',
+        params: {
+          mode: 'new',
+          variant: 'wrong-variant',
+        },
+      }),
+    ).to.eventually.be.rejectedWith(
+      'Invalid "variant" value. Use DEFAULT, GPU, or TPU.',
+    );
+
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'runtimes.start',
+        params: {
+          mode: 'new',
+          shape: 'wrong-shape',
+        },
+      }),
+    ).to.eventually.be.rejectedWith(
+      'Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.',
+    );
+  });
+
+  it('rejects non-integer timeout values in execution requests', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'notebook.execute',
+        params: {
+          code: 'print(1)',
+          timeoutMs: '1000',
+        },
+      }),
+    ).to.eventually.be.rejectedWith('timeoutMs must be an integer.');
+  });
+
+  it('rejects notebook.runAll saveResultPath for bridge requests', async () => {
+    await expect(
+      dispatchAgentBridgeRequest(assignmentManagerStub, {
+        method: 'notebook.runAll',
+        params: {
+          notebookPath: './test.ipynb',
+          saveResultPath: '/tmp/results.json',
+        },
+      }),
+    ).to.eventually.be.rejectedWith(
+      'notebook.runAll does not support "saveResultPath". Save results in the client process.',
+    );
+  });
+
+  it('returns compact markdown-friendly output for notebook.runAll by default', async () => {
+    sinon.stub(AgentRuntimeService.prototype, 'notebookRunAll').resolves({
+      runtime: {
+        owner: 'extension',
+        id: randomUUID(),
+        label: 'Colab CPU',
+        endpoint: 'm-s-test',
+        variant: Variant.DEFAULT,
+        accelerator: 'NONE',
+        dateAssigned: new Date('2026-01-01T00:00:00.000Z').toISOString(),
+        baseUrl: 'https://example.com/',
+        tokenExpiry: new Date('2026-01-01T01:00:00.000Z').toISOString(),
+      },
+      notebookPath: '/tmp/example.ipynb',
+      sessionId: 'session-id',
+      kernelId: 'kernel-id',
+      kernelName: 'python3',
+      status: 'ok',
+      totalCodeCells: 1,
+      executedCells: 1,
+      failedCells: 0,
+      stoppedOnError: false,
+      elapsedMs: 10,
+      cleanedUpSession: true,
+      cells: [
+        {
+          cellIndex: 0,
+          executionIndex: 1,
+          status: 'ok',
+          elapsedMs: 10,
+          sourcePreview: 'print(1)',
+          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
+          reply: {},
+        },
+      ],
+    } as Awaited<ReturnType<AgentRuntimeService['notebookRunAll']>>);
+
+    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
+      method: 'notebook.runAll',
+      params: {
+        notebookPath: '/tmp/example.ipynb',
+      },
+    })) as {
+      readonly format: string;
+      readonly cells: readonly { readonly logs: string; readonly ok: boolean }[];
+      readonly summaryMarkdown?: string;
+    };
+
+    expect(response.format).to.equal('compact');
+    expect(response.cells).to.have.length(1);
+    expect(response.cells[0].ok).to.equal(true);
+    expect(response.cells[0].logs).to.equal('1');
+    expect(response.summaryMarkdown).to.contain('# Notebook RunAll Result');
+  });
+
+  it('supports outputMode=raw to preserve rich notebook payloads', async () => {
+    sinon.stub(AgentRuntimeService.prototype, 'notebookRunAll').resolves({
+      runtime: {
+        owner: 'extension',
+        id: randomUUID(),
+        label: 'Colab CPU',
+        endpoint: 'm-s-test',
+        variant: Variant.DEFAULT,
+        accelerator: 'NONE',
+        dateAssigned: new Date('2026-01-01T00:00:00.000Z').toISOString(),
+        baseUrl: 'https://example.com/',
+        tokenExpiry: new Date('2026-01-01T01:00:00.000Z').toISOString(),
+      },
+      notebookPath: '/tmp/example.ipynb',
+      sessionId: 'session-id',
+      kernelId: 'kernel-id',
+      kernelName: 'python3',
+      status: 'ok',
+      totalCodeCells: 1,
+      executedCells: 1,
+      failedCells: 0,
+      stoppedOnError: false,
+      elapsedMs: 10,
+      cleanedUpSession: true,
+      cells: [
+        {
+          cellIndex: 0,
+          executionIndex: 1,
+          status: 'ok',
+          elapsedMs: 10,
+          sourcePreview: 'print(1)',
+          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
+          reply: { status: 'ok' },
+        },
+      ],
+    } as Awaited<ReturnType<AgentRuntimeService['notebookRunAll']>>);
+
+    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
+      method: 'notebook.runAll',
+      params: {
+        notebookPath: '/tmp/example.ipynb',
+        outputMode: 'raw',
+        render: 'none',
+      },
+    })) as {
+      readonly format?: string;
+      readonly cells: readonly { readonly outputs?: readonly unknown[] }[];
+    };
+
+    expect(response.format).to.equal(undefined);
+    expect(response.cells).to.have.length(1);
+    expect(response.cells[0].outputs).to.have.length(1);
+  });
+});
```

### Diff: `src/colab/agent-runtime-service.ts`
```diff
diff --git a/src/colab/agent-runtime-service.ts b/src/colab/agent-runtime-service.ts
new file mode 100644
index 0000000..9b84620
--- /dev/null
+++ b/src/colab/agent-runtime-service.ts
@@ -0,0 +1,8 @@
+/**
+ * @license
+ * Copyright 2026 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+export { AgentRuntimeService } from './agent-runtime/service';
+export * from './agent-runtime/types';
```

## 9) Full Source For New Agent Files

### File: `scripts/colab-agent-bridge.mts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';

interface BridgeState {
  readonly endpoint?: string;
  readonly host: string;
  readonly port: number;
}

function resolveStateFilePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/colab-agent-bridge.mts <method> [json-params|@params-file|-]',
    '',
    'Examples:',
    '  npx tsx scripts/colab-agent-bridge.mts ping',
    '  npx tsx scripts/colab-agent-bridge.mts bridge.capabilities',
    "  npx tsx scripts/colab-agent-bridge.mts runtimes.list '{\"from\":\"all\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtimes.start '{\"mode\":\"latestOrCreate\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts notebook.execute '{\"code\":\"print(123)\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts notebook.runAll '{\"notebookPath\":\"./notebooks/00_env_check.ipynb\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtime.files.writeText '{\"runtimePath\":\"/content/drive/MyDrive/voice-moonshot/notes.txt\",\"text\":\"hello\"}'",
    "  npx tsx scripts/colab-agent-bridge.mts runtime.secrets.sync @/tmp/hf-sync.json",
    "  cat /tmp/hf-sync.json | npx tsx scripts/colab-agent-bridge.mts runtime.secrets.sync -",
    '',
    'Environment:',
    '  COLAB_AGENT_BRIDGE_STATE_FILE (optional)',
    '  COLAB_AGENT_BRIDGE_TOKEN (required)',
  ].join('\n');
}

async function readStdinText(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', reject);
  });
}

async function parseParams(rawParams?: string): Promise<unknown> {
  if (!rawParams) {
    return {};
  }

  let source = rawParams;
  if (rawParams === '-') {
    source = (await readStdinText()).trim();
  } else if (rawParams.startsWith('@')) {
    const paramsFile = path.resolve(rawParams.slice(1));
    source = (await readFile(paramsFile, 'utf8')).trim();
  }

  if (source.length === 0) {
    return {};
  }

  return JSON.parse(source);
}

async function getEndpointFromStateFile(
  stateFilePath: string,
): Promise<string> {
  const raw = await readFile(stateFilePath, 'utf8');
  const state = JSON.parse(raw) as BridgeState;
  if (state.endpoint && state.endpoint.length > 0) {
    return state.endpoint;
  }
  return `http://${state.host}:${state.port.toString()}/v1/colab-agent`;
}

async function main(): Promise<void> {
  const [method, rawParams] = process.argv.slice(2);
  if (!method) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  let params: unknown;
  if (rawParams) {
    try {
      params = await parseParams(rawParams);
    } catch (_error) {
      console.error('json-params must be valid JSON.');
      process.exitCode = 2;
      return;
    }
  } else {
    params = {};
  }

  const stateFile = resolveStateFilePath(
    process.env.COLAB_AGENT_BRIDGE_STATE_FILE ?? DEFAULT_STATE_FILE,
  );
  const endpoint = await getEndpointFromStateFile(stateFile);
  const token = process.env.COLAB_AGENT_BRIDGE_TOKEN?.trim();
  if (!token) {
    console.error('COLAB_AGENT_BRIDGE_TOKEN is required.');
    process.exitCode = 2;
    return;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: `${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
      method,
      params,
    }),
  });
  const payload = (await response.json()) as {
    readonly ok?: boolean;
  };

  console.log(JSON.stringify(payload, undefined, 2));

  if (!response.ok || payload.ok === false) {
    process.exitCode = 1;
  }
}

void main();
```

### File: `src/colab/agent-bridge-format.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  NotebookExecuteResult,
  NotebookExecutionOutput,
  NotebookRunAllResult,
  NotebookRunCellResult,
} from './agent-runtime-service';

export type AgentBridgeOutputMode = 'raw' | 'compact';
export type AgentBridgeRenderMode = 'none' | 'markdown';

interface CompactError {
  readonly name: string;
  readonly message: string;
}

interface CompactNotebookCell {
  readonly cellIndex: number;
  readonly executionIndex: number;
  readonly ok: boolean;
  readonly status: 'ok' | 'error';
  readonly logs: string;
  readonly error?: CompactError;
}

interface CompactNotebookExecuteResult {
  readonly format: 'compact';
  readonly ok: boolean;
  readonly status: 'ok' | 'error';
  readonly runtime: NotebookExecuteResult['runtime'];
  readonly sessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly elapsedMs: number;
  readonly cleanedUpSession: boolean;
  readonly logs: string;
  readonly error?: CompactError;
  readonly summaryMarkdown?: string;
}

interface CompactNotebookRunAllResult {
  readonly format: 'compact';
  readonly ok: boolean;
  readonly status: 'ok' | 'error';
  readonly runtime: NotebookRunAllResult['runtime'];
  readonly notebookPath: string;
  readonly sessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly totalCodeCells: number;
  readonly executedCells: number;
  readonly failedCells: number;
  readonly stoppedOnError: boolean;
  readonly elapsedMs: number;
  readonly cleanedUpSession: boolean;
  readonly cells: readonly CompactNotebookCell[];
  readonly summaryMarkdown?: string;
}

interface MarkdownAttachable {
  readonly summaryMarkdown?: string;
}

function sanitizeText(value: string): string {
  // Strip ANSI escapes for agent readability.
  return value.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function outputText(output: NotebookExecutionOutput): string {
  switch (output.type) {
    case 'stream':
      return output.text ?? '';
    case 'execute_result':
    case 'display_data':
      if (output.text && output.text.length > 0) {
        return output.text;
      }
      return JSON.stringify(output.data ?? {});
    case 'error':
      if (output.traceback && output.traceback.length > 0) {
        return output.traceback.join('\n');
      }
      return `${output.ename ?? 'Error'}: ${output.evalue ?? 'Execution failed.'}`;
    default:
      return '';
  }
}

function collectLogs(outputs: readonly NotebookExecutionOutput[]): string {
  const chunks = outputs
    .map(outputText)
    .map((chunk) => sanitizeText(chunk))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  return chunks.join('\n');
}

function firstErrorFromOutputs(
  outputs: readonly NotebookExecutionOutput[],
): CompactError | undefined {
  for (const output of outputs) {
    if (output.type !== 'error') {
      continue;
    }
    return {
      name: output.ename ?? 'ExecutionError',
      message: output.evalue ?? 'Execution failed.',
    };
  }
  return undefined;
}

function renderExecuteMarkdown(
  result: CompactNotebookExecuteResult,
): string {
  const lines: string[] = [
    '# Notebook Execute Result',
    '',
    `- Status: ${result.ok ? 'ok' : 'error'}`,
    `- Runtime: ${result.runtime.label}`,
    `- ElapsedMs: ${result.elapsedMs.toString()}`,
    '',
  ];
  if (result.error) {
    lines.push(`- Error: ${result.error.name}: ${result.error.message}`);
    lines.push('');
  }
  lines.push('## Logs');
  lines.push('```text');
  lines.push(result.logs.length > 0 ? result.logs : '<no logs>');
  lines.push('```');
  return lines.join('\n');
}

function renderRunAllMarkdown(result: CompactNotebookRunAllResult): string {
  const lines: string[] = [
    '# Notebook RunAll Result',
    '',
    `- Status: ${result.ok ? 'ok' : 'error'}`,
    `- Executed: ${result.executedCells.toString()} / ${result.totalCodeCells.toString()}`,
    `- Failed: ${result.failedCells.toString()}`,
    `- StoppedOnError: ${result.stoppedOnError ? 'true' : 'false'}`,
    `- ElapsedMs: ${result.elapsedMs.toString()}`,
    '',
    '## Cells',
  ];

  for (const cell of result.cells) {
    lines.push(
      `### Cell ${cell.executionIndex.toString()} (index ${cell.cellIndex.toString()}): ${cell.ok ? 'ok' : 'error'}`,
    );
    if (cell.error) {
      lines.push(`- Error: ${cell.error.name}: ${cell.error.message}`);
    }
    lines.push('```text');
    lines.push(cell.logs.length > 0 ? cell.logs : '<no logs>');
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function toCompactCell(cell: NotebookRunCellResult): CompactNotebookCell {
  const error = firstErrorFromOutputs(cell.outputs);
  return {
    cellIndex: cell.cellIndex,
    executionIndex: cell.executionIndex,
    ok: cell.status === 'ok',
    status: cell.status,
    logs: collectLogs(cell.outputs),
    ...(error ? { error } : {}),
  };
}

function toCompactExecuteResult(
  result: NotebookExecuteResult,
): CompactNotebookExecuteResult {
  const error = firstErrorFromOutputs(result.outputs);
  return {
    format: 'compact',
    ok: result.status === 'ok',
    status: result.status,
    runtime: result.runtime,
    sessionId: result.sessionId,
    kernelId: result.kernelId,
    kernelName: result.kernelName,
    elapsedMs: result.elapsedMs,
    cleanedUpSession: result.cleanedUpSession,
    logs: collectLogs(result.outputs),
    ...(error ? { error } : {}),
  };
}

function toCompactRunAllResult(
  result: NotebookRunAllResult,
): CompactNotebookRunAllResult {
  return {
    format: 'compact',
    ok: result.status === 'ok',
    status: result.status,
    runtime: result.runtime,
    notebookPath: result.notebookPath,
    sessionId: result.sessionId,
    kernelId: result.kernelId,
    kernelName: result.kernelName,
    totalCodeCells: result.totalCodeCells,
    executedCells: result.executedCells,
    failedCells: result.failedCells,
    stoppedOnError: result.stoppedOnError,
    elapsedMs: result.elapsedMs,
    cleanedUpSession: result.cleanedUpSession,
    cells: result.cells.map(toCompactCell),
  };
}

export function formatNotebookExecuteResult(
  result: NotebookExecuteResult,
  outputMode: AgentBridgeOutputMode,
  renderMode: AgentBridgeRenderMode,
): NotebookExecuteResult | (CompactNotebookExecuteResult & MarkdownAttachable) {
  if (outputMode === 'raw') {
    if (renderMode === 'none') {
      return result;
    }
    const compact = toCompactExecuteResult(result);
    return {
      ...result,
      summaryMarkdown: renderExecuteMarkdown(compact),
    };
  }

  const compact = toCompactExecuteResult(result);

  if (renderMode === 'none') {
    return compact;
  }
  return {
    ...compact,
    summaryMarkdown: renderExecuteMarkdown(compact),
  };
}

export function formatNotebookRunAllResult(
  result: NotebookRunAllResult,
  outputMode: AgentBridgeOutputMode,
  renderMode: AgentBridgeRenderMode,
): NotebookRunAllResult | (CompactNotebookRunAllResult & MarkdownAttachable) {
  if (outputMode === 'raw') {
    if (renderMode === 'none') {
      return result;
    }
    const compact = toCompactRunAllResult(result);
    return {
      ...result,
      summaryMarkdown: renderRunAllMarkdown(compact),
    };
  }

  const compact = toCompactRunAllResult(result);

  if (renderMode === 'none') {
    return compact;
  }
  return {
    ...compact,
    summaryMarkdown: renderRunAllMarkdown(compact),
  };
}
```

### File: `src/colab/agent-bridge-format.unit.test.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'chai';
import { Variant } from './api';
import {
  formatNotebookExecuteResult,
  formatNotebookRunAllResult,
} from './agent-bridge-format';
import { NotebookExecuteResult, NotebookRunAllResult } from './agent-runtime-service';

const RUNTIME = {
  owner: 'extension' as const,
  id: 'runtime-id',
  label: 'Colab CPU',
  endpoint: 'm-s-test',
  variant: Variant.DEFAULT,
  accelerator: 'NONE',
  dateAssigned: '2026-02-22T00:00:00.000Z',
  baseUrl: 'https://example.com/',
  tokenExpiry: '2026-02-22T01:00:00.000Z',
};

describe('Agent Bridge Output Formatter', () => {
  it('formats notebook.execute to compact output by default shape', () => {
    const raw: NotebookExecuteResult = {
      runtime: RUNTIME,
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'error',
      outputs: [
        { type: 'stream', name: 'stdout', text: 'line-1\n' },
        {
          type: 'error',
          ename: 'ValueError',
          evalue: 'bad input',
          traceback: ['Traceback line 1', 'Traceback line 2'],
        },
      ],
      reply: {},
      elapsedMs: 123,
      cleanedUpSession: true,
    };

    const compact = formatNotebookExecuteResult(raw, 'compact', 'none') as {
      readonly format: string;
      readonly ok: boolean;
      readonly logs: string;
      readonly error?: { readonly name: string; readonly message: string };
      readonly outputs?: unknown;
    };

    expect(compact.format).to.equal('compact');
    expect(compact.ok).to.equal(false);
    expect(compact.logs).to.contain('line-1');
    expect(compact.logs).to.contain('Traceback line 1');
    expect(compact.error).to.deep.equal({
      name: 'ValueError',
      message: 'bad input',
    });
    expect(compact.outputs).to.equal(undefined);
  });

  it('attaches markdown summary when requested', () => {
    const raw: NotebookExecuteResult = {
      runtime: RUNTIME,
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      outputs: [{ type: 'stream', name: 'stdout', text: 'hello\n' }],
      reply: {},
      elapsedMs: 77,
      cleanedUpSession: true,
    };

    const compact = formatNotebookExecuteResult(raw, 'compact', 'markdown') as {
      readonly summaryMarkdown?: string;
    };

    expect(compact.summaryMarkdown).to.contain('# Notebook Execute Result');
    expect(compact.summaryMarkdown).to.contain('hello');
  });

  it('keeps raw payload in raw mode while adding markdown optionally', () => {
    const raw: NotebookExecuteResult = {
      runtime: RUNTIME,
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      outputs: [{ type: 'stream', name: 'stdout', text: 'hello\n' }],
      reply: { status: 'ok' },
      elapsedMs: 88,
      cleanedUpSession: true,
    };

    const result = formatNotebookExecuteResult(raw, 'raw', 'markdown') as {
      readonly outputs: readonly unknown[];
      readonly reply: unknown;
      readonly summaryMarkdown?: string;
    };

    expect(result.outputs).to.have.length(1);
    expect(result.reply).to.deep.equal({ status: 'ok' });
    expect(result.summaryMarkdown).to.contain('# Notebook Execute Result');
  });

  it('formats notebook.runAll into per-cell compact logs', () => {
    const raw: NotebookRunAllResult = {
      runtime: RUNTIME,
      notebookPath: '/tmp/example.ipynb',
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'error',
      totalCodeCells: 2,
      executedCells: 2,
      failedCells: 1,
      stoppedOnError: false,
      elapsedMs: 222,
      cleanedUpSession: true,
      cells: [
        {
          cellIndex: 0,
          executionIndex: 1,
          status: 'ok',
          elapsedMs: 100,
          sourcePreview: 'print(1)',
          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
          reply: {},
        },
        {
          cellIndex: 1,
          executionIndex: 2,
          status: 'error',
          elapsedMs: 122,
          sourcePreview: 'raise ValueError()',
          outputs: [
            {
              type: 'error',
              ename: 'ValueError',
              evalue: 'boom',
              traceback: ['Traceback...'],
            },
          ],
          reply: {},
        },
      ],
    };

    const compact = formatNotebookRunAllResult(raw, 'compact', 'markdown') as {
      readonly format: string;
      readonly cells: readonly {
        readonly ok: boolean;
        readonly logs: string;
        readonly error?: { readonly name: string; readonly message: string };
      }[];
      readonly summaryMarkdown?: string;
    };

    expect(compact.format).to.equal('compact');
    expect(compact.cells).to.have.length(2);
    expect(compact.cells[0].ok).to.equal(true);
    expect(compact.cells[0].logs).to.contain('1');
    expect(compact.cells[1].ok).to.equal(false);
    expect(compact.cells[1].error).to.deep.equal({
      name: 'ValueError',
      message: 'boom',
    });
    expect(compact.summaryMarkdown).to.contain('# Notebook RunAll Result');
  });
});
```

### File: `src/colab/agent-bridge-http.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import vscode from 'vscode';
import { log } from '../common/logging';
import { AssignmentManager } from '../jupyter/assignments';
import {
  AgentBridgeRequest,
  dispatchAgentBridgeRequest,
} from './agent-bridge-rpc';

const BRIDGE_ENDPOINT = '/v1/colab-agent';
const BRIDGE_HEALTH_ENDPOINT = '/healthz';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_STATE_FILE = '~/.colab-agent-bridge.json';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const LOCALHOST_HOST = 'localhost';
const IPV6_LOOPBACK_HOST = '::1';
const IPV6_UNSPECIFIED_HOST = '::';
const IPV4_UNSPECIFIED_HOST = '0.0.0.0';
const LOOPBACK_V4_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/;

interface AgentBridgeConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly allowRemoteHost: boolean;
  readonly stateFile: string;
}

interface AgentBridgeStateFile {
  readonly version: 1;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly tokenRequired: boolean;
  readonly pid: number;
  readonly startedAt: string;
}

interface AgentBridgeErrorResponse {
  readonly id?: string | number;
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly code?: string;
    readonly message: string;
  };
}

interface AgentBridgeSuccessResponse {
  readonly id?: string | number;
  readonly ok: true;
  readonly result: unknown;
}

interface AgentBridgeServerIdentity {
  readonly pid: number;
  readonly port: number;
}

class HttpRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorResponse(
  error: unknown,
  id?: string | number,
): AgentBridgeErrorResponse {
  if (error instanceof Error) {
    const errorCode =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    return {
      id,
      ok: false,
      error: {
        name: error.name,
        code: errorCode,
        message: error.message,
      },
    };
  }
  return {
    id,
    ok: false,
    error: {
      name: 'Error',
      message: String(error),
    },
  };
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: AgentBridgeErrorResponse | AgentBridgeSuccessResponse,
): void {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(body)}\n`);
}

function resolveStateFilePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  if (
    normalizedHost === LOCALHOST_HOST ||
    normalizedHost === IPV6_LOOPBACK_HOST
  ) {
    return true;
  }
  if (!LOOPBACK_V4_HOST_PATTERN.test(normalizedHost)) {
    return false;
  }
  return normalizedHost
    .split('.')
    .map(Number)
    .every(
      (octet, index) =>
        Number.isInteger(octet) &&
        octet >= 0 &&
        octet <= 255 &&
        (index > 0 || octet === 127),
    );
}

function isWildcardBindHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === IPV4_UNSPECIFIED_HOST ||
    normalizedHost === IPV6_UNSPECIFIED_HOST
  );
}

function formatHostForEndpoint(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function parseRequestPath(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

function hasJsonContentType(req: http.IncomingMessage): boolean {
  const contentType = getHeader(req, 'content-type');
  if (!contentType) {
    return false;
  }
  const [mimeType] = contentType.split(';', 1);
  return mimeType.trim().toLowerCase() === 'application/json';
}

function parseStateFileIdentity(
  value: unknown,
): AgentBridgeServerIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pid = value.pid;
  const port = value.port;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof port !== 'number' ||
    !Number.isInteger(port)
  ) {
    return undefined;
  }
  return { pid, port };
}

function readConfig(vs: typeof vscode): AgentBridgeConfig {
  const config = vs.workspace.getConfiguration('colab.agentBridge');

  const enabled = config.get<boolean>('enabled', false);
  const rawHost = config.get<string>('host', DEFAULT_HOST).trim();
  const host = rawHost.length > 0 ? rawHost : DEFAULT_HOST;
  const rawPort = config.get<number>('port', DEFAULT_PORT);
  const port =
    Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535
      ? rawPort
      : DEFAULT_PORT;
  const token = config.get<string>('token', '').trim();
  const allowRemoteHost = config.get<boolean>('allowRemoteHost', false);
  const rawStateFile = config.get<string>('stateFile', DEFAULT_STATE_FILE);
  const stateFile = resolveStateFilePath(rawStateFile.trim());

  return {
    enabled,
    host,
    port,
    token,
    allowRemoteHost,
    stateFile,
  };
}

function configsEqual(a?: AgentBridgeConfig, b?: AgentBridgeConfig): boolean {
  if (!a || !b) {
    return false;
  }
  return (
    a.enabled === b.enabled &&
    a.host === b.host &&
    a.port === b.port &&
    a.token === b.token &&
    a.allowRemoteHost === b.allowRemoteHost &&
    a.stateFile === b.stateFile
  );
}

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer | string) => {
      if (rejected) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(
          new HttpRequestError(
            'PAYLOAD_TOO_LARGE',
            413,
            'Request body exceeds 1 MiB limit.',
          ),
        );
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (rejected) {
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(
          new HttpRequestError(
            'INVALID_JSON',
            400,
            'Request body must be valid JSON.',
          ),
        );
      }
    });

    req.on('error', (error) => {
      if (rejected) {
        return;
      }
      reject(error);
    });
  });
}

function parseRequest(body: unknown): AgentBridgeRequest {
  if (!isRecord(body)) {
    throw new HttpRequestError(
      'INVALID_REQUEST',
      400,
      'Request body must be a JSON object.',
    );
  }

  const method = body.method;
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new HttpRequestError(
      'INVALID_REQUEST',
      400,
      'Request "method" must be a non-empty string.',
    );
  }

  const id = body.id;
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
    throw new HttpRequestError(
      'INVALID_REQUEST',
      400,
      'Request "id" must be a string or number.',
    );
  }

  return {
    id,
    method,
    params: body.params,
  };
}

function getHeader(
  req: http.IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name];
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isAuthorizedRequest(
  req: http.IncomingMessage,
  config: AgentBridgeConfig,
): boolean {
  if (config.token.length === 0) {
    return false;
  }

  const authHeader = getHeader(req, 'authorization');
  if (authHeader === `Bearer ${config.token}`) {
    return true;
  }

  const tokenHeader = getHeader(req, 'x-colab-agent-token');
  return tokenHeader === config.token;
}

async function writeStateFile(
  stateFilePath: string,
  state: AgentBridgeStateFile,
): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
  await fs.writeFile(
    stateFilePath,
    `${JSON.stringify(state, undefined, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  // Keep the discovery file readable only by the local user when possible.
  try {
    await fs.chmod(stateFilePath, 0o600);
  } catch (_error) {
    // Best-effort on platforms without chmod support.
  }
}

async function removeStateFile(
  stateFilePath: string,
  expectedIdentity: AgentBridgeServerIdentity,
): Promise<void> {
  let shouldRemove = false;
  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const identity = parseStateFileIdentity(parsed);
    shouldRemove =
      identity !== undefined &&
      identity.pid === expectedIdentity.pid &&
      identity.port === expectedIdentity.port;
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return;
    }
    log.warn(`Unable to inspect agent bridge state file: ${stateFilePath}`, error);
    return;
  }

  if (!shouldRemove) {
    return;
  }

  try {
    await fs.rm(stateFilePath, { force: true });
  } catch (error: unknown) {
    log.warn(`Unable to remove agent bridge state file: ${stateFilePath}`, error);
  }
}

export class AgentBridgeController implements vscode.Disposable {
  private readonly configListener: vscode.Disposable;
  private refreshQueue: Promise<void> = Promise.resolve();
  private isDisposed = false;
  private activeConfig?: AgentBridgeConfig;
  private activeStateIdentity?: AgentBridgeServerIdentity;
  private server?: http.Server;

  constructor(
    private readonly vs: typeof vscode,
    private readonly assignmentManager: AssignmentManager,
  ) {
    this.configListener = vs.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('colab.agentBridge')) {
        this.scheduleRefresh();
      }
    });
    this.scheduleRefresh();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.configListener.dispose();
    this.refreshQueue = this.refreshQueue
      .then(() => this.stopServer())
      .catch((error) => {
        log.error('Error while stopping agent bridge during dispose.', error);
      });
  }

  private scheduleRefresh(): void {
    this.refreshQueue = this.refreshQueue
      .then(async () => {
        if (this.isDisposed) {
          return;
        }
        await this.applyConfig();
      })
      .catch((error) => {
        log.error('Error while refreshing agent bridge configuration.', error);
      });
  }

  private async applyConfig(): Promise<void> {
    const nextConfig = readConfig(this.vs);
    if (!nextConfig.enabled) {
      await this.stopServer();
      return;
    }

    if (isWildcardBindHost(nextConfig.host)) {
      await this.stopServer();
      log.error(
        `Agent bridge host "${nextConfig.host}" is not supported. Use a specific loopback or interface address.`,
      );
      void this.vs.window.showErrorMessage(
        `Colab agent bridge host "${nextConfig.host}" is not supported.`,
      );
      return;
    }

    if (nextConfig.token.length === 0) {
      await this.stopServer();
      log.error(
        'Agent bridge is enabled but colab.agentBridge.token is empty. Refusing to start.',
      );
      void this.vs.window.showErrorMessage(
        'Colab agent bridge requires colab.agentBridge.token when enabled.',
      );
      return;
    }

    if (!nextConfig.allowRemoteHost && !isLoopbackHost(nextConfig.host)) {
      await this.stopServer();
      log.error(
        `Agent bridge host "${nextConfig.host}" is not loopback. Set colab.agentBridge.allowRemoteHost=true only if you understand the security risks.`,
      );
      void this.vs.window.showErrorMessage(
        `Colab agent bridge host "${nextConfig.host}" is blocked because it is not loopback.`,
      );
      return;
    }

    if (nextConfig.allowRemoteHost && !isLoopbackHost(nextConfig.host)) {
      log.warn(
        `Agent bridge is listening on non-loopback host "${nextConfig.host}".`,
      );
    }

    if (this.server && configsEqual(this.activeConfig, nextConfig)) {
      return;
    }

    await this.stopServer();
    await this.startServer(nextConfig);
  }

  private async startServer(config: AgentBridgeConfig): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, config);
    });
    // Notebook execution can exceed the default HTTP server request timeout.
    server.requestTimeout = 0;
    server.headersTimeout = 0;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine agent bridge listening address.');
    }

    this.server = server;
    this.activeConfig = config;
    this.activeStateIdentity = {
      pid: process.pid,
      port: address.port,
    };

    const endpointHost = formatHostForEndpoint(config.host);
    const endpoint = `http://${endpointHost}:${address.port.toString()}${BRIDGE_ENDPOINT}`;
    log.info(`Agent bridge listening at ${endpoint}`);

    await writeStateFile(config.stateFile, {
      version: 1,
      host: config.host,
      port: address.port,
      endpoint,
      tokenRequired: config.token.length > 0,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    const stateFilePath = this.activeConfig?.stateFile;
    const stateIdentity = this.activeStateIdentity;
    this.server = undefined;
    this.activeConfig = undefined;
    this.activeStateIdentity = undefined;

    if (server) {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((_error) => {
          resolve();
        });
      });
    }

    if (stateFilePath && stateIdentity) {
      await removeStateFile(stateFilePath, stateIdentity);
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: AgentBridgeConfig,
  ): Promise<void> {
    req.setTimeout(0);
    res.setTimeout(0);
    const requestPath = parseRequestPath(req.url);

    if (requestPath === BRIDGE_HEALTH_ENDPOINT && req.method === 'GET') {
      writeJson(res, 200, {
        ok: true,
        result: {
          status: 'ok',
        },
      });
      return;
    }

    if (requestPath !== BRIDGE_ENDPOINT) {
      writeJson(res, 404, {
        ok: false,
        error: {
          name: 'NotFoundError',
          code: 'NOT_FOUND',
          message: `Unknown endpoint "${req.url ?? ''}".`,
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, {
        ok: false,
        error: {
          name: 'MethodNotAllowedError',
          code: 'METHOD_NOT_ALLOWED',
          message: 'Use POST for bridge requests.',
        },
      });
      return;
    }

    if (!hasJsonContentType(req)) {
      writeJson(res, 415, {
        ok: false,
        error: {
          name: 'UnsupportedMediaTypeError',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Requests must use Content-Type: application/json.',
        },
      });
      return;
    }

    if (!isAuthorizedRequest(req, config)) {
      writeJson(res, 401, {
        ok: false,
        error: {
          name: 'UnauthorizedError',
          code: 'UNAUTHORIZED',
          message:
            'Missing or invalid token. Use Authorization: Bearer <token>.',
        },
      });
      return;
    }

    let request: AgentBridgeRequest;
    try {
      request = parseRequest(await readRequestBody(req));
    } catch (error: unknown) {
      const statusCode =
        error instanceof HttpRequestError ? error.statusCode : 400;
      writeJson(res, statusCode, toErrorResponse(error));
      return;
    }

    try {
      const result = await dispatchAgentBridgeRequest(
        this.assignmentManager,
        request,
      );
      writeJson(res, 200, {
        id: request.id,
        ok: true,
        result,
      });
    } catch (error: unknown) {
      writeJson(res, 200, toErrorResponse(error, request.id));
    }
  }
}
```

### File: `src/colab/agent-bridge-http.unit.test.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import {
  ConfigurationChangeEvent,
  WorkspaceConfiguration,
} from 'vscode';
import { AssignmentManager } from '../jupyter/assignments';
import { TestEventEmitter } from '../test/helpers/events';
import { newVsCodeStub, VsCodeStub } from '../test/helpers/vscode';
import { AgentBridgeController } from './agent-bridge-http';

interface BridgeSettings {
  enabled: boolean;
  host: string;
  allowRemoteHost: boolean;
  port: number;
  token: string;
  stateFile: string;
}

interface BridgeState {
  readonly endpoint: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
}

function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function waitForPredicate(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for predicate.');
}

async function waitForBridgeState(
  stateFilePath: string,
  timeoutMs = 2_000,
): Promise<BridgeState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BridgeState>;
      if (
        typeof parsed.endpoint === 'string' &&
        typeof parsed.host === 'string' &&
        typeof parsed.port === 'number' &&
        typeof parsed.pid === 'number'
      ) {
        return parsed as BridgeState;
      }
    } catch (_error) {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for bridge state file: ${stateFilePath}`);
}

describe('Agent Bridge HTTP Controller', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let configChangeEmitter: TestEventEmitter<ConfigurationChangeEvent>;
  let settings: BridgeSettings;
  let controller: AgentBridgeController | undefined;

  beforeEach(() => {
    vsCodeStub = newVsCodeStub();
    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
    configChangeEmitter = new TestEventEmitter<ConfigurationChangeEvent>();
    vsCodeStub.workspace.onDidChangeConfiguration.callsFake(
      configChangeEmitter.event,
    );

    settings = {
      enabled: true,
      host: '127.0.0.1',
      allowRemoteHost: false,
      port: 0,
      token: 'test-agent-token',
      stateFile: path.join(
        os.tmpdir(),
        `colab-agent-bridge-state-${randomUUID()}.json`,
      ),
    };

    const workspaceConfig = {
      get: <T>(section: string, defaultValue: T): T => {
        const value = (settings as unknown as Record<string, unknown>)[section];
        if (value === undefined) {
          return defaultValue;
        }
        return value as T;
      },
    } as Pick<WorkspaceConfiguration, 'get'> as WorkspaceConfiguration;

    vsCodeStub.workspace.getConfiguration
      .withArgs('colab.agentBridge')
      .returns(workspaceConfig);
  });

  afterEach(async () => {
    if (controller) {
      controller.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller = undefined;
    }
    await fs.rm(settings.stateFile, { force: true });
    sinon.restore();
  });

  it('serves authorized bridge requests', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'req-1',
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly status: string };
    };
    expect(body.ok).to.equal(true);
    expect(body.result.status).to.equal('ok');
  });

  it('serves health endpoint without authorization', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);
    const healthEndpoint = state.endpoint.replace('/v1/colab-agent', '/healthz');

    const response = await fetch(healthEndpoint);

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly status: string };
    };
    expect(body.ok).to.equal(true);
    expect(body.result.status).to.equal('ok');
  });

  it('supports query parameters for the bridge endpoint', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(`${state.endpoint}?trace=1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly status: string };
    };
    expect(body.ok).to.equal(true);
    expect(body.result.status).to.equal('ok');
  });

  it('returns 401 when token is missing', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(401);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly name: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.name).to.equal('UnauthorizedError');
  });

  it('returns 415 for non-json content type', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'text/plain',
      },
      body: '{"method":"ping"}',
    });

    expect(response.status).to.equal(415);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly name: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.name).to.equal('UnsupportedMediaTypeError');
  });

  it('returns 404 for unknown endpoints', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);
    const unknownEndpoint = state.endpoint.replace(
      '/v1/colab-agent',
      '/v1/not-found',
    );

    const response = await fetch(unknownEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
      }),
    });

    expect(response.status).to.equal(404);
  });

  it('returns 405 for OPTIONS requests', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'OPTIONS',
    });

    expect(response.status).to.equal(405);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code?: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.code).to.equal('METHOD_NOT_ALLOWED');
  });

  it('returns 413 when request payload exceeds limit', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);
    const oversizedPayload = 'x'.repeat(1024 * 1024);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'ping',
        params: {
          oversizedPayload,
        },
      }),
    });

    expect(response.status).to.equal(413);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code?: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.code).to.equal('PAYLOAD_TOO_LARGE');
  });

  it('returns stable error codes for RPC failures', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    const response = await fetch(state.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method: 'unsupported-method',
      }),
    });

    expect(response.status).to.equal(200);
    const body = (await response.json()) as {
      readonly ok: boolean;
      readonly error: { readonly code?: string };
    };
    expect(body.ok).to.equal(false);
    expect(body.error.code).to.equal('UNSUPPORTED_METHOD');
  });

  it('refuses to start when token is empty', async () => {
    settings.token = '';
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );

    await waitForPredicate(() =>
      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
    );
    expect(await exists(settings.stateFile)).to.equal(false);
  });

  it('blocks non-loopback host unless allowRemoteHost is enabled', async () => {
    settings.host = '0.0.0.0';
    settings.allowRemoteHost = false;
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );

    await waitForPredicate(() =>
      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
    );
    expect(await exists(settings.stateFile)).to.equal(false);
  });

  it('blocks wildcard host even when allowRemoteHost is enabled', async () => {
    settings.host = '0.0.0.0';
    settings.allowRemoteHost = true;
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );

    await waitForPredicate(() =>
      (vsCodeStub.window.showErrorMessage as sinon.SinonStub).called,
    );
    expect(await exists(settings.stateFile)).to.equal(false);
  });

  it('keeps state file when ownership does not match on shutdown', async () => {
    controller = new AgentBridgeController(
      vsCodeStub.asVsCode(),
      assignmentManagerStub,
    );
    const state = await waitForBridgeState(settings.stateFile);

    await fs.writeFile(
      settings.stateFile,
      `${JSON.stringify({ ...state, pid: state.pid + 1 }, undefined, 2)}\n`,
      'utf8',
    );

    controller.dispose();
    controller = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await exists(settings.stateFile)).to.equal(true);
  });
});
```

### File: `src/colab/agent-bridge-rpc.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AssignmentManager } from '../jupyter/assignments';
import { Shape, Variant } from './api';
import {
  AgentBridgeOutputMode,
  AgentBridgeRenderMode,
  formatNotebookExecuteResult,
  formatNotebookRunAllResult,
} from './agent-bridge-format';
import {
  AgentListRuntimesArgs,
  AgentRuntimeScope,
  AgentRuntimeService,
  AgentRuntimeStatusArgs,
  AgentStartMode,
  AgentStartRuntimeArgs,
  AgentStopRuntimeArgs,
  NotebookExecuteArgs,
  NotebookRunAllArgs,
  RuntimeFilesWriteTextArgs,
  RuntimeSecretsSyncArgs,
} from './agent-runtime-service';

export type AgentBridgeMethod =
  | 'ping'
  | 'bridge.capabilities'
  | 'runtimes.list'
  | 'runtimes.start'
  | 'runtimes.stop'
  | 'runtimes.status'
  | 'notebook.execute'
  | 'notebook.runAll'
  | 'runtime.files.writeText'
  | 'runtime.secrets.sync';

export type AgentBridgeErrorCode =
  | 'INVALID_PARAMS'
  | 'UNSUPPORTED_METHOD';

const SUPPORTED_METHODS: readonly AgentBridgeMethod[] = [
  'ping',
  'bridge.capabilities',
  'runtimes.list',
  'runtimes.start',
  'runtimes.stop',
  'runtimes.status',
  'notebook.execute',
  'notebook.runAll',
  'runtime.files.writeText',
  'runtime.secrets.sync',
];

interface BridgeCapabilitiesResult {
  readonly bridgeVersion: 1;
  readonly methods: readonly AgentBridgeMethod[];
  readonly notes: readonly string[];
}

export interface AgentBridgeRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export class AgentBridgeError extends Error {
  constructor(
    readonly code: AgentBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentBridgeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(message: string): AgentBridgeError {
  return new AgentBridgeError('INVALID_PARAMS', message);
}

function parseParams(params: unknown): Record<string, unknown> {
  if (params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    throw invalidParams('Request "params" must be an object.');
  }
  return params;
}

function parseOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidParams(`Invalid "${fieldName}" value. Expected a string.`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getOptionalBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw invalidParams('Expected a boolean value.');
  }
  return value;
}

function parseStartMode(value: unknown): AgentStartMode | undefined {
  const mode = parseOptionalString(value, 'mode');
  if (!mode) {
    return undefined;
  }
  if (mode === 'latestOrCreate' || mode === 'new') {
    return mode;
  }
  throw invalidParams('Invalid "mode" value. Use "latestOrCreate" or "new".');
}

function parseVariant(value: unknown): Variant | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
  }
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case Variant.DEFAULT:
    case Variant.GPU:
    case Variant.TPU:
      return normalized;
    default:
      throw invalidParams('Invalid "variant" value. Use DEFAULT, GPU, or TPU.');
  }
}

function parseShape(value: unknown): Shape | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'number') {
    if (value === Shape.STANDARD || value === Shape.HIGHMEM) {
      return value;
    }
    throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }

  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case 'STANDARD':
    case '0':
      return Shape.STANDARD;
    case 'HIGHMEM':
    case '1':
      return Shape.HIGHMEM;
    default:
      throw invalidParams('Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.');
  }
}

function parseTimeoutMs(value: unknown, fieldName = 'timeoutMs'): number {
  if (value === undefined) {
    return AgentRuntimeService.validateTimeoutMs(undefined, fieldName);
  }
  if (typeof value !== 'number') {
    throw invalidParams(`${fieldName} must be an integer.`);
  }
  return AgentRuntimeService.validateTimeoutMs(value, fieldName);
}

function parseOutputMode(value: unknown): AgentBridgeOutputMode {
  if (value === undefined) {
    return 'compact';
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "outputMode" value. Use "compact" or "raw".');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'compact' || normalized === 'raw') {
    return normalized;
  }
  throw invalidParams('Invalid "outputMode" value. Use "compact" or "raw".');
}

function parseRenderMode(value: unknown): AgentBridgeRenderMode {
  if (value === undefined) {
    return 'markdown';
  }
  if (typeof value !== 'string') {
    throw invalidParams('Invalid "render" value. Use "none" or "markdown".');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'markdown') {
    return normalized;
  }
  throw invalidParams('Invalid "render" value. Use "none" or "markdown".');
}

function parseRuntimeScope(value: unknown): AgentRuntimeScope | undefined {
  const from = parseOptionalString(value, 'from');
  if (from === undefined) {
    return undefined;
  }
  if (from === 'extension' || from === 'external' || from === 'all') {
    return from;
  }
  throw invalidParams('Invalid "from" value. Use extension, external, or all.');
}

function toListRuntimesArgs(
  params: Record<string, unknown>,
): AgentListRuntimesArgs {
  return {
    from: parseRuntimeScope(params.from),
  };
}

function toStartRuntimeArgs(
  params: Record<string, unknown>,
): AgentStartRuntimeArgs {
  return {
    mode: parseStartMode(params.mode),
    label: parseOptionalString(params.label, 'label'),
    variant: parseVariant(params.variant),
    accelerator: parseOptionalString(params.accelerator, 'accelerator'),
    shape: parseShape(params.shape),
    version: parseOptionalString(params.version, 'version'),
  };
}

function toStopRuntimeArgs(
  params: Record<string, unknown>,
): AgentStopRuntimeArgs {
  return {
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    all: getOptionalBoolean(params.all, false),
  };
}

function toRuntimeStatusArgs(
  params: Record<string, unknown>,
): AgentRuntimeStatusArgs {
  return {
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    all: getOptionalBoolean(params.all, false),
  };
}

function toNotebookExecuteArgs(
  params: Record<string, unknown>,
): {
  readonly args: NotebookExecuteArgs;
  readonly outputMode: AgentBridgeOutputMode;
  readonly render: AgentBridgeRenderMode;
} {
  const code = params.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw invalidParams('notebook.execute requires a non-empty "code" string.');
  }

  return {
    args: {
      code,
      from: parseRuntimeScope(params.from),
      id: parseOptionalString(params.id, 'id'),
      endpoint: parseOptionalString(params.endpoint, 'endpoint'),
      label: parseOptionalString(params.label, 'label'),
      timeoutMs: parseTimeoutMs(params.timeoutMs, 'timeoutMs'),
      kernelName: parseOptionalString(params.kernelName, 'kernelName'),
      cleanupSession: getOptionalBoolean(params.cleanupSession, true),
    },
    outputMode: parseOutputMode(params.outputMode),
    render: parseRenderMode(params.render),
  };
}

function toNotebookRunAllArgs(
  params: Record<string, unknown>,
): {
  readonly args: NotebookRunAllArgs;
  readonly outputMode: AgentBridgeOutputMode;
  readonly render: AgentBridgeRenderMode;
} {
  const notebookPath = parseOptionalString(params.notebookPath, 'notebookPath');
  if (!notebookPath) {
    throw invalidParams(
      'notebook.runAll requires a non-empty "notebookPath" string.',
    );
  }
  if (params.saveResultPath !== undefined) {
    throw invalidParams(
      'notebook.runAll does not support "saveResultPath". Save results in the client process.',
    );
  }

  return {
    args: {
      notebookPath,
      from: parseRuntimeScope(params.from),
      id: parseOptionalString(params.id, 'id'),
      endpoint: parseOptionalString(params.endpoint, 'endpoint'),
      label: parseOptionalString(params.label, 'label'),
      timeoutMsPerCell: parseTimeoutMs(params.timeoutMsPerCell, 'timeoutMsPerCell'),
      stopOnError: getOptionalBoolean(params.stopOnError, true),
      kernelName: parseOptionalString(params.kernelName, 'kernelName'),
      cleanupSession: getOptionalBoolean(params.cleanupSession, true),
      saveCellsRuntimeDir: parseOptionalString(
        params.saveCellsRuntimeDir,
        'saveCellsRuntimeDir',
      ),
    },
    outputMode: parseOutputMode(params.outputMode),
    render: parseRenderMode(params.render),
  };
}

function toRuntimeFilesWriteTextArgs(
  params: Record<string, unknown>,
): RuntimeFilesWriteTextArgs {
  const runtimePath = parseOptionalString(params.runtimePath, 'runtimePath');
  if (!runtimePath) {
    throw invalidParams(
      'runtime.files.writeText requires a non-empty "runtimePath" string.',
    );
  }

  const text = params.text;
  if (typeof text !== 'string') {
    throw invalidParams('runtime.files.writeText requires a "text" string.');
  }

  return {
    runtimePath,
    text,
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    createDirectories: getOptionalBoolean(params.createDirectories, true),
  };
}

function toRuntimeSecretsSyncArgs(
  params: Record<string, unknown>,
): RuntimeSecretsSyncArgs {
  const tokenCandidates = [
    params.hfToken,
    params.HF_TOKEN,
    params.hfAccessToken,
    params.HF_ACCESS_TOKEN,
  ];
  const hfToken = tokenCandidates.find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  if (!hfToken) {
    throw invalidParams(
      'runtime.secrets.sync requires a non-empty "hfToken" string (or HF_TOKEN/HF_ACCESS_TOKEN).',
    );
  }

  return {
    hfToken: hfToken.trim(),
    from: parseRuntimeScope(params.from),
    id: parseOptionalString(params.id, 'id'),
    endpoint: parseOptionalString(params.endpoint, 'endpoint'),
    label: parseOptionalString(params.label, 'label'),
    writeIpythonStartup: getOptionalBoolean(params.writeIpythonStartup, true),
    writeHfHomeTokenFile: getOptionalBoolean(params.writeHfHomeTokenFile, true),
    writeHfCacheTokenFile: getOptionalBoolean(params.writeHfCacheTokenFile, true),
    verifyRuntimeEnv: getOptionalBoolean(params.verifyRuntimeEnv, true),
  };
}

function bridgeCapabilities(): BridgeCapabilitiesResult {
  return {
    bridgeVersion: 1,
    methods: SUPPORTED_METHODS,
    notes: [
      'Execution methods reuse extension-assigned runtimes and run headless.',
      'Execution defaults to outputMode=compact with render=markdown for agent readability.',
      'Use notebook.runAll to execute an .ipynb end-to-end in one API call.',
      'runtime.files.writeText can target /content/drive/... when Drive is mounted.',
      'runtime.secrets.sync stores HF token in runtime files and startup hooks without echoing the token.',
    ],
  };
}

export async function dispatchAgentBridgeRequest(
  assignmentManager: AssignmentManager,
  request: AgentBridgeRequest,
): Promise<unknown> {
  const method = request.method as AgentBridgeMethod;
  const params = parseParams(request.params);
  const runtimeService = new AgentRuntimeService(assignmentManager);

  switch (method) {
    case 'ping':
      return {
        status: 'ok',
        now: new Date().toISOString(),
      };
    case 'bridge.capabilities':
      return bridgeCapabilities();
    case 'runtimes.list':
      return await runtimeService.listRuntimes(toListRuntimesArgs(params));
    case 'runtimes.start':
      return await runtimeService.startRuntime(toStartRuntimeArgs(params));
    case 'runtimes.stop':
      return await runtimeService.stopRuntime(toStopRuntimeArgs(params));
    case 'runtimes.status':
      return await runtimeService.runtimeStatus(toRuntimeStatusArgs(params));
    case 'notebook.execute': {
      const requestArgs = toNotebookExecuteArgs(params);
      const raw = await runtimeService.notebookExecute(requestArgs.args);
      return formatNotebookExecuteResult(
        raw,
        requestArgs.outputMode,
        requestArgs.render,
      );
    }
    case 'notebook.runAll': {
      const requestArgs = toNotebookRunAllArgs(params);
      const raw = await runtimeService.notebookRunAll(requestArgs.args);
      return formatNotebookRunAllResult(
        raw,
        requestArgs.outputMode,
        requestArgs.render,
      );
    }
    case 'runtime.files.writeText':
      return await runtimeService.runtimeFilesWriteText(
        toRuntimeFilesWriteTextArgs(params),
      );
    case 'runtime.secrets.sync':
      return await runtimeService.runtimeSecretsSync(
        toRuntimeSecretsSyncArgs(params),
      );
    default:
      throw new AgentBridgeError(
        'UNSUPPORTED_METHOD',
        `Unsupported method "${request.method}".`,
      );
  }
}
```

### File: `src/colab/agent-bridge.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export { AgentBridgeController } from './agent-bridge-http';
export {
  dispatchAgentBridgeRequest,
  type AgentBridgeMethod,
  type AgentBridgeRequest,
} from './agent-bridge-rpc';
```

### File: `src/colab/agent-bridge.unit.test.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { expect } from 'chai';
import sinon, { SinonStubbedInstance } from 'sinon';
import { Variant } from './api';
import { dispatchAgentBridgeRequest } from './agent-bridge';
import { AgentRuntimeService } from './agent-runtime-service';
import { AssignmentManager } from '../jupyter/assignments';
import { ColabAssignedServer } from '../jupyter/servers';
import { newVsCodeStub, VsCodeStub } from '../test/helpers/vscode';

describe('Agent Bridge', () => {
  let vsCodeStub: VsCodeStub;
  let assignmentManagerStub: SinonStubbedInstance<AssignmentManager>;
  let server: ColabAssignedServer;

  beforeEach(() => {
    vsCodeStub = newVsCodeStub();
    assignmentManagerStub = sinon.createStubInstance(AssignmentManager);
    server = {
      id: randomUUID(),
      label: 'runtime-a',
      variant: Variant.DEFAULT,
      endpoint: 'm-s-runtime-a',
      accelerator: undefined,
      shape: undefined,
      version: undefined,
      connectionInformation: {
        baseUrl: vsCodeStub.Uri.parse('https://example.com'),
        token: '123',
        tokenExpiry: new Date(Date.now() + 60_000),
        headers: {},
      },
      dateAssigned: new Date('2026-01-01T00:00:00.000Z'),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('handles ping requests', async () => {
    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'ping',
    })) as {
      status: string;
      now: string;
    };

    expect(response.status).to.equal('ok');
    expect(new Date(response.now).toString()).to.not.equal('Invalid Date');
  });

  it('returns bridge capabilities', async () => {
    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'bridge.capabilities',
    })) as {
      bridgeVersion: number;
      methods: string[];
    };

    expect(response.bridgeVersion).to.equal(1);
    expect(response.methods).to.include('notebook.runAll');
    expect(response.methods).to.include('runtime.files.writeText');
    expect(response.methods).to.include('runtime.secrets.sync');
  });

  it('delegates runtime list requests to agent commands', async () => {
    (assignmentManagerStub.getServers as sinon.SinonStub)
      .withArgs('extension')
      .resolves([server]);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'runtimes.list',
      params: { from: 'extension' },
    })) as {
      scope: string;
      counts: {
        assigned: number;
        unowned: number;
        total: number;
      };
    };

    expect(response.scope).to.equal('extension');
    expect(response.counts).to.deep.equal({
      assigned: 1,
      unowned: 0,
      total: 1,
    });
  });

  it('rejects non-object params', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.list',
        params: [],
      }),
    ).to.eventually.be.rejectedWith('Request "params" must be an object.');
  });

  it('rejects unknown methods', async () => {
    try {
      await dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'unsupported-method',
      });
      expect.fail('Expected method dispatch to fail.');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      const withCode = error as { code?: string; message?: string };
      expect(withCode.code).to.equal('UNSUPPORTED_METHOD');
      expect(withCode.message).to.equal('Unsupported method "unsupported-method".');
    }
  });

  it('rejects notebook.execute when code is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.execute',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'notebook.execute requires a non-empty "code" string.',
    );
  });

  it('rejects notebook.runAll when notebookPath is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.runAll',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'notebook.runAll requires a non-empty "notebookPath" string.',
    );
  });

  it('rejects runtime.files.writeText when runtimePath is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtime.files.writeText',
        params: { text: 'hello' },
      }),
    ).to.eventually.be.rejectedWith(
      'runtime.files.writeText requires a non-empty "runtimePath" string.',
    );
  });

  it('rejects runtime.secrets.sync when hfToken is missing', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtime.secrets.sync',
        params: {},
      }),
    ).to.eventually.be.rejectedWith(
      'runtime.secrets.sync requires a non-empty "hfToken" string (or HF_TOKEN/HF_ACCESS_TOKEN).',
    );
  });

  it('rejects invalid runtime scope values in execution requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.execute',
        params: {
          code: 'print(1)',
          from: 'invalid-scope',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "from" value. Use extension, external, or all.',
    );
  });

  it('rejects invalid runtime scope values in lifecycle requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.list',
        params: {
          from: 'invalid-scope',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "from" value. Use extension, external, or all.',
    );
  });

  it('rejects non-string selector values in lifecycle requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.status',
        params: {
          id: 123,
        },
      }),
    ).to.eventually.be.rejectedWith('Invalid "id" value. Expected a string.');
  });

  it('rejects invalid start descriptor values', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.start',
        params: {
          mode: 'new',
          variant: 'wrong-variant',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "variant" value. Use DEFAULT, GPU, or TPU.',
    );

    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'runtimes.start',
        params: {
          mode: 'new',
          shape: 'wrong-shape',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'Invalid "shape" value. Use STANDARD, HIGHMEM, 0, or 1.',
    );
  });

  it('rejects non-integer timeout values in execution requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.execute',
        params: {
          code: 'print(1)',
          timeoutMs: '1000',
        },
      }),
    ).to.eventually.be.rejectedWith('timeoutMs must be an integer.');
  });

  it('rejects notebook.runAll saveResultPath for bridge requests', async () => {
    await expect(
      dispatchAgentBridgeRequest(assignmentManagerStub, {
        method: 'notebook.runAll',
        params: {
          notebookPath: './test.ipynb',
          saveResultPath: '/tmp/results.json',
        },
      }),
    ).to.eventually.be.rejectedWith(
      'notebook.runAll does not support "saveResultPath". Save results in the client process.',
    );
  });

  it('returns compact markdown-friendly output for notebook.runAll by default', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'notebookRunAll').resolves({
      runtime: {
        owner: 'extension',
        id: randomUUID(),
        label: 'Colab CPU',
        endpoint: 'm-s-test',
        variant: Variant.DEFAULT,
        accelerator: 'NONE',
        dateAssigned: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        baseUrl: 'https://example.com/',
        tokenExpiry: new Date('2026-01-01T01:00:00.000Z').toISOString(),
      },
      notebookPath: '/tmp/example.ipynb',
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      totalCodeCells: 1,
      executedCells: 1,
      failedCells: 0,
      stoppedOnError: false,
      elapsedMs: 10,
      cleanedUpSession: true,
      cells: [
        {
          cellIndex: 0,
          executionIndex: 1,
          status: 'ok',
          elapsedMs: 10,
          sourcePreview: 'print(1)',
          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
          reply: {},
        },
      ],
    } as Awaited<ReturnType<AgentRuntimeService['notebookRunAll']>>);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'notebook.runAll',
      params: {
        notebookPath: '/tmp/example.ipynb',
      },
    })) as {
      readonly format: string;
      readonly cells: readonly { readonly logs: string; readonly ok: boolean }[];
      readonly summaryMarkdown?: string;
    };

    expect(response.format).to.equal('compact');
    expect(response.cells).to.have.length(1);
    expect(response.cells[0].ok).to.equal(true);
    expect(response.cells[0].logs).to.equal('1');
    expect(response.summaryMarkdown).to.contain('# Notebook RunAll Result');
  });

  it('supports outputMode=raw to preserve rich notebook payloads', async () => {
    sinon.stub(AgentRuntimeService.prototype, 'notebookRunAll').resolves({
      runtime: {
        owner: 'extension',
        id: randomUUID(),
        label: 'Colab CPU',
        endpoint: 'm-s-test',
        variant: Variant.DEFAULT,
        accelerator: 'NONE',
        dateAssigned: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        baseUrl: 'https://example.com/',
        tokenExpiry: new Date('2026-01-01T01:00:00.000Z').toISOString(),
      },
      notebookPath: '/tmp/example.ipynb',
      sessionId: 'session-id',
      kernelId: 'kernel-id',
      kernelName: 'python3',
      status: 'ok',
      totalCodeCells: 1,
      executedCells: 1,
      failedCells: 0,
      stoppedOnError: false,
      elapsedMs: 10,
      cleanedUpSession: true,
      cells: [
        {
          cellIndex: 0,
          executionIndex: 1,
          status: 'ok',
          elapsedMs: 10,
          sourcePreview: 'print(1)',
          outputs: [{ type: 'stream', name: 'stdout', text: '1\n' }],
          reply: { status: 'ok' },
        },
      ],
    } as Awaited<ReturnType<AgentRuntimeService['notebookRunAll']>>);

    const response = (await dispatchAgentBridgeRequest(assignmentManagerStub, {
      method: 'notebook.runAll',
      params: {
        notebookPath: '/tmp/example.ipynb',
        outputMode: 'raw',
        render: 'none',
      },
    })) as {
      readonly format?: string;
      readonly cells: readonly { readonly outputs?: readonly unknown[] }[];
    };

    expect(response.format).to.equal(undefined);
    expect(response.cells).to.have.length(1);
    expect(response.cells[0].outputs).to.have.length(1);
  });
});
```

### File: `src/colab/agent-runtime-service.ts`
```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export { AgentRuntimeService } from './agent-runtime/service';
export * from './agent-runtime/types';
```
