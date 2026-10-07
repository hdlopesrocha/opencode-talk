#!/usr/bin/env bash
# Download the small Vosk models used by the plugin's real-time (live) mode.
set -euo pipefail

DIR="${OPENCODE_VOICE_VOSK_DIR:-$HOME/.cache/opencode-voice/vosk}"
mkdir -p "$DIR"

MODELS=(
  vosk-model-small-pt-0.3
  vosk-model-small-en-us-0.15
  vosk-model-small-fr-0.22
)

for model in "${MODELS[@]}"; do
  if [ -d "$DIR/$model" ]; then
    echo "$model already present"
    continue
  fi
  echo "downloading $model…"
  curl -fsSL "https://alphacephei.com/vosk/models/$model.zip" -o "$DIR/$model.zip"
  unzip -q "$DIR/$model.zip" -d "$DIR"
  rm -f "$DIR/$model.zip"
  echo "$model ok"
done

echo "models ready in $DIR"
