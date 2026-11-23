"""Time Kokoro on a short (first) part and a full-size part of a real book.

Usage: uv run python scripts/tts_bench.py BOOK [--chapter N] [--out DIR]
Real-time factor (RTF) = generation time / audio duration. RTF < 1 means
generation keeps ahead of playback.
"""

import argparse
import time
from pathlib import Path

from narrate import tts
from narrate.extract import extract
from narrate.text import split_parts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("book")
    ap.add_argument("--chapter", type=int, default=None, help="1-based; default: first long chapter")
    ap.add_argument("--out", default="bench_out")
    args = ap.parse_args()

    book = extract(args.book)
    if args.chapter:
        chapter = book.chapters[args.chapter - 1]
    else:
        chapter = next((c for c in book.chapters if len(split_parts(c.text)) >= 2), book.chapters[0])
    parts = split_parts(chapter.text)
    print(f"Chapter: {chapter.title} ({len(parts)} parts)")

    t = time.perf_counter()
    tts._get_pipeline()
    print(f"Model load: {time.perf_counter() - t:.1f}s")

    out = Path(args.out)
    for i, text in enumerate(parts[:2], 1):
        path = out / f"part{i}.m4a"
        t = time.perf_counter()
        duration = tts.generate_part(text, path)
        took = time.perf_counter() - t
        print(
            f"Part {i}: {len(text):,} chars -> {duration:.0f}s audio in {took:.1f}s "
            f"(RTF {took / duration:.2f}) -> {path}"
        )


if __name__ == "__main__":
    main()
