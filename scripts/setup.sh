#!/usr/bin/env bash
# Set up the Python virtualenv used by opencode-voice:
#   - faster-whisper  (local speech-to-text)
#   - edge-tts        (neural text-to-speech)
#   - vosk            (optional; only if you kept live mode)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Creating .venv…"
python3 -m venv .venv

if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  echo "Bootstrapping pip…"
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/opencode-get-pip.py
  .venv/bin/python /tmp/opencode-get-pip.py
fi

echo "Installing Python dependencies…"
.venv/bin/python -m pip install --upgrade pip >/dev/null
.venv/bin/python -m pip install faster-whisper edge-tts

echo
echo "Done."
echo "Next: add the plugin to ~/.config/opencode/opencode.jsonc (see README)."
