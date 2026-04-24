#!/usr/bin/env python3
"""
whisper_transcribe.py -- Local transcription using OpenAI Whisper on CPU.
Used as a fallback when MLX is unavailable on the current machine.

Usage:
  python3 whisper_transcribe.py <audio_file> [--model <model_name>]

Output: JSON to stdout with { "text": "...", "segments": [...] }
All progress/status output goes to stderr so stdout stays clean JSON.
"""

import argparse
import json
import os
import sys


def normalize_model(name: str) -> str:
    value = (name or "large").strip().lower()
    if value in {"large-v1", "large-v2", "large-v3"}:
        return "large"
    return value or "large"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--model", default="large", help="OpenAI Whisper model size")
    args = parser.parse_args()

    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

    import whisper

    model = whisper.load_model(normalize_model(args.model), device="cpu")
    result = model.transcribe(
        args.audio_file,
        verbose=False,
        fp16=False,
    )

    sys.stdout = real_stdout

    output = {
        "text": result.get("text", ""),
        "segments": [
            {
                "start": round(seg["start"], 1),
                "end": round(seg["end"], 1),
                "text": seg.get("text", "").strip(),
            }
            for seg in result.get("segments", [])
        ],
    }
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
