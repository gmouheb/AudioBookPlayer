"""One background thread that generates missing parts, priority position first.

Order: the most recently active book first, starting at its priority position
([chapter, part] from /play) and running to the end, then wrapping to the start;
then the other books. When the priority changes, the part in progress is
cancelled (checked between Kokoro segments) so the tapped chapter starts soon.
"""

import logging
import threading
import time

from . import tts
from .store import ERROR, GENERATING, QUEUED, READY, Store

log = logging.getLogger("narrate.worker")


class Worker(threading.Thread):
    def __init__(self, store: Store):
        super().__init__(name="narrate-worker", daemon=True)
        self.store = store
        self.wake = threading.Event()
        self.cancel = threading.Event()
        self.idle = threading.Condition(store.lock)
        self.current: tuple[str, int, int] | None = None
        self.model_ready = False
        self._stopping = False

    # -- called from API threads

    def notify(self) -> None:
        self.wake.set()

    def reprioritize(self) -> None:
        """Cancel the part in progress if it's no longer the next job."""
        with self.store.lock:
            if self.current and self.current != self._next_job():
                self.cancel.set()
        self.wake.set()

    def drop_book(self, book_id: str, timeout: float = 60) -> None:
        """Cancel and wait until the worker is no longer working on `book_id`."""
        with self.idle:
            if self.current and self.current[0] == book_id:
                self.cancel.set()
                self.idle.wait_for(
                    lambda: not (self.current and self.current[0] == book_id), timeout
                )

    def stop(self) -> None:
        self._stopping = True
        self.cancel.set()
        self.wake.set()

    # -- startup recovery

    def recover(self) -> None:
        """Make statuses match the files on disk after a restart."""
        with self.store.lock:
            for book_id, book in self.store.books.items():
                for tmp in (self.store.book_dir(book_id) / "audio").glob("*.tmp.m4a"):
                    tmp.unlink(missing_ok=True)
                for c, ch in enumerate(book["chapters"]):
                    for p, part in enumerate(ch["parts"]):
                        path = self.store.audio_path(book_id, c, p)
                        if path.exists():
                            if part["status"] != READY or not part["duration"]:
                                part["status"] = READY
                                part["duration"] = tts.probe_duration(path)
                        elif part["status"] in (GENERATING, READY):
                            part["status"] = QUEUED
                self.store.save(book)

    # -- scheduling

    def _next_job(self) -> tuple[str, int, int] | None:
        books = sorted(self.store.books.values(), key=lambda b: -b["last_active"])
        for book in books:
            positions = [(c, p) for c, ch in enumerate(book["chapters"]) for p in range(len(ch["parts"]))]
            if book["priority"]:
                start = next((i for i, pos in enumerate(positions) if list(pos) >= book["priority"]), 0)
                positions = positions[start:] + positions[:start]
            for c, p in positions:
                if book["chapters"][c]["parts"][p]["status"] in (QUEUED, GENERATING):
                    return (book["id"], c, p)
        return None

    def run(self) -> None:
        t = time.perf_counter()
        tts.load()
        self.model_ready = True
        log.info("Kokoro loaded in %.1fs", time.perf_counter() - t)

        while not self._stopping:
            with self.store.lock:
                job = self._next_job()
                if job:
                    book_id, c, p = job
                    book = self.store.books[book_id]
                    part = book["chapters"][c]["parts"][p]
                    part["status"], part["error"] = GENERATING, None
                    self.store.save(book)
                    text, voice = part["text"], book["voice"]
                    self.current = job
                    self.cancel.clear()
            if not job:
                self.wake.wait()
                self.wake.clear()
                continue

            log.info("Generating %s c%d p%d (%d chars)", book_id, c, p, len(text))
            status, duration, error = QUEUED, None, None
            t = time.perf_counter()
            try:
                duration = tts.generate_part(
                    text, self.store.audio_path(book_id, c, p), voice, should_stop=self.cancel.is_set
                )
                status = READY
                log.info("Done %s c%d p%d: %.0fs audio in %.1fs", book_id, c, p, duration, time.perf_counter() - t)
            except tts.Cancelled:
                log.info("Cancelled %s c%d p%d", book_id, c, p)
            except Exception as e:  # noqa: BLE001 - one bad part must not kill the worker
                log.exception("Failed %s c%d p%d", book_id, c, p)
                status, error = ERROR, str(e)[:500]

            with self.idle:
                book = self.store.books.get(book_id)
                if book:
                    part = book["chapters"][c]["parts"][p]
                    part["status"], part["duration"], part["error"] = status, duration, error
                    self.store.save(book)
                self.current = None
                self.idle.notify_all()
