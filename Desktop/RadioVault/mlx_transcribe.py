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
import shutil
from subprocess import CalledProcessError, run


def resolve_ffmpeg_path(explicit_path: str = ""):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        explicit_path,
        os.environ.get("RADIOVAULT_FFMPEG_PATH", ""),
        os.environ.get("FFMPEG_PATH", ""),
        os.path.join(script_dir, "node_modules", "ffmpeg-static", "ffmpeg"),
        os.path.join(os.path.dirname(script_dir), "node_modules", "ffmpeg-static", "ffmpeg"),
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg",
    ]
    seen = set()
    for candidate in candidates:
        candidate = (candidate or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        candidate = os.path.expanduser(candidate)
        if os.path.isabs(candidate):
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return ""


def configure_ffmpeg(ffmpeg_path: str):
    if not ffmpeg_path:
        return
    ffmpeg_dir = os.path.dirname(ffmpeg_path)
    path_parts = [part for part in os.environ.get("PATH", "").split(os.pathsep) if part]
    if ffmpeg_dir not in path_parts:
        os.environ["PATH"] = os.pathsep.join([ffmpeg_dir] + path_parts)
    os.environ["RADIOVAULT_FFMPEG_PATH"] = ffmpeg_path
    os.environ["FFMPEG_PATH"] = ffmpeg_path


def patch_mlx_audio(ffmpeg_path: str):
    if not ffmpeg_path:
        return

    import mlx_whisper.audio as mlx_audio

    def load_audio(file: str = None, sr: int = mlx_audio.SAMPLE_RATE, from_stdin=False):
        if from_stdin:
            cmd = [ffmpeg_path, "-i", "pipe:0"]
        else:
            cmd = [ffmpeg_path, "-nostdin", "-i", file]
        cmd.extend([
            "-threads", "0",
            "-f", "s16le",
            "-ac", "1",
            "-acodec", "pcm_s16le",
            "-ar", str(sr),
            "-"
        ])
        try:
            out = run(cmd, capture_output=True, check=True).stdout
        except CalledProcessError as exc:
            raise RuntimeError(f"Failed to load audio: {exc.stderr.decode()}") from exc

        return mlx_audio.mx.array(mlx_audio.np.frombuffer(out, mlx_audio.np.int16)).flatten().astype(mlx_audio.mx.float32) / 32768.0

    mlx_audio.load_audio = load_audio

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--model", default="mlx-community/whisper-large-v3-mlx",
                        help="HuggingFace model ID (default: whisper-large-v3)")
    parser.add_argument("--ffmpeg-path", default="", help="Absolute path to ffmpeg")
    args = parser.parse_args()

    # Redirect stdout to stderr during import and transcription
    # so progress bars and "Detected language" don't corrupt our JSON output
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    # Also suppress tqdm progress bars via environment
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    ffmpeg_path = resolve_ffmpeg_path(args.ffmpeg_path)
    configure_ffmpeg(ffmpeg_path)

    import mlx_whisper
    patch_mlx_audio(ffmpeg_path)

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
