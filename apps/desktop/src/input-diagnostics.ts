import { invoke } from '@tauri-apps/api/core';
import { InputMetrics } from './input-metrics.js';
import type { InputProfile } from './input-metrics.js';

interface Settings {native: boolean; mouseCoalescingEnabled: boolean}
export interface InputComparison {version: 1; createdAt: string; baseline: InputProfile; uncoalesced: InputProfile}
const node = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const number = (value: number | null, digits = 1): string => value === null ? '—' : value.toFixed(digits);
const milliseconds = (value: number | null): string => value !== null && value < 1 ? '<1' : number(value);

/** Explicit A/B capture; the previous app-local AppKit setting is restored. */
export class InputDiagnostics {
  private running = false;
  private cancelled = false;
  private timer: number | undefined;
  private wake: (() => void) | null = null;
  private comparison: InputComparison | null = null;
  constructor(
    readonly metrics: InputMetrics,
    private readonly finish: () => void,
    private readonly native: boolean,
    private readonly preference: (enabled: boolean) => void,
    private readonly error: (error: unknown) => void,
  ) {
    window.addEventListener('blur', () => this.metrics.focusChanged());
    node<HTMLButtonElement>('profile-start').disabled = !native;
    node<HTMLInputElement>('input-high-rate').disabled = !native;
    node('profile-start').addEventListener('click', () => {void this.compare();});
    node('profile-stop').addEventListener('click', () => this.cancel());
    node<HTMLInputElement>('input-high-rate').addEventListener('change', event => {
      const highRate = (event.target as HTMLInputElement).checked;
      void this.settings(!highRate).then(() => this.preference(highRate)).catch(error);
    });
  }
  private settings(enabled?: boolean): Promise<Settings> {return invoke('input_settings', {enabled: enabled ?? null});}
  async configure(highRate: boolean): Promise<void> {
    if (!this.native) return;
    const settings = await this.settings(!highRate);
    node<HTMLInputElement>('input-high-rate').checked = !settings.mouseCoalescingEnabled;
  }
  refresh(): void {
    const format = (name: string, profile: InputProfile): string =>
      `${name}: ${number(profile.eventHz)} Ereignisse/s (Median ${number(profile.medianHz)} Hz), ${profile.points} Zeichenpunkte in ${profile.strokes} Strichen\n` +
      `Abstand: Median ${number(profile.pointStepsPx.median)} px, Maximum ${number(profile.pointStepsPx.max)} px\n` +
      `AppKit-Warteschlange p95: ${number(profile.appKitQueueMs.p95)} ms; Übergabe an JS p95: ${milliseconds(profile.deliveryMs.p95)} ms; Verarbeitung p95: ${milliseconds(profile.processingMs.p95)} ms\n` +
      `Fehlende Sequenzen: ${profile.missingSequences}; doppelte/rückläufige Zeitstempel: ${profile.duplicateTimestamps}; Fokuswechsel: ${profile.focusChanges}`;
    node('profile-result').textContent = this.comparison
      ? `${format('Mit Zusammenfassung', this.comparison.baseline)}\n\n${format('Ohne Zusammenfassung', this.comparison.uncoalesced)}`
      : 'Noch keine Messung. Während beider Phasen zügig Kreise oder Handschrift zeichnen; beim Wechsel den Stift kurz anheben.';
  }
  cancel(): void {this.cancelled = true; window.clearTimeout(this.timer); this.wake?.();}
  private wait(): Promise<void> {return new Promise(resolve => {this.wake = resolve; this.timer = window.setTimeout(resolve, 10_000);});}
  private async phase(enabled: boolean, label: string): Promise<InputProfile> {
    this.finish(); await this.settings(enabled);
    this.metrics.start();
    node('profile-phase').textContent = label;
    await this.wait(); this.finish(); return this.metrics.stop();
  }
  async compare(): Promise<void> {
    if (this.running || !this.native) return;
    this.running = true; this.cancelled = false;
    node<HTMLButtonElement>('profile-start').disabled = true;
    node<HTMLInputElement>('input-high-rate').disabled = true;
    const dialog = node<HTMLDialogElement>('diagnostics-dialog');
    let original: Settings | null = null;
    try {
      original = await this.settings();
      dialog.close(); node('profile-recording').hidden = false;
      const baseline = await this.phase(true, 'Messung 1/2 · Mit Zusammenfassung · 10 s schreiben');
      if (this.cancelled) return;
      const uncoalesced = await this.phase(false, 'Messung 2/2 · Stift kurz anheben, dann 10 s weiterschreiben');
      if (this.cancelled) return;
      this.comparison = {version: 1, createdAt: new Date().toISOString(), baseline, uncoalesced};
      const path = await invoke<string>('save_input_profile', {report: this.comparison});
      node('profile-file').textContent = `Messprotokoll: ${path}`;
      this.refresh(); if (!dialog.open) dialog.showModal();
    } catch (error) {this.error(error);}
    finally {
      this.metrics.stop(); this.running = false; this.wake = null;
      node('profile-recording').hidden = true;
      if (original) await this.settings(original.mouseCoalescingEnabled).catch(this.error);
      node<HTMLButtonElement>('profile-start').disabled = false;
      node<HTMLInputElement>('input-high-rate').disabled = false;
    }
  }
}
