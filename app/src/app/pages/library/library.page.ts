import type { ElementRef } from '@angular/core';
import { Component, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonFab,
  IonFabButton,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonList,
  IonNote,
  IonProgressBar,
  IonRefresher,
  IonRefresherContent,
  IonText,
  IonTitle,
  IonToolbar,
  LoadingController,
  ToastController,
} from '@ionic/angular';
import type { RefresherCustomEvent } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { add, bookOutline, settingsOutline, trash } from 'ionicons/icons';

import { ApiService, errorMessage } from '../../core/api.service';
import type { BookSummary } from '../../core/models';
import { PlayerService, loadPosition } from '../../core/player.service';
import { SettingsService } from '../../core/settings.service';

const POLL_MS = 5000;

@Component({
  selector: 'app-library',
  templateUrl: 'library.page.html',
  styles: `
    .empty {
      text-align: center;
      padding: 48px 24px;
      color: var(--ion-color-medium);
    }
    .empty ion-icon {
      font-size: 64px;
    }
    ion-progress-bar {
      margin-top: 6px;
    }
  `,
  imports: [
    RouterLink,
    IonButton,
    IonButtons,
    IonContent,
    IonFab,
    IonFabButton,
    IonHeader,
    IonIcon,
    IonItem,
    IonItemOption,
    IonItemOptions,
    IonItemSliding,
    IonLabel,
    IonList,
    IonNote,
    IonProgressBar,
    IonRefresher,
    IonRefresherContent,
    IonText,
    IonTitle,
    IonToolbar,
  ],
})
export class LibraryPage {
  private readonly api = inject(ApiService);
  private readonly player = inject(PlayerService);
  private readonly alerts = inject(AlertController);
  private readonly loading = inject(LoadingController);
  private readonly toasts = inject(ToastController);
  protected readonly settings = inject(SettingsService);

  protected readonly books = signal<BookSummary[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    addIcons({ add, bookOutline, settingsOutline, trash });
  }

  ionViewWillEnter(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  ionViewWillLeave(): void {
    clearInterval(this.timer);
  }

  protected async refresh(event?: RefresherCustomEvent): Promise<void> {
    if (!this.settings.configured()) {
      this.loaded.set(true);
      await event?.target.complete();
      return;
    }
    try {
      this.books.set(await this.api.listBooks());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loaded.set(true);
      await event?.target.complete();
    }
  }

  protected progressLabel(book: BookSummary): string {
    const pos = loadPosition(book.id);
    const where = pos ? `Chapter ${pos.chapter + 1} · ` : '';
    const ready =
      book.parts_ready === book.parts_total ? 'all audio ready' : `${book.parts_ready}/${book.parts_total} parts ready`;
    return `${where}${book.chapter_count} chapters · ${ready}`;
  }

  protected pickFile(): void {
    this.fileInput().nativeElement.click();
  }

  protected async onFileChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    if (!file) {
      return;
    }
    const spinner = await this.loading.create({ message: `Uploading “${file.name}”…` });
    await spinner.present();
    try {
      const book = await this.api.upload(file);
      await this.refresh();
      await this.toast(`Added “${book.title}” (${book.chapter_count} chapters)`);
    } catch (e) {
      const alert = await this.alerts.create({
        header: "Couldn't add this book",
        message: errorMessage(e),
        buttons: ['OK'],
      });
      await alert.present();
    } finally {
      await spinner.dismiss();
    }
  }

  protected async confirmDelete(book: BookSummary, sliding: IonItemSliding): Promise<void> {
    await sliding.close();
    const alert = await this.alerts.create({
      header: 'Delete book?',
      message: `“${book.title}” and all its audio will be removed from the server.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => void this.delete(book) },
      ],
    });
    await alert.present();
  }

  private async delete(book: BookSummary): Promise<void> {
    try {
      await this.api.deleteBook(book.id);
      this.player.close(book.id);
      this.books.update((list) => list.filter((b) => b.id !== book.id));
      await this.toast(`Deleted “${book.title}”`);
    } catch (e) {
      await this.toast(errorMessage(e));
    }
  }

  private async toast(message: string): Promise<void> {
    const t = await this.toasts.create({ message, duration: 2500, position: 'bottom' });
    await t.present();
  }
}
