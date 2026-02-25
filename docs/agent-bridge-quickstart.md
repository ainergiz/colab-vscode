# Colab Agent Bridge Quickstart

This is the minimal, reliable flow for external agents to run notebooks hands-free through the patched Colab VS Code extension.

## 1) Enable bridge in machine settings

Set these in VS Code settings (`settings.json`):

```json
{
  "colab.agentBridge.enabled": true,
  "colab.agentBridge.host": "127.0.0.1",
  "colab.agentBridge.port": 0,
  "colab.agentBridge.token": "<long-random-secret>",
  "colab.agentBridge.stateFile": "~/.colab-agent-bridge.json"
}
```

Security defaults:

1. Token is required.
2. Only loopback host is allowed by default.
3. `Content-Type: application/json` is required on bridge requests.

## 2) Load endpoint and bridge token

```bash
export ENDPOINT="$(jq -r '.endpoint' ~/.colab-agent-bridge.json)"
export BRIDGE_TOKEN="$(cat ~/.colab-agent-bridge.token)"
```

## 3) Sanity check

```bash
curl -sS -X POST "$ENDPOINT" \
  -H "authorization: Bearer $BRIDGE_TOKEN" \
  -H "content-type: application/json" \
  --data '{"id":"ping-1","method":"ping","params":{}}' | jq .
```

## 4) Start or reuse runtime

```bash
RUNTIME_JSON="$(curl -sS -X POST "$ENDPOINT" \
  -H "authorization: Bearer $BRIDGE_TOKEN" \
  -H "content-type: application/json" \
  --data '{"id":"rt-1","method":"runtimes.start","params":{"mode":"latestOrCreate"}}')"

RUNTIME_ID="$(printf '%s' "$RUNTIME_JSON" | jq -r '.result.runtime.id')"
echo "RUNTIME_ID=$RUNTIME_ID"
```

## 5) Sync Hugging Face token into this runtime

Important: token sync is runtime-scoped. If you create a new runtime, sync again for that runtime ID.

```bash
# Resolve local HF token.
HF_TOKEN_VALUE="${HF_TOKEN:-}"
if [ -z "$HF_TOKEN_VALUE" ] && [ -f "$HOME/.cache/huggingface/token" ]; then
  HF_TOKEN_VALUE="$(tr -d '\r\n' < "$HOME/.cache/huggingface/token")"
fi
if [ -z "$HF_TOKEN_VALUE" ] && [ -f "$HOME/.huggingface/token" ]; then
  HF_TOKEN_VALUE="$(tr -d '\r\n' < "$HOME/.huggingface/token")"
fi

SYNC_PAYLOAD="$(jq -nc --arg rid "$RUNTIME_ID" --arg hf "$HF_TOKEN_VALUE" \
  '{id:"hf-1",method:"runtime.secrets.sync",params:{from:"extension",id:$rid,hfToken:$hf,verifyRuntimeEnv:true}}')"

curl -sS -X POST "$ENDPOINT" \
  -H "authorization: Bearer $BRIDGE_TOKEN" \
  -H "content-type: application/json" \
  --data "$SYNC_PAYLOAD" \
  | jq '{ok, error, result: {runtimeId: .result.runtime.id, hfTokenVisibleInNewKernel: .result.hfTokenVisibleInNewKernel, wrotePaths: .result.wrotePaths}}'
```

Expected: `hfTokenVisibleInNewKernel: true`.

## 6) Start async notebook run

```bash
NOTEBOOK_PATH="/abs/path/to/notebook.ipynb"

RUN_JSON="$(jq -nc --arg rid "$RUNTIME_ID" --arg nb "$NOTEBOOK_PATH" \
  '{id:"run-1",method:"runs.start",params:{kind:"notebook.runAll",args:{from:"extension",id:$rid,notebookPath:$nb,cleanupSession:true,timeoutMsPerCell:120000,stopOnError:true}}}')"

RUN_ID="$(curl -sS -X POST "$ENDPOINT" \
  -H "authorization: Bearer $BRIDGE_TOKEN" \
  -H "content-type: application/json" \
  --data "$RUN_JSON" | jq -r '.result.runId')"

echo "RUN_ID=$RUN_ID"
```

## 7) Poll run status

```bash
while true; do
  STATUS_JSON="$(curl -sS -X POST "$ENDPOINT" \
    -H "authorization: Bearer $BRIDGE_TOKEN" \
    -H "content-type: application/json" \
    --data "$(jq -nc --arg runId "$RUN_ID" '{id:"run-status",method:"runs.status",params:{runId:$runId}}')")"

  STATUS="$(printf '%s' "$STATUS_JSON" | jq -r '.result.status')"
  echo "status=$STATUS"

  if [ "$STATUS" = "succeeded" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "canceled" ]; then
    printf '%s' "$STATUS_JSON" | jq '{status: .result.status, progress: .result.progress, summaryMarkdown: .result.result.summaryMarkdown}'
    break
  fi

  sleep 2
done
```

## 8) Common mistakes

1. `runs.start` fails with `INVALID_PARAMS`: include both `kind` and `args`.
2. Notebook says `HF token visible: False`: runtime was not synced, or you synced a different runtime ID.
3. Method requests fail with `UNAUTHORIZED`: wrong/missing bridge token.
4. Bridge request fails with `415`: missing `Content-Type: application/json`.
5. Colab proxy-token request fails with `403 PERMISSION_DENIED` + `SERVICE_DISABLED` for `colab.pa.googleapis.com`:
   this is typically a runtime-connection refresh path issue (often with custom OAuth projects), not a universal hard requirement for all runs.
   Try this order:
   1. start a new runtime and run immediately,
   2. if it still fails, re-authenticate with the extension's expected OAuth client,
   3. if you use a custom OAuth project and need refresh support, enable Colab Enterprise API for that project.

## 9) Canonical full guide

For complete method docs and API rules, use:

`docs/agent-bridge-usage-for-agents.md`
