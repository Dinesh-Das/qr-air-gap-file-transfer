/** At most five seconds of samples, bounded independently of transfer length. */
export class TransferRateWindow {
  private samples: Array<{ time: number; bytes: number }> = [];
  constructor(private readonly windowMilliseconds: 1000 | 5000 = 5000) {}
  sample(time: number, bytes: number): number {
    const previous = this.samples.at(-1);
    if (!Number.isFinite(time) || !Number.isFinite(bytes) || bytes < 0) { this.samples = []; return 0; }
    if (previous && (time <= previous.time || bytes < previous.bytes)) this.samples = [];
    this.samples.push({ time, bytes });
    while (this.samples.length > 11 || this.samples.length > 1 && this.samples[1].time <= time - this.windowMilliseconds) this.samples.shift();
    const first = this.samples[0];
    const seconds = (time - first.time) / 1000;
    return seconds > 0 ? Math.max(0, bytes - first.bytes) / seconds : 0;
  }
}
