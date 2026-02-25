# Agent Runtime Service Refactor Notes

Date: 2026-02-22

## Goal

Move agent automation behavior behind a single core service, with transport/entry adapters as thin layers.

## New Architecture

1. Core service:
- `src/colab/agent-runtime-service.ts`
- Owns runtime lifecycle, notebook execution, runtime file writes, and secret sync behavior.
- Owns policy checks and behavioral semantics.

2. VS Code commands adapter:
- `src/colab/commands/agent.ts`
- Thin delegation to `AgentRuntimeService`.

3. HTTP bridge adapter:
- `src/colab/agent-bridge.ts`
- Owns HTTP listener, config/auth, request parsing, and request routing.
- Delegates all business operations to `AgentRuntimeService`.

## What Was Consolidated

From previous split logic into core service:
1. `runtimes.list`, `runtimes.start`, `runtimes.stop`, `runtimes.status` behavior.
2. `notebook.execute` and `notebook.runAll` execution behavior.
3. `runtime.files.writeText` behavior.
4. `runtime.secrets.sync` behavior.

## Contract Hardening Included

1. Strict runtime start mode validation:
- Rejects invalid `mode` values; only `latestOrCreate` and `new` are accepted.

## Validation Status

Commands run:
1. `npm run typecheck`
2. `npm run test:unit -- --grep "Agent"`

Result:
1. Typecheck passes.
2. Agent-focused unit tests pass.

## Remaining Optional Work

1. Add additional transport adapters (MCP, stdio/socket) if needed.
2. Add service-focused unit tests that directly target `AgentRuntimeService`.
3. Add bridge controller integration tests for full HTTP lifecycle and auth edges.
