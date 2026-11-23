"""FastAPI app: upload books, report generation status, serve audio."""

import logging
import os
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import tts
from .extract import ExtractError, extract
from .store import ERROR, QUEUED, READY, Store, book_detail, book_summary
from .worker import Worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(os.environ.get("NARRATE_DATA", "data"))
MAX_UPLOAD_BYTES = 300 * 1024 * 1024

store: Store
worker: Worker


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store, worker
    store = Store(DATA_DIR)
    worker = Worker(store)
    worker.recover()
    worker.start()
    yield
    worker.stop()


app = FastAPI(title="Narrate", lifespan=lifespan)
# Only reachable over the tailnet; the app runs from https://localhost (Capacitor)
# or http://localhost:8100 (ionic serve).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _get_book(book_id: str) -> dict:
    book = store.books.get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    return book


@app.get("/health")
def health():
    return {"status": "ok", "model_ready": worker.model_ready}


@app.post("/books", status_code=201)
def upload_book(file: UploadFile):
    # Sync endpoint: FastAPI runs it in a threadpool, so extraction doesn't block the loop.
    fd, tmp_name = tempfile.mkstemp(dir=store.tmp_dir)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out:
            size = 0
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "File is too large (max 300 MB).")
                out.write(chunk)
        try:
            extracted = extract(tmp)
        except ExtractError as e:
            raise HTTPException(422, str(e)) from e
        except Exception as e:  # noqa: BLE001 - malformed files of all kinds
            logging.exception("Extraction failed for %s", file.filename)
            raise HTTPException(422, "This file couldn't be read. Upload a DRM-free EPUB or a text-based PDF.") from e

        with open(tmp, "rb") as f:
            ext = ".pdf" if f.read(4) == b"%PDF" else ".epub"
        if extracted.title == tmp.stem and file.filename:
            extracted.title = Path(file.filename).stem  # no metadata title: use the upload's name
        book = store.create(tmp, ext, extracted, tts.DEFAULT_VOICE)
    finally:
        tmp.unlink(missing_ok=True)
    worker.notify()
    with store.lock:
        return book_detail(book)


@app.get("/books")
def list_books():
    with store.lock:
        books = sorted(store.books.values(), key=lambda b: -b["created"])
        return [book_summary(b) for b in books]


@app.get("/books/{book_id}")
def get_book(book_id: str):
    with store.lock:
        return book_detail(_get_book(book_id))


class PlayRequest(BaseModel):
    chapter: int
    part: int = 0


@app.post("/books/{book_id}/play", status_code=204)
def play(book_id: str, req: PlayRequest):
    with store.lock:
        book = _get_book(book_id)
        chapters = book["chapters"]
        if not (0 <= req.chapter < len(chapters) and 0 <= req.part < len(chapters[req.chapter]["parts"])):
            raise HTTPException(400, "Chapter or part out of range")
        book["priority"] = [req.chapter, req.part]
        book["last_active"] = time.time()
        part = chapters[req.chapter]["parts"][req.part]
        if part["status"] == ERROR:  # tapping a failed part retries it
            part["status"], part["error"] = QUEUED, None
        store.save(book)
    worker.reprioritize()
    return Response(status_code=204)


@app.get("/books/{book_id}/audio/{chapter}/{part}")
def audio(book_id: str, chapter: int, part: int):
    with store.lock:
        book = _get_book(book_id)
        try:
            status = book["chapters"][chapter]["parts"][part]["status"]
        except IndexError:
            raise HTTPException(404, "No such part") from None
        path = store.audio_path(book_id, chapter, part)
    if status != READY or not path.exists():
        raise HTTPException(404, "Audio not ready yet")
    # FileResponse handles HTTP Range requests (needed for seeking).
    return FileResponse(path, media_type="audio/mp4")


@app.delete("/books/{book_id}", status_code=204)
def delete_book(book_id: str):
    with store.lock:
        _get_book(book_id)
        store.books.pop(book_id)
    worker.drop_book(book_id)
    shutil.rmtree(store.book_dir(book_id), ignore_errors=True)
    return Response(status_code=204)


def run() -> None:
    import uvicorn

    # One process only: the worker thread lives inside it.
    uvicorn.run(app, host=os.environ.get("NARRATE_HOST", "127.0.0.1"), port=int(os.environ.get("NARRATE_PORT", "8000")))
