#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$HOME/bin"
TARGET_PATH="$TARGET_DIR/colab-agent"
SOURCE_PATH="$ROOT_DIR/scripts/colab-agent"

mkdir -p "$TARGET_DIR"
chmod +x "$SOURCE_PATH"
ln -snf "$SOURCE_PATH" "$TARGET_PATH"

echo "Installed colab-agent -> $TARGET_PATH"
echo "Run: colab-agent up"
