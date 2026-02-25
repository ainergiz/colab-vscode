#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  colab-medgemma-smoke [options]

Options:
  --runtime-id <id>      Use an existing extension-assigned runtime ID.
  --accelerator <name>   GPU accelerator for new runtime (default: T4).
  --model-id <repo>      Hugging Face model ID (default: google/medgemma-1.5-4b-it).
  --image-url <url>      Input image URL.
  --prompt <text>        Prompt text paired with the image.
  --timeout-ms <ms>      notebook.execute timeout in ms (1..600000, default: 600000).
  --stop-runtime         Stop selected runtime at the end.
  --help                 Show this help.

Environment:
  HF_TOKEN                       Optional. If unset, token is read from:
                                 ~/.cache/huggingface/token or ~/.huggingface/token
  COLAB_AGENT_BRIDGE_STATE_FILE Optional. Default: ~/.colab-agent-bridge.json
  COLAB_AGENT_BRIDGE_TOKEN_FILE Optional. Default: ~/.colab-agent-bridge.token
  COLAB_AGENT_BRIDGE_TOKEN       Optional. Overrides token file for bridge auth.
EOF
}

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name" >&2
    exit 1
  fi
}

read_hf_token() {
  if [[ -n "${HF_TOKEN:-}" ]]; then
    printf '%s' "$HF_TOKEN"
    return
  fi

  local token_paths=(
    "$HOME/.cache/huggingface/token"
    "$HOME/.huggingface/token"
  )
  local p
  for p in "${token_paths[@]}"; do
    if [[ -f "$p" ]]; then
      local t
      t="$(tr -d '\n' < "$p")"
      if [[ -n "$t" ]]; then
        printf '%s' "$t"
        return
      fi
    fi
  done
}

bridge_call() {
  local method="$1"
  local params_json="$2"
  colab-agent-bridge "$method" "$params_json"
}

assert_ok() {
  local context="$1"
  local payload="$2"
  node -e '
const context = process.argv[1];
const payload = JSON.parse(process.argv[2]);
if (!payload.ok) {
  const message = payload?.error?.message ?? "unknown bridge error";
  console.error(`${context} failed: ${message}`);
  process.exit(1);
}
' "$context" "$payload"
}

RUNTIME_ID=""
ACCELERATOR="T4"
MODEL_ID="google/medgemma-1.5-4b-it"
IMAGE_URL="https://upload.wikimedia.org/wikipedia/commons/c/c8/Chest_Xray_PA_3-8-2010.png"
PROMPT_TEXT="Describe this X-ray in one sentence."
TIMEOUT_MS="600000"
STOP_RUNTIME="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-id)
      RUNTIME_ID="${2:-}"
      shift 2
      ;;
    --accelerator)
      ACCELERATOR="${2:-}"
      shift 2
      ;;
    --model-id)
      MODEL_ID="${2:-}"
      shift 2
      ;;
    --image-url)
      IMAGE_URL="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT_TEXT="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --stop-runtime)
      STOP_RUNTIME="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

require_cmd colab-agent-bridge
require_cmd node

if ! [[ "$TIMEOUT_MS" =~ ^[0-9]+$ ]] || (( TIMEOUT_MS < 1 || TIMEOUT_MS > 600000 )); then
  echo "--timeout-ms must be an integer in [1, 600000]" >&2
  exit 2
fi

HF_TOKEN_VALUE="$(read_hf_token || true)"
if [[ -z "$HF_TOKEN_VALUE" ]]; then
  echo "HF token not found. Set HF_TOKEN or login to Hugging Face locally." >&2
  exit 1
fi

if [[ -z "$RUNTIME_ID" ]]; then
  START_PARAMS="$(node -e '
const accelerator = process.argv[1];
const label = process.argv[2];
process.stdout.write(JSON.stringify({
  mode: "new",
  variant: "GPU",
  accelerator,
  shape: "STANDARD",
  label,
}));
' "$ACCELERATOR" "Colab GPU ${ACCELERATOR} MedGemma")"
  START_RESPONSE="$(bridge_call "runtimes.start" "$START_PARAMS")"
  assert_ok "runtimes.start" "$START_RESPONSE"
  RUNTIME_ID="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.result.runtime.id);' "$START_RESPONSE")"
fi

SYNC_PARAMS="$(node -e '
const runtimeId = process.argv[1];
const hfToken = process.argv[2];
process.stdout.write(JSON.stringify({
  from: "extension",
  id: runtimeId,
  hfToken,
  verifyRuntimeEnv: true,
  writeIpythonStartup: true,
  writeHfHomeTokenFile: true,
  writeHfCacheTokenFile: true,
}));
' "$RUNTIME_ID" "$HF_TOKEN_VALUE")"
SYNC_RESPONSE="$(bridge_call "runtime.secrets.sync" "$SYNC_PARAMS")"
assert_ok "runtime.secrets.sync" "$SYNC_RESPONSE"

PY_CODE="$(cat <<'PY'
import os
import subprocess
import sys
from pathlib import Path

import requests
import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor

model_id = os.environ["COLAB_MEDGEMMA_MODEL_ID"]
image_url = os.environ["COLAB_MEDGEMMA_IMAGE_URL"]
prompt_text = os.environ["COLAB_MEDGEMMA_PROMPT"]

hf_token = os.environ.get("HF_TOKEN")
if not hf_token:
    for p in [
        Path("/content/.agent-secrets/hf_token"),
        Path("/root/.huggingface/token"),
        Path("/root/.cache/huggingface/token"),
    ]:
        if p.exists():
            t = p.read_text(encoding="utf-8").strip()
            if t:
                hf_token = t
                break

subprocess.run(
    [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-q",
        "transformers>=4.57.0",
        "accelerate>=1.10.0",
        "pillow>=10.0.0",
        "requests>=2.31.0",
    ],
    check=True,
)

print("cuda_available", torch.cuda.is_available())
if torch.cuda.is_available():
    print("cuda_device", torch.cuda.get_device_name(0))

model = AutoModelForImageTextToText.from_pretrained(
    model_id,
    token=hf_token,
    torch_dtype=torch.bfloat16,
    device_map="auto",
)
processor = AutoProcessor.from_pretrained(model_id, token=hf_token)

image = Image.open(
    requests.get(
        image_url,
        headers={"User-Agent": "colab-agent-bridge-medgemma-smoke"},
        stream=True,
    ).raw
)

messages = [
    {
        "role": "user",
        "content": [
            {"type": "image", "image": image},
            {"type": "text", "text": prompt_text},
        ],
    }
]

inputs = processor.apply_chat_template(
    messages,
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
)
inputs = inputs.to(model.device, dtype=torch.bfloat16)
input_len = inputs["input_ids"].shape[-1]

with torch.inference_mode():
    generation = model.generate(
        **inputs,
        max_new_tokens=128,
        do_sample=False,
    )
generation = generation[0][input_len:]

decoded = processor.decode(generation, skip_special_tokens=True).strip()
print("=== OUTPUT START ===")
print(decoded)
print("=== OUTPUT END ===")
PY
)"

PY_CODE_WITH_ENV="$(node -e '
const modelId = process.argv[1];
const imageUrl = process.argv[2];
const prompt = process.argv[3];
const code = process.argv[4];
const header = [
  "import os",
  `os.environ[\"COLAB_MEDGEMMA_MODEL_ID\"] = ${JSON.stringify(modelId)}`,
  `os.environ[\"COLAB_MEDGEMMA_IMAGE_URL\"] = ${JSON.stringify(imageUrl)}`,
  `os.environ[\"COLAB_MEDGEMMA_PROMPT\"] = ${JSON.stringify(prompt)}`,
  "",
].join("\n");
process.stdout.write(`${header}${code}`);
' "$MODEL_ID" "$IMAGE_URL" "$PROMPT_TEXT" "$PY_CODE")"

EXEC_PARAMS="$(node -e '
const runtimeId = process.argv[1];
const timeoutMs = Number(process.argv[2]);
const code = process.argv[3];
process.stdout.write(JSON.stringify({
  from: "extension",
  id: runtimeId,
  code,
  timeoutMs,
  cleanupSession: true,
  outputMode: "compact",
  render: "markdown",
}));
' "$RUNTIME_ID" "$TIMEOUT_MS" "$PY_CODE_WITH_ENV")"

EXEC_RESPONSE="$(bridge_call "notebook.execute" "$EXEC_PARAMS")"
assert_ok "notebook.execute transport" "$EXEC_RESPONSE"

STATUS="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(o.result?.status ?? "unknown");' "$EXEC_RESPONSE")"
if [[ "$STATUS" != "ok" ]]; then
  node -e '
const o = JSON.parse(process.argv[1]);
const msg = o?.result?.error?.message || o?.error?.message || "notebook execution failed";
console.error(`notebook.execute failed: ${msg}`);
process.exit(1);
' "$EXEC_RESPONSE"
fi

MODEL_OUTPUT="$(node -e '
const payload = JSON.parse(process.argv[1]);
const logs = payload?.result?.logs ?? "";
const match = /=== OUTPUT START ===\n([\s\S]*?)\n=== OUTPUT END ===/.exec(logs);
process.stdout.write(match ? match[1].trim() : "");
' "$EXEC_RESPONSE")"

ELAPSED_MS="$(node -e 'const o=JSON.parse(process.argv[1]); process.stdout.write(String(o.result?.elapsedMs ?? ""));' "$EXEC_RESPONSE")"

echo "runtime_id: $RUNTIME_ID"
echo "elapsed_ms: $ELAPSED_MS"
echo "model_id: $MODEL_ID"
echo "image_url: $IMAGE_URL"
echo "prompt: $PROMPT_TEXT"
echo "---"
echo "$MODEL_OUTPUT"

if [[ "$STOP_RUNTIME" == "true" ]]; then
  STOP_PARAMS="$(node -e '
const runtimeId = process.argv[1];
process.stdout.write(JSON.stringify({
  from: "extension",
  id: runtimeId,
  all: false,
}));
' "$RUNTIME_ID")"
  STOP_RESPONSE="$(bridge_call "runtimes.stop" "$STOP_PARAMS")"
  assert_ok "runtimes.stop" "$STOP_RESPONSE"
fi
