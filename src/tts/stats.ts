/** Exponential moving average of the real-time factor (compute seconds per audio second). */
export class RtfTracker {
  private value = 0;
  private count = 0;

  constructor(private readonly alpha = 0.3, private readonly minAudioMs = 300) {}

  add(synthMs: number, audioMs: number): void {
    if (!(audioMs >= this.minAudioMs) || !(synthMs >= 0)) return;
    const rtf = synthMs / audioMs;
    this.value = this.count === 0 ? rtf : this.value + this.alpha * (rtf - this.value);
    this.count++;
  }

  get rtf(): number { return this.value; }
  get samples(): number { return this.count; }
  reset(): void { this.value = 0; this.count = 0; }
}
