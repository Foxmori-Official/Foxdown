/**
 * Speed history ring buffer (dashboard data source, Motrix Dashboard equivalent):
 * samples global speed every 1s, keeps the last 300 points (5 minutes).
 */
export class SpeedHistory {
  constructor() {
    this.samples = [];           // [{t, down, up}]
    this.maxSamples = 300;
    this.totals = { downloaded: 0, uploaded: 0, completedCount: 0 };
  }

  sample(down, up) {
    this.samples.push({ t: Date.now(), down: down | 0, up: up | 0 });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  /** Estimate cumulative transfer from the task list (aria2 does not track across sessions) */
  accumulate(tasks) {
    let dl = 0, ul = 0, done = 0;
    for (const t of tasks) {
      dl += t.completedLength || 0;
      ul += t.uploadLength || 0;
      if (t.status === 'complete') done++;
    }
    this.totals = { downloaded: dl, uploaded: ul, completedCount: done };
  }

  snapshot() {
    return { history: this.samples, totals: this.totals };
  }
}
