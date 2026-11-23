"""Text -> speech with Kokoro -> AAC .m4a via ffmpeg."""

import os
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path

import numpy as np

SAMPLE_RATE = 24000
DEFAULT_VOICE = os.environ.get("NARRATE_VOICE", "af_heart")
REPO_ID = "hexgrad/Kokoro-82M"

_pipeline = None
_lock = threading.Lock()


class Cancelled(Exception):
    pass


def load():
    """Load Kokoro once (slow on first call)."""
    global _pipeline
    with _lock:
        if _pipeline is None:
            from kokoro import KPipeline

            _pipeline = KPipeline(lang_code="a", repo_id=REPO_ID)
        return _pipeline


_get_pipeline = load  # used by scripts/tts_bench.py


def synthesize(
    text: str,
    voice: str = DEFAULT_VOICE,
    speed: float = 1.0,
    should_stop: Callable[[], bool] | None = None,
) -> np.ndarray:
    """Return mono float32 audio at SAMPLE_RATE.

    `should_stop` is checked between Kokoro segments (a few sentences each);
    if it returns True, Cancelled is raised.
    """
    pipeline = load()
    chunks = []
    gap = np.zeros(int(SAMPLE_RATE * 0.15), dtype=np.float32)  # short pause between segments
    for result in pipeline(text, voice=voice, speed=speed, split_pattern=r"\n+"):
        if should_stop and should_stop():
            raise Cancelled()
        if result.audio is not None:
            chunks.append(result.audio.numpy().astype(np.float32))
            chunks.append(gap)
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def encode_m4a(audio: np.ndarray, out_path: Path, bitrate: str = "64k") -> None:
    """Encode to AAC .m4a, writing to a temp file first and renaming on success.

    The output folder must already exist.
    """
    out_path = Path(out_path)
    tmp = out_path.with_name(out_path.stem + ".tmp.m4a")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
        "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart",
        str(tmp),
    ]
    try:
        subprocess.run(cmd, input=audio.astype(np.float32).tobytes(), check=True, capture_output=True)
        os.replace(tmp, out_path)
    except subprocess.CalledProcessError as e:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg failed: {e.stderr.decode(errors='replace')}") from e


def generate_part(
    text: str,
    out_path: Path,
    voice: str = DEFAULT_VOICE,
    should_stop: Callable[[], bool] | None = None,
) -> float:
    """Generate one part to `out_path`; return its duration in seconds."""
    audio = synthesize(text, voice=voice, should_stop=should_stop)
    if len(audio) == 0:
        raise RuntimeError("TTS produced no audio for this part")
    encode_m4a(audio, out_path)
    return len(audio) / SAMPLE_RATE


def probe_duration(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, text=True,
        )
        return float(out.stdout.strip())
    except (subprocess.CalledProcessError, ValueError):
        return None
