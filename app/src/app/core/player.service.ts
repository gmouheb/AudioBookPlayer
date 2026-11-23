import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiService, errorMessage } from './api.service';
import type { BookDetail, SavedPosition } from './models';
import { loadJson, removeKey, saveJson } from './storage';

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = 'narrate.rate';
const POLL_MS = 3000;
const SAVE_EVERY_MS = 5000;
/** "Previous chapter" restarts the current chapter if we're further in than this. */
const RESTART_THRESHOLD_S = 5;

const positionKey = (bookId: string) => `narrate.pos.${bookId}`;

export function loadPosition(bookId: string): SavedPosition | null {
  return loadJson<SavedPosition>(positionKey(bookId));
}

export function forgetPosition(bookId: string): void {
  removeKey(positionKey(bookId));
}

/**
 * Plays a book's parts back to back with one <audio> element.
 *
 * A part that isn't generated yet puts the player in `waiting` state; the
 * book is polled and playback starts as soon as the part is ready.
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly api = inject(ApiService);
  private readonly audio = new Audio();

  readonly book = signal<BookDetail | null>(null);
  readonly chapter = signal(0);
  readonly part = signal(0);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  /** The audio element is playing (or trying to). */
  readonly playing = signal(false);
  /** The user pressed play but the current part isn't generated yet. */
  readonly waiting = signal(false);
  readonly buffering = signal(false);
  readonly error = signal<string | null>(null);
  readonly rate = signal(loadJson<number>(RATE_KEY) ?? 1);

  readonly chapterInfo = computed(() => this.book()?.chapters[this.chapter()] ?? null);
  readonly partCount = computed(() => this.chapterInfo()?.parts.length ?? 0);
  /** Playing, or waiting to play: the player "owns" its book. */
  readonly active = computed(() => this.playing() || this.waiting());

  /** `${bookId}/${chapter}/${part}` currently loaded into the audio element. */
  private loadedKey: string | null = null;
  /** Where to start once the awaited part becomes ready. */
  private pendingTime = 0;
  private lastSave = 0;
  private polling = false;

  constructor() {
    const a = this.audio;
    a.preload = 'auto';
    a.addEventListener('timeupdate', () => {
      this.currentTime.set(a.currentTime);
      if (Date.now() - this.lastSave > SAVE_EVERY_MS) {
        this.savePosition();
      }
      this.updatePositionState();
    });
    a.addEventListener('durationchange', () => {
      if (Number.isFinite(a.duration)) {
        this.duration.set(a.duration);
      }
    });
    a.addEventListener('play', () => this.playing.set(true));
    a.addEventListener('playing', () => this.buffering.set(false));
    a.addEventListener('waiting', () => this.buffering.set(true));
    a.addEventListener('pause', () => {
      if (!a.ended) {
        this.playing.set(false);
        this.savePosition();
      }
    });
    a.addEventListener('ended', () => this.advance());
    a.addEventListener('error', () => {
      if (this.loadedKey) {
        this.playing.set(false);
        this.buffering.set(false);
        this.loadedKey = null; // reload on the next play attempt
        this.error.set("Couldn't load the audio. Check the connection and press play to retry.");
      }
    });

    window.addEventListener('pagehide', () => this.savePosition());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.savePosition();
      }
    });

    this.setupMediaSession();
    setInterval(() => void this.poll(), POLL_MS);
  }

  // ------------------------------------------------------------ public API

  /** Show `book` in the player at its saved position, without starting playback. */
  open(book: BookDetail): void {
    if (this.book()?.id === book.id) {
      this.updateBook(book);
      return;
    }
    this.stop();
    this.book.set(book);
    const saved = loadPosition(book.id);
    const valid =
      saved && saved.chapter < book.chapters.length && saved.part < book.chapters[saved.chapter].parts.length;
    this.chapter.set(valid ? saved.chapter : 0);
    this.part.set(valid ? saved.part : 0);
    this.currentTime.set(valid ? saved.time : 0);
    this.pendingTime = valid ? saved.time : 0;
    this.duration.set(this.partDuration());
    void this.load(false, this.pendingTime);
  }

  /** Newer status for the current book (from polling or the book page). */
  updateBook(book: BookDetail): void {
    if (this.book()?.id !== book.id) {
      return;
    }
    this.book.set(book);
    if (this.waiting()) {
      const status = this.currentPart()?.status;
      if (status === 'ready') {
        void this.load(true, this.pendingTime);
      } else if (status === 'error') {
        this.waiting.set(false);
        this.error.set(this.currentPart()?.error ?? 'This part failed to generate.');
      }
    } else if (!this.loadedKey && this.currentPart()?.status === 'ready' && !this.error()) {
      // Opened before the part was ready: load it so play works instantly.
      void this.load(false, this.pendingTime);
    }
  }

  playChapter(book: BookDetail, chapter: number): void {
    if (this.book()?.id !== book.id) {
      this.stop();
      this.book.set(book);
    } else {
      this.book.set(book);
    }
    this.goTo(chapter, 0, 0, true);
  }

  toggle(): void {
    if (this.playing() || this.waiting()) {
      this.pause();
    } else {
      this.resume();
    }
  }

  pause(): void {
    this.waiting.set(false);
    this.audio.pause();
    this.savePosition();
  }

  resume(): void {
    const book = this.book();
    if (!book) {
      return;
    }
    this.error.set(null);
    void this.api.play(book.id, this.chapter(), this.part()).catch(() => undefined);
    if (this.loadedKey && this.currentPart()?.status === 'ready') {
      this.audio.play().catch((e: unknown) => this.onPlayError(e));
    } else {
      void this.load(true, this.currentTime());
    }
  }

  /** Jump `seconds` forward/backward, crossing part boundaries. */
  skip(seconds: number): void {
    const target = this.currentTime() + seconds;
    const duration = this.duration() || this.partDuration();
    if (target < 0 && this.part() > 0) {
      const prev = this.chapterInfo()?.parts[this.part() - 1];
      this.goTo(this.chapter(), this.part() - 1, Math.max(0, (prev?.duration ?? 0) + target), this.playing());
    } else if (duration && target >= duration) {
      this.advance();
    } else {
      this.seek(Math.max(0, target));
    }
  }

  seek(time: number): void {
    this.currentTime.set(time);
    this.pendingTime = time;
    if (this.loadedKey) {
      this.audio.currentTime = time;
    }
    this.savePosition();
  }

  nextChapter(): void {
    const book = this.book();
    if (book && this.chapter() + 1 < book.chapters.length) {
      this.goTo(this.chapter() + 1, 0, 0, this.active());
    }
  }

  previousChapter(): void {
    if (this.part() > 0 || this.currentTime() > RESTART_THRESHOLD_S || this.chapter() === 0) {
      this.goTo(this.chapter(), 0, 0, this.active());
    } else {
      this.goTo(this.chapter() - 1, 0, 0, this.active());
    }
  }

  setRate(rate: number): void {
    this.rate.set(rate);
    saveJson(RATE_KEY, rate);
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.updatePositionState();
  }

  cycleRate(): void {
    const i = RATES.indexOf(this.rate());
    this.setRate(RATES[(i + 1) % RATES.length]);
  }

  /** The book was deleted: stop and forget it. */
  close(bookId: string): void {
    forgetPosition(bookId);
    if (this.book()?.id === bookId) {
      this.stop();
      this.book.set(null);
    }
  }

  // ------------------------------------------------------------ internals

  private currentPart() {
    return this.chapterInfo()?.parts[this.part()] ?? null;
  }

  private partDuration(): number {
    return this.currentPart()?.duration ?? 0;
  }

  private stop(): void {
    this.savePosition();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.loadedKey = null;
    this.playing.set(false);
    this.waiting.set(false);
    this.buffering.set(false);
    this.error.set(null);
  }

  private goTo(chapter: number, part: number, time: number, autoplay: boolean): void {
    const book = this.book();
    if (!book) {
      return;
    }
    this.chapter.set(chapter);
    this.part.set(part);
    this.currentTime.set(time);
    this.duration.set(this.partDuration());
    this.error.set(null);
    this.savePosition();
    // Tell the server where we are so it generates from here next.
    void this.api.play(book.id, chapter, part).catch(() => undefined);
    void this.load(autoplay, time);
  }

  /** Next part, or first part of the next chapter. */
  private advance(): void {
    const book = this.book();
    if (!book) {
      return;
    }
    if (this.part() + 1 < this.partCount()) {
      this.goTo(this.chapter(), this.part() + 1, 0, true);
    } else if (this.chapter() + 1 < book.chapters.length) {
      this.goTo(this.chapter() + 1, 0, 0, true);
    } else {
      this.playing.set(false); // end of the book
      this.savePosition();
    }
  }

  private async load(autoplay: boolean, startTime: number): Promise<void> {
    const book = this.book();
    const part = this.currentPart();
    if (!book || !part) {
      return;
    }
    this.updateMediaMetadata();

    if (part.status !== 'ready') {
      if (this.loadedKey) {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
        this.loadedKey = null;
      }
      this.pendingTime = startTime;
      this.playing.set(false);
      if (part.status === 'error') {
        this.waiting.set(false);
        this.error.set(part.error ?? 'This part failed to generate.');
      } else {
        this.waiting.set(autoplay);
      }
      return;
    }

    this.waiting.set(false);
    const key = `${book.id}/${this.chapter()}/${this.part()}`;
    if (this.loadedKey !== key) {
      this.audio.src = this.api.audioUrl(book.id, this.chapter(), this.part());
      this.loadedKey = key;
      this.audio.defaultPlaybackRate = this.rate();
      this.audio.playbackRate = this.rate();
      this.duration.set(part.duration ?? 0);
    }
    this.audio.currentTime = startTime;
    this.currentTime.set(startTime);
    if (autoplay) {
      try {
        await this.audio.play();
      } catch (e) {
        this.onPlayError(e);
      }
    }
  }

  private onPlayError(e: unknown): void {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return; // interrupted by a newer load; harmless
    }
    this.playing.set(false);
    this.error.set(errorMessage(e));
  }

  /** Refresh the book while we need fresh statuses (waiting, or playing ahead). */
  private async poll(): Promise<void> {
    const book = this.book();
    if (!book || this.polling || !(this.waiting() || this.playing())) {
      return;
    }
    this.polling = true;
    try {
      this.updateBook(await this.api.getBook(book.id));
    } catch {
      /* transient; try again next tick */
    } finally {
      this.polling = false;
    }
  }

  private savePosition(): void {
    const book = this.book();
    if (!book) {
      return;
    }
    this.lastSave = Date.now();
    const pos: SavedPosition = {
      chapter: this.chapter(),
      part: this.part(),
      time: this.currentTime(),
      updated: this.lastSave,
    };
    saveJson(positionKey(book.id), pos);
  }

  // ------------------------------------------------------------ lock screen

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.resume()],
      ['pause', () => this.pause()],
      ['seekbackward', (d) => this.skip(-(d.seekOffset ?? 15))],
      ['seekforward', (d) => this.skip(d.seekOffset ?? 30)],
      ['previoustrack', () => this.previousChapter()],
      ['nexttrack', () => this.nextChapter()],
      ['seekto', (d) => d.seekTime != null && this.seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action not supported */
      }
    }
  }

  private updateMediaMetadata(): void {
    const book = this.book();
    if (!('mediaSession' in navigator) || !book || typeof MediaMetadata === 'undefined') {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.chapterInfo()?.title ?? book.title,
      artist: book.author,
      album: book.title,
      // TODO(step 5): switch to the real 512px launcher icon.
      artwork: [{ src: 'assets/icon/favicon.png', type: 'image/png' }],
    });
  }

  private updatePositionState(): void {
    const duration = this.audio.duration;
    if (!('mediaSession' in navigator) || !Number.isFinite(duration) || duration <= 0) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(this.audio.currentTime, duration),
        playbackRate: this.audio.playbackRate,
      });
    } catch {
      /* ignore */
    }
  }
}
