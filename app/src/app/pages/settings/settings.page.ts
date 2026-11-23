import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { alertCircle, checkmarkCircle } from 'ionicons/icons';

import { ApiService, errorMessage } from '../../core/api.service';
import { SettingsService, normalizeUrl } from '../../core/settings.service';

type TestState =
  { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; modelReady: boolean } | { kind: 'failed'; message: string };

@Component({
  selector: 'app-settings',
  templateUrl: 'settings.page.html',
  styles: `
    .result {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px;
    }
    .result ion-icon {
      font-size: 24px;
      flex: none;
    }
    .actions {
      display: flex;
      gap: 8px;
      padding: 0 16px;
    }
    .actions ion-button {
      flex: 1;
    }
  `,
  imports: [
    FormsModule,
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class SettingsPage {
  private readonly api = inject(ApiService);
  private readonly settings = inject(SettingsService);

  protected url = this.settings.serverUrl();
  protected readonly test = signal<TestState>({ kind: 'idle' });
  protected readonly saved = signal(false);

  constructor() {
    addIcons({ alertCircle, checkmarkCircle });
  }

  protected save(): void {
    this.settings.setServerUrl(this.url);
    this.url = this.settings.serverUrl();
    this.saved.set(true);
  }

  /** Saves the URL, then checks /health. */
  protected async testConnection(): Promise<void> {
    if (!normalizeUrl(this.url)) {
      this.test.set({ kind: 'failed', message: 'Enter the server URL first.' });
      return;
    }
    this.save();
    this.test.set({ kind: 'testing' });
    try {
      const health = await this.api.health();
      this.test.set({ kind: 'ok', modelReady: health.model_ready });
    } catch (e) {
      this.test.set({ kind: 'failed', message: errorMessage(e) });
    }
  }

  protected edited(): void {
    this.saved.set(false);
    this.test.set({ kind: 'idle' });
  }
}
