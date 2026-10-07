#!/usr/bin/env python3
"""Read text on stdin and speak it with Microsoft Edge neural TTS (edge-tts).

Falls back to spd-say if synthesis or playback fails, so speech never goes
silent. Used by the opencode-voice plugin's `command` TTS engine.

Environment:
  OPENCODE_VOICE_TTS_VOICE   language code (pt, pt-br, en, es, ...) or an
                             explicit edge voice name (e.g. pt-PT-RaquelNeural)
  OPENCODE_VOICE_TTS_RATE    -100..100, mapped to edge's percentage rate
  OPENCODE_VOICE_EDGE_VOICE  explicit edge voice (highest priority)
"""

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile

DEFAULT_VOICES = {
    "pt": "pt-PT-RaquelNeural",
    "pt-pt": "pt-PT-RaquelNeural",
    "pt-br": "pt-BR-FranciscaNeural",
    "en": "en-US-AriaNeural",
    "en-us": "en-US-AriaNeural",
    "en-gb": "en-GB-SoniaNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "it": "it-IT-ElsaNeural",
}


def choose_voice() -> str:
    explicit = os.environ.get("OPENCODE_VOICE_EDGE_VOICE")
    if explicit:
        return explicit
    value = (os.environ.get("OPENCODE_VOICE_TTS_VOICE") or "pt").strip()
    if "-" in value and value.lower().endswith("neural"):
        return value
    key = value.lower()
    return DEFAULT_VOICES.get(key) or DEFAULT_VOICES.get(key.split("-")[0]) or "pt-PT-RaquelNeural"


def rate() -> str:
    try:
        value = int(float(os.environ.get("OPENCODE_VOICE_TTS_RATE") or "0"))
    except ValueError:
        value = 0
    value = max(-100, min(100, value))
    return f"{value:+d}%"


def play(path: str) -> bool:
    players = (
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", path],
        ["mpv", "--no-video", "--really-quiet", path],
        ["paplay", path],
    )
    for player in players:
        if shutil.which(player[0]):
            subprocess.run(player, check=False)
            return True
    return False


def fallback(text: str) -> None:
    exe = shutil.which("spd-say")
    if not exe:
        return
    voice = os.environ.get("OPENCODE_VOICE_TTS_VOICE") or "pt"
    subprocess.run([exe, "-w", "-l", voice, "-e"], input=text.encode(), check=False)


async def synth(text: str, path: str, voice: str, rate_value: str) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice, rate=rate_value)
    await communicate.save(path)


def main() -> int:
    text = sys.stdin.read().strip()
    if not text:
        return 0

    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as handle:
            path = handle.name
        asyncio.run(synth(text, path, choose_voice(), rate()))
        if not play(path):
            raise RuntimeError("no audio player found (ffplay/mpv/paplay)")
        return 0
    except Exception as error:  # noqa: BLE001 - must never crash the plugin
        print(f"edge-tts failed: {error}", file=sys.stderr)
        fallback(text)
        return 0
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
