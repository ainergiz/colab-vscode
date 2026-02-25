# Colab Agent Bridge MCP Adapter

This adapter exposes the local Colab agent bridge as a stdio MCP server.

It lets MCP-capable agents call Colab runtime and notebook operations as MCP tools.

## 1) Prerequisites

1. Colab extension bridge is enabled and healthy.
2. `~/.colab-agent-bridge.json` exists.
3. Bridge token is available either:
   1. `COLAB_AGENT_BRIDGE_TOKEN` env var, or
   2. `~/.colab-agent-bridge.token` file.

Bridge health check:

```bash
ENDPOINT="$(jq -r '.endpoint' ~/.colab-agent-bridge.json)"
curl -sS "${ENDPOINT%/v1/colab-agent}/healthz"
```

## 2) Run MCP server manually

From repo root:

```bash
npm run agent:bridge:mcp
```

Equivalent:

```bash
npx tsx scripts/colab-agent-bridge-mcp.mts
```

Optional env:

1. `COLAB_AGENT_BRIDGE_ENDPOINT` to bypass state-file discovery.
2. `COLAB_AGENT_BRIDGE_STATE_FILE` custom state file path.
3. `COLAB_AGENT_BRIDGE_TOKEN` explicit token value.
4. `COLAB_AGENT_BRIDGE_TOKEN_FILE` custom token file path.
5. `COLAB_AGENT_MCP_DEBUG=1` debug logs to stderr.

## 3) MCP client config example (Cursor-style)

Use absolute paths for reliability.

```json
{
  "mcpServers": {
    "colabBridge": {
      "command": "/Users/ainergiz/colab-vscode-agent-bridge/node_modules/.bin/tsx",
      "args": [
        "/Users/ainergiz/colab-vscode-agent-bridge/scripts/colab-agent-bridge-mcp.mts"
      ],
      "env": {
        "COLAB_AGENT_BRIDGE_STATE_FILE": "/Users/ainergiz/.colab-agent-bridge.json",
        "COLAB_AGENT_BRIDGE_TOKEN_FILE": "/Users/ainergiz/.colab-agent-bridge.token"
      }
    }
  }
}
```

## 4) Exposed MCP tools

1. `colab_bridge_call` (generic bridge method caller)
2. `colab_ping`
3. `colab_bridge_capabilities`
4. `colab_runtimes_list`
5. `colab_runtimes_options`
6. `colab_runtimes_start`
7. `colab_runtimes_stop`
8. `colab_runtimes_status`
9. `colab_notebook_execute`
10. `colab_notebook_run_all`
11. `colab_runtime_files_write_text`
12. `colab_runtime_secrets_sync`
13. `colab_runs_start`
14. `colab_runs_status`
15. `colab_runs_list`
16. `colab_runs_cancel`

## 5) Recommended call flow for long notebook jobs

1. `colab_runtimes_start`
2. `colab_runtime_secrets_sync` (if model auth needed)
3. `colab_runs_start` with `kind=notebook.runAll`
4. poll `colab_runs_status` until terminal state

Use `summaryMarkdown` from run results for compact, human-friendly output.

## 6) Troubleshooting

1. MCP server starts but tool calls fail with `UNAUTHORIZED`:
   token mismatch; verify token env/file.
2. Tool calls fail with connection error:
   bridge is down; re-open Cursor/VS Code and confirm `healthz`.
3. `INVALID_PARAMS`:
   bridge params are strict; ensure argument types are correct.
4. Colab proxy token refresh `403 SERVICE_DISABLED`:
   start fresh runtime and run immediately first; if needed, re-authenticate and review OAuth project config.
