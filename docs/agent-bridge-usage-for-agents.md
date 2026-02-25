# Colab Agent Bridge: Usage Guide for Agents

This guide documents how an external agent should use the Colab VS Code extension bridge safely and reliably.

## 1) What This Is

The extension exposes a local HTTP API (bridge) to run runtime lifecycle actions and notebook execution headlessly.

Endpoint pattern:

1. `POST /v1/colab-agent` for RPC-style method calls
2. `GET /healthz` for basic health

## 2) Enable It (Machine Settings)

Set these VS Code settings (machine scope):

```json
{
  "colab.agentBridge.enabled": true,
  "colab.agentBridge.host": "127.0.0.1",
  "colab.agentBridge.port": 0,
  "colab.agentBridge.token": "<long-random-secret>",
  "colab.agentBridge.stateFile": "~/.colab-agent-bridge.json"
}
```

Important defaults:

1. Token is required when enabled.
2. Non-loopback hosts are blocked unless `colab.agentBridge.allowRemoteHost=true`.
3. Wildcard bind hosts (`0.0.0.0`, `::`) are rejected.

## 3) Discovery + Auth

After startup, read state file:

1. `~/.colab-agent-bridge.json` (default)
2. Contains `endpoint`, `host`, `port`, `tokenRequired`, `pid`, `startedAt`

Request headers:

1. `Content-Type: application/json` (required)
2. `Authorization: Bearer <token>` or `x-colab-agent-token: <token>`

## 4) Request / Response Contract

Request envelope:

```json
{
  "id": "optional-string-or-number",
  "method": "runtimes.start",
  "params": {}
}
```

Success response:

```json
{
  "id": "same-as-request",
  "ok": true,
  "result": {}
}
```

Method-level failure response:

```json
{
  "id": "same-as-request",
  "ok": false,
  "error": {
    "name": "AgentBridgeError",
    "code": "INVALID_PARAMS",
    "message": "..."
  }
}
```

Transport failures use HTTP error status and `ok:false`, for example:

1. `401` `UNAUTHORIZED`
2. `404` `NOT_FOUND`
3. `405` `METHOD_NOT_ALLOWED`
4. `413` `PAYLOAD_TOO_LARGE`
5. `415` `UNSUPPORTED_MEDIA_TYPE`

## 5) Supported Methods

1. `ping`
2. `bridge.capabilities`
3. `runtimes.list`
4. `runtimes.options`
5. `runtimes.start`
6. `runtimes.stop`
7. `runtimes.status`
8. `notebook.execute`
9. `notebook.runAll`
10. `runtime.files.writeText`
11. `runtime.secrets.sync`
12. `runs.start`
13. `runs.status`
14. `runs.list`
15. `runs.cancel`

## 6) Core Parameter Rules

### Runtime scope (`from`)

Allowed:

1. `extension`
2. `external`
3. `all`

Execution methods (`notebook.execute`, `notebook.runAll`, `runtime.files.writeText`, `runtime.secrets.sync`) should target extension-assigned runtimes (`from=extension` or `all` selecting an extension runtime).

### `runtimes.start`

`mode`:

1. `latestOrCreate`
2. `new`

Optional descriptor fields:

1. `label`
2. `variant` (`DEFAULT|GPU|TPU`)
3. `accelerator`
4. `shape` (`STANDARD|HIGHMEM|0|1`)
5. `version`

### `runtimes.options`

Returns account-eligible runtime descriptors before assignment.

Result fields:

1. `options[]` with `label|variant|accelerator|shape|version`
2. `counts.total`
3. `counts.byVariant.DEFAULT|GPU|TPU`

### `notebook.execute`

Required:

1. `code` (non-empty string)

Optional:

1. runtime selectors: `from|id|endpoint|label`
2. `timeoutMs`
3. `kernelName`
4. `cleanupSession` (default `true`)
5. `outputMode` (`compact` default, `raw`)
6. `render` (`markdown` default, `none`)

### `notebook.runAll`

Required:

1. `notebookPath` (non-empty string)

Optional:

1. runtime selectors: `from|id|endpoint|label`
2. `timeoutMsPerCell`
3. `stopOnError` (default `true`)
4. `kernelName`
5. `cleanupSession` (default `true`)
6. `saveCellsRuntimeDir`
7. `outputMode` (`compact` default, `raw`)
8. `render` (`markdown` default, `none`)

Not supported:

1. `saveResultPath` (client should save response locally)

### `runtime.files.writeText`

Required:

1. `runtimePath`
2. `text`

Optional:

1. runtime selectors
2. `createDirectories` (default `true`)

### `runtime.secrets.sync`

Required token field (any one):

1. `hfToken`
2. `HF_TOKEN`
3. `hfAccessToken`
4. `HF_ACCESS_TOKEN`

Optional:

1. runtime selectors
2. `writeIpythonStartup` (default `true`)
3. `writeHfHomeTokenFile` (default `true`)
4. `writeHfCacheTokenFile` (default `true`)
5. `verifyRuntimeEnv` (default `true`)

Important:

1. Token sync is runtime-scoped. If you start a new runtime, call `runtime.secrets.sync` again for that runtime ID.
2. Keep `verifyRuntimeEnv=true` unless you are optimizing for speed. It confirms `HF_TOKEN` is visible in a fresh kernel.

### `runs.start`

Starts a background run and returns immediately.

Required:

1. `kind`: `notebook.execute` or `notebook.runAll`
2. `args`: corresponding method args object

### `runs.status`

Required:

1. `runId`

Optional:

1. `includeResult` (default `true`)
2. `outputMode` (`compact` default, `raw`) for notebook result formatting
3. `render` (`markdown` default, `none`)

### `runs.list`

Optional:

1. `limit` (default `20`, max `200`)
2. `status` (`queued|running|succeeded|failed|canceled`)

### `runs.cancel`

Required:

1. `runId`

## 7) Output Modes (Agent-Friendly)

Default mode for notebook methods:

1. `outputMode=compact`
2. `render=markdown`

Compact result includes:

1. per-cell `ok`/`status`
2. per-cell merged `logs`
3. optional `error`
4. `summaryMarkdown` for quick human scan

Use `outputMode=raw` when you need full Jupyter output objects.

## 8) Recommended Agent Flow

1. Read state file and endpoint.
2. Call `bridge.capabilities`.
3. Call `runtimes.options` to select `variant|accelerator|shape`.
4. Call `runtimes.start` with `mode=new` (explicit descriptor) or `latestOrCreate`.
5. If model auth is needed, call `runtime.secrets.sync` for the selected runtime ID.
6. Execute:
   1. ad-hoc code via `notebook.execute`, or
   2. full notebook via `notebook.runAll`.
7. For long-running jobs, use `runs.start` then poll `runs.status`.
8. Parse `result.summaryMarkdown` and/or compact cell logs.
9. Optionally call `runtimes.stop`.

## 9) Example Calls

### Start runtime

```bash
curl -sS -X POST "$ENDPOINT" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data '{"id":"1","method":"runtimes.start","params":{"mode":"latestOrCreate"}}'
```

### Run notebook (compact markdown default)

```bash
curl -sS -X POST "$ENDPOINT" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data '{"id":"2","method":"notebook.runAll","params":{"notebookPath":"/abs/path/notebook.ipynb","from":"extension","cleanupSession":true}}'
```

### Sync HF token

```bash
curl -sS -X POST "$ENDPOINT" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data '{"id":"3","method":"runtime.secrets.sync","params":{"from":"extension","id":"<runtime-id>","hfToken":"<hf_token>"}}'
```

### Async notebook run with HF token (recommended for long jobs)

```bash
# 1) start or reuse runtime
RUNTIME_JSON=$(curl -sS -X POST "$ENDPOINT" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data '{"id":"10","method":"runtimes.start","params":{"mode":"latestOrCreate"}}')
RUNTIME_ID=$(printf '%s' "$RUNTIME_JSON" | jq -r '.result.runtime.id')

# 2) sync token into that runtime
curl -sS -X POST "$ENDPOINT" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data "$(jq -nc --arg rid "$RUNTIME_ID" --arg hf "$HF_TOKEN" \
    '{id:"11",method:"runtime.secrets.sync",params:{from:"extension",id:$rid,hfToken:$hf,verifyRuntimeEnv:true}}')"

# 3) enqueue runAll as async job
curl -sS -X POST "$ENDPOINT" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data "$(jq -nc --arg rid "$RUNTIME_ID" --arg nb "/abs/path/notebook.ipynb" \
    '{id:"12",method:"runs.start",params:{kind:"notebook.runAll",args:{from:"extension",id:$rid,notebookPath:$nb,cleanupSession:true}}}')"
```

## 10) CLI Wrapper

Script:

1. `scripts/colab-agent-bridge.mts`

Usage:

```bash
COLAB_AGENT_BRIDGE_TOKEN="$TOKEN" \
npx tsx scripts/colab-agent-bridge.mts notebook.execute '{"code":"print(123)"}'
```

Supports params from inline JSON, `@file`, or stdin (`-`).

## 11) MCP Adapter

Script:

1. `scripts/colab-agent-bridge-mcp.mts`

Run:

```bash
npm run agent:bridge:mcp
```

This starts a stdio MCP server exposing bridge methods as MCP tools. See:

`docs/agent-bridge-mcp.md`

## 12) One-Command MedGemma Smoke

Script:

1. `scripts/colab-medgemma-smoke.sh`

What it does:

1. Starts a new `GPU/T4` runtime (or uses `--runtime-id`).
2. Syncs Hugging Face token into runtime.
3. Runs official MedGemma image-text inference path.
4. Prints decoded model output.

Usage:

```bash
colab-medgemma-smoke
```

Optional flags:

1. `--runtime-id <id>`
2. `--accelerator <name>`
3. `--model-id <repo>`
4. `--image-url <url>`
5. `--prompt <text>`
6. `--timeout-ms <ms>`
7. `--stop-runtime`

## 13) Troubleshooting Patterns

1. `UNAUTHORIZED`: wrong/missing bridge token header.
2. `INVALID_PARAMS`: wrong param type/value (bridge parser is strict).
3. `No matching extension-assigned runtime`: call `runtimes.start` first.
4. Colab assign `412 Precondition Failed`: retry, or use `mode=latestOrCreate`.
5. Colab runtime proxy token `403 PERMISSION_DENIED` with `SERVICE_DISABLED` on `colab.pa.googleapis.com`:
   this usually appears on runtime-connection refresh for specific OAuth project setups, not as a universal requirement for all notebook runs.
   Try in order:
   1. start a fresh runtime and execute immediately (avoid stale-token refresh path),
   2. re-authenticate with the extension's expected OAuth client,
   3. if you intentionally use a custom OAuth project and need refresh support, enable Colab Enterprise API for that project.
6. HuggingFace `403 GatedRepoError`: token exists but model access not granted for that account/token.
