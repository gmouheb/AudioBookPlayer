import { Component, computed, inject, signal } from '@angular/core';
import { IonButton, IonIcon, IonRange, IonSpinner } from '@ionic/angular';
import type { RangeCustomEvent } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { pause, play, playSkipBack, playSkipForward } from 'ionicons/icons';

import { PlayerService } from '../core/player.service';

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

@Component({
  selector: 'app-player-bar',
  imports: [IonButton, IonIcon, IonRange, IonSpinner],
  template: `
    @if (player.book(); as book) {
      <div class="bar">
        <div class="title">
          <strong>{{ player.chapterInfo()?.title }}</strong>
          <span class="sub"> {{ book.title }} · part {{ player.part() + 1 }}/{{ player.partCount() }} </span>
        </div>

        @if (player.error(); as err) {
          <div class="status error">{{ err }}</div>
        } @else if (player.waiting()) {
          <div class="status">
            <ion-spinner name="dots"></ion-spinner> Generating audio… playback starts when it's ready
          </div>
        }

        <ion-range
          aria-label="Position"
          [min]="0"
          [max]="max()"
          [step]="1"
          [value]="rangeValue()"
          [disabled]="!max()"
          (ionKnobMoveStart)="dragging = true"
          (ionInput)="onInput($event)"
          (ionKnobMoveEnd)="dragging = false"
          (ionChange)="onSeek($event)"
        ></ion-range>
        <div class="times">
          <span>{{ format(rangeValue()) }}</span>
          <span>-{{ format(max() - rangeValue()) }}</span>
        </div>

        <div class="controls">
          <ion-button fill="clear" aria-label="Previous chapter" (click)="player.previousChapter()">
            <ion-icon slot="icon-only" name="play-skip-back"></ion-icon>
          </ion-button>
          <ion-button fill="clear" aria-label="Back 15 seconds" (click)="player.skip(-15)">−15</ion-button>
          <ion-button shape="round" size="large" aria-label="Play or pause" (click)="player.toggle()">
            @if (player.buffering() && player.playing()) {
              <ion-spinner slot="icon-only" name="crescent"></ion-spinner>
            } @else {
              <ion-icon slot="icon-only" [name]="player.active() ? 'pause' : 'play'"></ion-icon>
            }
          </ion-button>
          <ion-button fill="clear" aria-label="Forward 30 seconds" (click)="player.skip(30)">+30</ion-button>
          <ion-button fill="clear" aria-label="Next chapter" (click)="player.nextChapter()">
            <ion-icon slot="icon-only" name="play-skip-forward"></ion-icon>
          </ion-button>
        </div>
        <div class="rate">
          <ion-button size="small" fill="outline" aria-label="Playback speed" (click)="player.cycleRate()">
            {{ player.rate() }}×
          </ion-button>
        </div>
      </div>
    }
  `,
  styles: `
    .bar {
      padding: 8px 16px calc(8px + var(--ion-safe-area-bottom, 0px));
    }
    .title {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .title strong,
    .title .sub {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub {
      font-size: 0.85em;
      color: var(--ion-color-medium);
    }
    .status {
      font-size: 0.85em;
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--ion-color-warning-shade);
    }
    .status.error {
      color: var(--ion-color-danger);
    }
    ion-range {
      padding: 0;
      --knob-size: 18px;
    }
    .times {
      display: flex;
      justify-content: space-between;
      font-size: 0.8em;
      color: var(--ion-color-medium);
      margin-top: -8px;
    }
    .controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .rate {
      display: flex;
      justify-content: center;
    }
  `,
})
export class PlayerBarComponent {
  protected readonly player = inject(PlayerService);
  protected readonly format = formatTime;
  /** Value shown while the user drags the knob. */
  protected readonly dragValue = signal<number | null>(null);
  /**
   * ion-range also emits ionInput when its value changes programmatically,
   * so only follow ionInput while the knob is actually being dragged.
   */
  protected dragging = false;

  protected readonly max = computed(() => Math.floor(this.player.duration()));
  protected readonly rangeValue = computed(() => Math.min(this.dragValue() ?? this.player.currentTime(), this.max()));

  constructor() {
    addIcons({ play, pause, playSkipBack, playSkipForward });
  }

  protected onInput(event: Event): void {
    if (this.dragging) {
      this.dragValue.set(Number((event as RangeCustomEvent).detail.value));
    }
  }

  protected onSeek(event: Event): void {
    const value = Number((event as RangeCustomEvent).detail.value);
    this.dragValue.set(null);
    this.player.seek(value);
  }
}
