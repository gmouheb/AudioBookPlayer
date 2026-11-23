"""Text cleanup, sentence splitting, and splitting chapters into TTS-sized parts."""

import re

FIRST_PART_CHARS = 1000  # short first part so playback starts quickly
PART_CHARS = 4500  # ~5 min of audio

_HYPHEN_BREAK = re.compile(r"(\w)-\n\s*([a-z])")
_SENTENCE_END = re.compile(r"(?<=[.!?…])[\"'”’)\]]*\s+(?=[\"'“‘(\[]?[A-Z0-9])")


def clean(text: str) -> str:
    """Normalize whitespace; join hyphenated line breaks; keep paragraph breaks."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("­", "").replace("﻿", "").replace(" ", " ")
    text = _HYPHEN_BREAK.sub(r"\1\2", text)
    paragraphs = re.split(r"\n\s*\n", text)
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in paragraphs]
    return "\n\n".join(p for p in paragraphs if p)


def split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    for para in text.split("\n\n"):
        sentences.extend(s.strip() for s in _SENTENCE_END.split(para) if s.strip())
    return sentences


def _split_long(sentence: str, limit: int) -> list[str]:
    """Split a sentence longer than `limit` at commas/semicolons, then at spaces."""
    pieces, current = [], ""
    for chunk in re.split(r"(?<=[,;:])\s+|\s+", sentence):
        if current and len(current) + 1 + len(chunk) > limit:
            pieces.append(current)
            current = chunk
        else:
            current = f"{current} {chunk}" if current else chunk
    if current:
        pieces.append(current)
    return pieces


def split_parts(
    text: str, first: int = FIRST_PART_CHARS, size: int = PART_CHARS
) -> list[str]:
    """Split chapter text into parts at sentence boundaries.

    The first part targets `first` chars, the rest target `size` chars.
    """
    parts: list[str] = []
    current: list[str] = []
    length = 0
    for sentence in split_sentences(text):
        for piece in _split_long(sentence, size) if len(sentence) > size else [sentence]:
            limit = first if not parts else size
            if current and length + len(piece) > limit:
                parts.append(" ".join(current))
                current, length = [], 0
            current.append(piece)
            length += len(piece) + 1
    if current:
        parts.append(" ".join(current))
    return parts
