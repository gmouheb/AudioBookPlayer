# Narrate — Personal Audiobook App (v0 Plan)

Upload a PDF or EPUB from your phone and listen to it as an audiobook.
Scope: **personal use only**. One Python service, one Ionic app, files on disk.
No accounts, no database server, no job queue.

Target phone: **Android** (APK installed directly on the phone). iOS notes are in §7.

---

## 1. Architecture

```
Phone (Ionic + Angular + Capacitor, installed as an APK)
   │  HTTPS over Tailscale (or home Wi-Fi)
   ▼
FastAPI (one Podman container on your PC / home server)
   ├─ Upload → extract text → split into chapters → split chapters into ~5-min parts
   ├─ Background thread: Kokoro TTS → ffmpeg → .m4a per part
   └─ data/ folder (book files, JSON metadata, audio)
```

## 2. How it works

1. **Upload** – the server extracts text, splits it into chapters, then splits each chapter into
   parts of ~4–5k characters (~5 min of audio). The first part of each chapter is short (~1k chars)
   so playback starts quickly.
2. **Generate** – one background thread generates parts in order. Tapping a chapter moves it to
   the front of the queue.
3. **Play** – the app polls the book's status every few seconds and plays parts back to back as
   they become ready.
4. **Resume** – the playback position is saved on the phone.

---

## 3. Backend

### Stack

| Item | Choice |
|---|---|
| API | FastAPI + Uvicorn + `python-multipart` |
| EPUB | `zipfile` + `lxml` |
| PDF | `pypdfium2` (text-based PDFs only) |
| Text-to-speech | `kokoro` (Kokoro-82M) + `espeak-ng` |
| Encoding | `ffmpeg` → AAC `.m4a` |
| Background jobs | One `threading.Thread` inside the API process |
| Storage | Plain files under `data/` |
| Containers | Podman (`Containerfile` + `compose.yaml`, run with `podman compose`) |

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Connection check used by the app's Settings screen |
| `POST` | `/books` | Upload a PDF/EPUB; returns the book with its chapters |
| `GET` | `/books` | Library list |
| `GET` | `/books/{id}` | Chapters and the status of each part |
| `POST` | `/books/{id}/play` | Body `{chapter, part}`: generate from here next |
| `GET` | `/books/{id}/audio/{c}/{p}` | The `.m4a` file. Must support HTTP Range requests |
| `DELETE` | `/books/{id}` | Remove a book and its audio |

Part status values: `queued` · `generating` · `ready` · `error`.

### Data layout

```
data/books/{id}/
├── source.pdf | source.epub
├── book.json            # title, author, voice, chapters[] → parts[] (text, status, duration)
└── audio/
    └── c003_p02.m4a     # chapter 3, part 2
```

### Modules

| File | Responsibility |
|---|---|
| `main.py` | FastAPI app, routes, CORS |
| `extract.py` | EPUB (spine order + TOC titles) and PDF (outline-based chapters, header/footer removal) → chapters |
| `text.py` | Text cleanup, sentence splitting, splitting chapters into parts |
| `tts.py` | Load Kokoro once; text → audio → ffmpeg → `.m4a` (write to a temp file, then rename) |
| `worker.py` | Background thread: pick the next missing part (priority position first), generate it, update status; resume missing parts after a restart |
| `store.py` | Read/write `book.json`, file paths |

---

## 4. Mobile app

| Item | Choice |
|---|---|
| Framework | Angular (standalone components, signals) + Ionic + Capacitor |
| Screens | **Library** (book list + upload button) · **Book** (chapter list + player) · **Settings** (server URL + connection test) |
| Services | `ApiService` (HTTP calls) · `PlayerService` (track queue, playback, position) · `SettingsService` (server URL) |
| Upload | Plain `<input type="file" accept=".pdf,.epub">` — no plugin needed |
| Playback | HTML `<audio>`: play/pause, ±15/30 s, next/previous, speed |
| Saved position | `localStorage` (per book: chapter, part, time) |
| Lock-screen info | Browser Media Session API |
| App identity | Name **Narrate**, app ID `com.personal.narrate`, own launcher icon |

The server URL is entered in Settings (not hard-coded), so the same APK keeps working if the
server address changes.

---

## 5. Connecting the phone to the server

Use **Tailscale** (free for personal use) with `tailscale serve` to get HTTPS. This avoids:

- **Android:** the app is served from `https://localhost`, so calls to a plain `http://` API are blocked.
- **iOS:** plain HTTP is blocked by default.

No login is needed because only your own devices can reach the server.
**Do not expose the server to the public internet.**

---

## 6. Build order

1. **Extraction** – a small command-line script; check the output on 3–4 real books.
2. **TTS** – generate one part to `.m4a` with Kokoro; time how long it takes.
3. **API + worker** – wrap steps 1–2 in FastAPI and the background thread; run with `podman compose up`.
4. **App in the browser** – build the Ionic app and test it with `ionic serve`.
5. **Installable app** – add Settings, icon and app ID; build the APK (§7); install it on the phone.
6. **Screen-lock check** – if audio stops when the screen locks, switch playback to `@capgo/native-audio`.
7. **Acceptance** – run through every criterion in §8 on the phone.

---

## 7. Packaging and installation

### Android (target)

1. Build the web app and copy it into the Android project:
   `ionic build` → `npx cap sync android`
2. Build the APK, either:
   - **Android Studio:** open `android/` → *Build → Build App Bundle(s) / APK(s) → Build APK(s)*, or
   - **Command line:** `cd android && ./gradlew assembleDebug`
     → `android/app/build/outputs/apk/debug/app-debug.apk`
   - **No Android Studio:** a GitHub Actions workflow runs the same Gradle command and uploads the
     APK as a downloadable artifact.
3. Copy the APK to the phone (USB, Google Drive, or download from the Actions artifact).
4. On the phone, allow *Install unknown apps* for the app you open the APK with, then install.
5. Open **Narrate → Settings**, enter the server's Tailscale HTTPS URL, tap **Test connection**.

A debug APK is fine for personal use. A signed release APK is only needed to share it or to
update without uninstalling across build machines.

### iOS (if needed later)

- Requires a Mac with Xcode: `npx cap sync ios` → open in Xcode → run on the connected iPhone.
- With a free Apple ID, the installed app stops launching after **7 days** and must be reinstalled.
- With a paid Apple Developer account, use TestFlight or longer-lived provisioning.

---

## 8. Acceptance criteria

v0 is done when **every** criterion passes on the phone.

| # | Criterion | How to verify |
|---|---|---|
| AC1 | **The app is ready to install on my phone.** A built APK installs on the Android phone, appears in the launcher as *Narrate* with its icon, and opens to the Library screen without errors. | Install the APK from §7 on the phone; launch it from the home screen. |
| AC2 | The server starts with one command and is reachable from the phone. | `podman compose up` on the PC; Settings → **Test connection** shows *Connected*. |
| AC3 | The server URL is saved. | Set the URL, force-close the app, reopen: URL is still set and the Library loads. |
| AC4 | A DRM-free EPUB uploads from the phone and shows the correct title, author and chapters in reading order. | Upload an EPUB from phone storage; compare the chapter list with the book's table of contents. |
| AC5 | A text-based PDF uploads and is split into chapters (from its outline, or page ranges if it has none). Page numbers and running headers/footers are not read aloud. | Upload a PDF; listen to the first two minutes of a chapter. |
| AC6 | Unsupported input fails cleanly: scanned PDF, DRM EPUB, other file types. The app shows a clear error message and does not crash. | Try one file of each kind. |
| AC7 | Audio starts within **60 s** of tapping a chapter that hasn't been generated yet (target; confirm after timing step 2 on your hardware). | Tap an ungenerated chapter; time until sound. |
| AC8 | Playback is continuous: parts and chapters play back to back with no manual action, as long as generation keeps ahead. | Listen across at least one part boundary and one chapter boundary. |
| AC9 | Player controls work: play/pause, back 15 s, forward 30 s, previous/next chapter, seek bar, speed 0.75×–2×. | Use each control once. |
| AC10 | Position is resumed: after closing and reopening the app, playback continues at the same chapter and part, within ±5 s. | Stop mid-part, force-close, reopen, press play. |
| AC11 | Generation status is visible and updates on its own: each chapter shows queued / generating / ready / error. | Watch the chapter list after an upload without pulling to refresh. |
| AC12 | Tapping a later chapter makes it generate next. | Upload a book, immediately tap chapter 5; it becomes *generating* before chapters 2–4 finish. |
| AC13 | Restart safety: after `podman compose restart`, unfinished parts resume and finished audio is not regenerated. | Restart mid-generation; check that existing `.m4a` files keep their timestamps. |
| AC14 | Audio keeps playing with the screen locked for at least 10 minutes. | Start playback, lock the phone, check after 10 min. If this fails, do build step 6. |
| AC15 | Deleting a book removes it from the Library and its folder from `data/books/`. | Delete a book; check the Library and the server folder. |
| AC16 | The server is not reachable from the public internet. | From a device outside the tailnet (mobile data, Tailscale off), the URL does not respond. |

---

## 9. Tools to install

- Node LTS, Angular CLI, Ionic CLI
- Android Studio (or JDK + Android SDK command-line tools) for building the APK
- Python 3.12+, `uv`
- Podman (Podman Desktop on macOS/Windows), `docker-compose` or `podman-compose`
- `ffmpeg`, `espeak-ng`
- Tailscale (on the server and the phone)
- iOS only: a Mac with Xcode

---

## 10. Left out for now

Accounts, MongoDB, Celery/Redis, cloud storage (R2/S3), HLS streaming, offline downloads,
OCR, push notifications, GPU, Play Store / App Store publishing. Add any of them only if you
need it later.

## 11. Known limits

- The PC/server must be on while you listen (audio streams from it).
- Scanned PDFs (no text layer) and DRM-protected books won't work.
- Voices are English only.
- Kokoro's speed on your CPU is untested — measure it in step 2. If generation is slower than
  playback, you'll wait between parts and AC7/AC8 may need relaxed targets.
