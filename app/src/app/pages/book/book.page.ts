import { Component, inject, input, signal } from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircle, checkmarkCircle, timeOutline, volumeHigh } from 'ionicons/icons';

import { PlayerBarComponent } from '../../components/player-bar.component';
import { ApiService, errorMessage } from '../../core/api.service';
import type { BookDetail, ChapterInfo } from '../../core/models';
import { PlayerService } from '../../core/player.service';

const POLL_MS = 3000;

@Component({
  selector: 'app-book',
  templateUrl: 'book.page.html',
  styles: `
    .now-playing {
      --background: var(--ion-color-primary-tint);
    }
    .now-playing ion-label h2 {
      font-weight: 600;
    }
    ion-note {
      font-size: 0.8em;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    ion-spinner {
      width: 16px;
      height: 16px;
    }
    ion-footer {
      background: var(--ion-background-color, #fff);
    }
  `,
  imports: [
    PlayerBarComponent,
    IonBackButton,
    IonButtons,
    IonContent,
    IonFooter,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class BookPage {
  /** Route parameter (withComponentInputBinding). */
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);
  protected readonly player = inject(PlayerService);

  protected readonly book = signal<BookDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    addIcons({ alertCircle, checkmarkCircle, timeOutline, volumeHigh });
  }

  ionViewWillEnter(): void {
    void this.refresh(true);
    this.timer = setInterval(() => void this.refresh(false), POLL_MS);
  }

  ionViewWillLeave(): void {
    clearInterval(this.timer);
  }

  private async refresh(first: boolean): Promise<void> {
    try {
      const book = await this.api.getBook(this.id());
      this.book.set(book);
      this.error.set(null);
      if (this.player.book()?.id === book.id) {
        this.player.updateBook(book);
      } else if (first && !this.player.active()) {
        // Nothing else is playing: load this book at its saved position.
        this.player.open(book);
      }
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  protected isCurrent(chapter: ChapterInfo): boolean {
    return this.player.book()?.id === this.book()?.id && this.player.chapter() === chapter.index;
  }

  protected readyParts(chapter: ChapterInfo): number {
    return chapter.parts.filter((p) => p.status === 'ready').length;
  }

  protected minutes(chapter: ChapterInfo): string {
    // ~15 characters per second of audio for parts not generated yet.
    const seconds = chapter.parts.reduce((sum, p) => sum + (p.duration ?? p.chars / 15), 0);
    return `${Math.max(1, Math.round(seconds / 60))} min`;
  }

  protected play(chapter: ChapterInfo): void {
    const book = this.book();
    if (book) {
      this.player.playChapter(book, chapter.index);
    }
  }
}
