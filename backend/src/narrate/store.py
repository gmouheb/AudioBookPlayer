"""Books on disk: data/books/{id}/{source.*, book.json, audio/}.

All books are kept in memory and written back to book.json on every change.
Callers must hold `store.lock` while reading or mutating a book dict.
"""

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from .extract import Book
from .text import split_parts

QUEUED, GENERATING, READY, ERROR = "queued", "generating", "ready", "error"


class Store:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.books_dir = self.root / "books"
        self.tmp_dir = self.root / "tmp"
        self.books_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.books: dict[str, dict] = {}
        for path in self.books_dir.glob("*/book.json"):
            try:
                book = json.loads(path.read_text())
                self.books[book["id"]] = book
            except (OSError, ValueError, KeyError):
                pass  # half-created or corrupt book: ignore

    # -- paths

    def book_dir(self, book_id: str) -> Path:
        return self.books_dir / book_id

    def audio_path(self, book_id: str, chapter: int, part: int) -> Path:
        return self.book_dir(book_id) / "audio" / f"c{chapter:03d}_p{part:02d}.m4a"

    # -- persistence

    def save(self, book: dict) -> None:
        path = self.book_dir(book["id"]) / "book.json"
        if not path.parent.exists():
            return  # deleted meanwhile
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(book, ensure_ascii=False))
        os.replace(tmp, path)

    def create(self, source: Path, ext: str, extracted: Book, voice: str) -> dict:
        book_id = uuid.uuid4().hex[:12]
        book_dir = self.book_dir(book_id)
        (book_dir / "audio").mkdir(parents=True)
        shutil.move(source, book_dir / f"source{ext}")
        now = time.time()
        chapters = []
        for ch in extracted.chapters:
            parts = split_parts(ch.text)
            if parts:
                chapters.append({
                    "title": ch.title,
                    "parts": [
                        {"text": t, "chars": len(t), "status": QUEUED, "duration": None, "error": None}
                        for t in parts
                    ],
                })
        book = {
            "id": book_id,
            "title": extracted.title,
            "author": extracted.author,
            "voice": voice,
            "source": f"source{ext}",
            "created": now,
            "last_active": now,
            "priority": None,  # [chapter, part] to generate from next
            "chapters": chapters,
        }
        with self.lock:
            self.books[book_id] = book
            self.save(book)
        return book

    def delete(self, book_id: str) -> bool:
        with self.lock:
            existed = self.books.pop(book_id, None) is not None
        shutil.rmtree(self.book_dir(book_id), ignore_errors=True)
        return existed


# -- API views (call with store.lock held)


def chapter_status(chapter: dict) -> str:
    statuses = {p["status"] for p in chapter["parts"]}
    if GENERATING in statuses:
        return GENERATING
    if statuses == {READY}:
        return READY
    if ERROR in statuses and QUEUED not in statuses:
        return ERROR
    return QUEUED


def book_summary(book: dict) -> dict:
    parts = [p for ch in book["chapters"] for p in ch["parts"]]
    return {
        "id": book["id"],
        "title": book["title"],
        "author": book["author"],
        "created": book["created"],
        "chapter_count": len(book["chapters"]),
        "parts_total": len(parts),
        "parts_ready": sum(p["status"] == READY for p in parts),
    }


def book_detail(book: dict) -> dict:
    return {
        **book_summary(book),
        "voice": book["voice"],
        "chapters": [
            {
                "index": c,
                "title": ch["title"],
                "status": chapter_status(ch),
                "parts": [
                    {"index": p, "status": part["status"], "duration": part["duration"],
                     "chars": part["chars"], "error": part["error"]}
                    for p, part in enumerate(ch["parts"])
                ],
            }
            for c, ch in enumerate(book["chapters"])
        ],
    }
