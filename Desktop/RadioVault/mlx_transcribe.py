#!/usr/bin/env python3
"""
mlx_transcribe.py — Local Whisper transcription using MLX on Apple Silicon.
Called by ingest.js when transcription provider is set to "local".

Usage:
  python3 mlx_transcribe.py <audio_file> [--model <model_name>]

Output: JSON to stdout with { "text": "...", "segments": [...] }
All progress/status output goes to stderr so stdout stays clean JSON.
"""

import sys
import os
import json
import argparse
import io

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--model", default="mlx-community/whisper-large-v3-mlx",
                        help="HuggingFace model ID (default: whisper-large-v3)")
    args = parser.parse_args()

    # Redirect stdout to stderr during import and transcription
    # so progress bars and "Detected language" don't corrupt our JSON output
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    # Also suppress tqdm progress bars via environment
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

    import mlx_whisper

    result = mlx_whisper.transcribe(
        args.audio_file,
        path_or_hf_repo=args.model,
        verbose=False,
    )

    # Restore stdout for our JSON output
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
