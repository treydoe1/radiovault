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
import shutil
import sys
from subprocess import CalledProcessError, run


def normalize_model(name: str) -> str:
    value = (name or "large").strip().lower()
    if value in {"large-v1", "large-v2", "large-v3"}:
        return "large"
    return value or "large"


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


def patch_whisper_audio(ffmpeg_path: str):
    if not ffmpeg_path:
        return

    import whisper.audio as whisper_audio

    def load_audio(file: str, sr: int = whisper_audio.SAMPLE_RATE):
        cmd = [
            ffmpeg_path,
            "-nostdin",
            "-threads", "0",
            "-i", file,
            "-f", "s16le",
            "-ac", "1",
            "-acodec", "pcm_s16le",
            "-ar", str(sr),
            "-"
        ]
        try:
            out = run(cmd, capture_output=True, check=True).stdout
        except CalledProcessError as exc:
            raise RuntimeError(f"Failed to load audio: {exc.stderr.decode()}") from exc

        return whisper_audio.np.frombuffer(out, whisper_audio.np.int16).flatten().astype(whisper_audio.np.float32) / 32768.0

    whisper_audio.load_audio = load_audio


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument("--model", default="large", help="OpenAI Whisper model size")
    parser.add_argument("--ffmpeg-path", default="", help="Absolute path to ffmpeg")
    args = parser.parse_args()

    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    ffmpeg_path = resolve_ffmpeg_path(args.ffmpeg_path)
    configure_ffmpeg(ffmpeg_path)

    import whisper
    patch_whisper_audio(ffmpeg_path)

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
