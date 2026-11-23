import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { TimeoutError, firstValueFrom, timeout } from 'rxjs';

import type { BookDetail, BookSummary, Health } from './models';
import { SettingsService } from './settings.service';

const REQUEST_TIMEOUT_MS = 10_000;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly settings = inject(SettingsService);

  private url(path: string, base = this.settings.serverUrl()): string {
    if (!base) {
      throw new Error('Set the server URL in Settings first.');
    }
    return base + path;
  }

  health(base?: string): Promise<Health> {
    return firstValueFrom(this.http.get<Health>(this.url('/health', base)).pipe(timeout(REQUEST_TIMEOUT_MS)));
  }

  listBooks(): Promise<BookSummary[]> {
    return firstValueFrom(this.http.get<BookSummary[]>(this.url('/books')).pipe(timeout(REQUEST_TIMEOUT_MS)));
  }

  getBook(id: string): Promise<BookDetail> {
    return firstValueFrom(this.http.get<BookDetail>(this.url(`/books/${id}`)).pipe(timeout(REQUEST_TIMEOUT_MS)));
  }

  /** No timeout: large files take a while to upload and extract. */
  upload(file: File): Promise<BookDetail> {
    const form = new FormData();
    form.append('file', file, file.name);
    return firstValueFrom(this.http.post<BookDetail>(this.url('/books'), form));
  }

  play(id: string, chapter: number, part: number): Promise<unknown> {
    return firstValueFrom(
      this.http.post(this.url(`/books/${id}/play`), { chapter, part }).pipe(timeout(REQUEST_TIMEOUT_MS)),
    );
  }

  deleteBook(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(this.url(`/books/${id}`)).pipe(timeout(60_000)));
  }

  audioUrl(id: string, chapter: number, part: number): string {
    return this.url(`/books/${id}/audio/${chapter}/${part}`);
  }
}

/** A message that can be shown to the user for any API error. */
export function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0) {
      return "Can't reach the server. Check the URL in Settings and that Tailscale is on.";
    }
    const detail = (e.error as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'string') {
      return detail;
    }
    return `Server error (${e.status}).`;
  }
  if (e instanceof TimeoutError) {
    return "The server didn't respond in time.";
  }
  if (e instanceof Error) {
    return e.message;
  }
  return 'Something went wrong.';
}
