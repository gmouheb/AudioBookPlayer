"""Print what extraction produces for one or more books.

Usage: uv run python scripts/extract_cli.py BOOK [BOOK ...] [--full N]
"""

import argparse
import textwrap

from narrate.extract import ExtractError, extract
from narrate.text import split_parts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("books", nargs="+")
    ap.add_argument("--preview", type=int, default=300, help="chars of each chapter to show")
    args = ap.parse_args()

    for path in args.books:
        print("=" * 78)
        print(path)
        try:
            book = extract(path)
        except ExtractError as e:
            print(f"  ERROR: {e}")
            continue
        total = sum(len(c.text) for c in book.chapters)
        print(f"  Title:  {book.title}")
        print(f"  Author: {book.author or '-'}")
        print(f"  {len(book.chapters)} chapters, {total:,} chars (~{total / 900:.0f} min audio)")
        for i, ch in enumerate(book.chapters, 1):
            parts = split_parts(ch.text)
            sizes = ", ".join(str(len(p)) for p in parts[:6]) + (" ..." if len(parts) > 6 else "")
            print(f"\n  [{i}] {ch.title}  ({len(ch.text):,} chars, {len(parts)} parts: {sizes})")
            preview = ch.text[: args.preview].replace("\n", " ")
            print(textwrap.indent(textwrap.fill(preview, 74), "      "))


if __name__ == "__main__":
    main()
