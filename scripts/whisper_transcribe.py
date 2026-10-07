#!/usr/bin/env python3
"""Transcribe a WAV file with faster-whisper and print the text on stdout.

Used by the opencode-voice plugin's `backend: "local"` mode. All diagnostics go
to stderr so stdout stays exactly the transcript.

Usage:
    whisper_transcribe.py <audio.wav> [model]

Environment overrides:
    OPENCODE_VOICE_WHISPER_MODEL     model name or path (default: base)
    OPENCODE_VOICE_WHISPER_DEVICE    cpu | cuda | auto  (default: cpu)
    OPENCODE_VOICE_WHISPER_COMPUTE   int8 | int8_float16 | float16 | float32 (default: int8)
    OPENCODE_VOICE_WHISPER_LANGUAGE  ISO-639-1 code, e.g. en (default: auto-detect)
    OPENCODE_VOICE_WHISPER_BEAM      beam size (default: 1, fastest)
"""

import os
import sys
import wave


def load_wav(path: str):
    """Decode a PCM WAV into a float32 mono array at 16 kHz.

    Doing this ourselves avoids faster-whisper's PyAV-based decoder, which is
    fragile across PyAV versions. The plugin's recorder always writes 16 kHz
    mono PCM, so this is the common path.
    """
    import numpy as np

    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width == 2:
        data = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    elif width == 1:
        data = (np.frombuffer(frames, dtype="u1").astype("float32") - 128.0) / 128.0
    elif width == 4:
        data = np.frombuffer(frames, dtype="<i4").astype("float32") / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width: {width * 8} bits")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)

    if rate != 16000 and data.size:
        target = int(round(data.size * 16000 / rate))
        positions = np.linspace(0.0, data.size - 1, target)
        data = np.interp(positions, np.arange(data.size), data).astype("float32")

    return data


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: whisper_transcribe.py <audio.wav> [model]", file=sys.stderr)
        return 2

    audio = sys.argv[1]
    model_name = (
        sys.argv[2]
        if len(sys.argv) > 2
        else os.environ.get("OPENCODE_VOICE_WHISPER_MODEL", "base")
    )
    device = os.environ.get("OPENCODE_VOICE_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("OPENCODE_VOICE_WHISPER_COMPUTE", "int8")
    language = os.environ.get("OPENCODE_VOICE_WHISPER_LANGUAGE") or None
    beam_size = int(os.environ.get("OPENCODE_VOICE_WHISPER_BEAM", "1"))

    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - import guard
        print(
            f"faster-whisper is not installed in this interpreter: {error}",
            file=sys.stderr,
        )
        return 3

    def run(vad: bool) -> str:
        segments, _info = model.transcribe(
            samples,
            language=language,
            beam_size=beam_size,
            vad_filter=vad,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()

    try:
        samples = load_wav(audio)
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        text = run(True)
        if not text:
            # VAD can drop quiet recordings; retry without it.
            text = run(False)
    except Exception as error:
        print(f"transcription failed: {error}", file=sys.stderr)
        return 1

    if not text:
        print("no speech detected", file=sys.stderr)
        return 4

    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
