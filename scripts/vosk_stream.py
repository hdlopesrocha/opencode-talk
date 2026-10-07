#!/usr/bin/env python3
"""Live speech-to-text with Vosk.

Reads raw 16-bit little-endian mono PCM on stdin (16 kHz by default) and writes
one JSON object per line to stdout:

    {"partial": "..."}   # unstable, still being refined
    {"final": "..."}     # a completed utterance

Used by the opencode-voice plugin's real-time ("live") mode.

Model resolution for --lang pt|en|fr:
  1. OPENCODE_VOICE_VOSK_MODEL_<LANG> environment variable
  2. ~/.cache/opencode-voice/vosk/vosk-model-small-<lang>-*
"""

import argparse
import glob
import json
import os
import sys

DEFAULT_MODELS = {
    "pt": "vosk-model-small-pt-0.3",
    "en": "vosk-model-small-en-us-0.15",
    "fr": "vosk-model-small-fr-0.22",
}


def model_path(lang: str) -> str:
    override = os.environ.get(f"OPENCODE_VOICE_VOSK_MODEL_{lang.upper()}")
    if override:
        return override
    base = os.path.join(os.path.expanduser("~"), ".cache", "opencode-voice", "vosk")
    exact = os.path.join(base, DEFAULT_MODELS.get(lang, DEFAULT_MODELS["en"]))
    if os.path.isdir(exact):
        return exact
    matches = sorted(glob.glob(os.path.join(base, f"vosk-model-*{lang}*")))
    return matches[0] if matches else exact


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default="en")
    parser.add_argument("--model")
    parser.add_argument("--sample-rate", type=int, default=16000)
    args = parser.parse_args()

    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)

    path = args.model or model_path(args.lang)
    if not os.path.isdir(path):
        print(f"vosk model not found for '{args.lang}': {path}", file=sys.stderr)
        return 2

    model = Model(path)
    recognizer = KaldiRecognizer(model, args.sample_rate)

    stdin = sys.stdin.buffer
    while True:
        chunk = stdin.read(8000)
        if not chunk:
            break
        if recognizer.AcceptWaveform(chunk):
            text = json.loads(recognizer.Result()).get("text", "").strip()
            if text:
                emit({"final": text})
        else:
            partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
            emit({"partial": partial})

    text = json.loads(recognizer.FinalResult()).get("text", "").strip()
    emit({"final": text})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
