import { Injectable, computed, signal } from '@angular/core';

import { loadJson, saveJson } from './storage';

const URL_KEY = 'narrate.serverUrl';

/** Trim, add https:// if no scheme was typed, drop trailing slashes. */
export function normalizeUrl(url: string): string {
  let u = url.trim();
  if (u && !/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  return u.replace(/\/+$/, '');
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly url = signal<string>(loadJson<string>(URL_KEY) ?? '');

  readonly serverUrl = this.url.asReadonly();
  readonly configured = computed(() => this.url() !== '');

  setServerUrl(url: string): void {
    const normalized = normalizeUrl(url);
    saveJson(URL_KEY, normalized);
    this.url.set(normalized);
  }
}
