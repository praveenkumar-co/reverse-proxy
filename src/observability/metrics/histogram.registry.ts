export interface HistogramBucket {
  le: number;
  count: number;
}

export class Histogram {
  private buckets: HistogramBucket[];
  private sum = 0;
  private count = 0;

  constructor(boundaries: number[]) {
    this.buckets = [...boundaries.map(le => ({ le, count: 0 })), { le: Infinity, count: 0 }];
  }

  observe(value: number) {
    this.sum += value;
    this.count++;
    for (const b of this.buckets) {
      if (value <= b.le) b.count++;
    }
  }

  toPrometheus(name: string, labels: string): string {
    let out = '';
    for (const b of this.buckets) {
      const le = b.le === Infinity ? '+Inf' : String(b.le);
      out += `${name}_bucket{${labels},le="${le}"} ${b.count}\n`;
    }
    out += `${name}_sum{${labels}} ${this.sum}\n`;
    out += `${name}_count{${labels}} ${this.count}\n`;
    return out;
  }
}

export class HistogramRegistry {
  private histograms = new Map<string, Histogram>();

  getOrCreate(name: string, boundaries = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]): Histogram {
    if (!this.histograms.has(name)) this.histograms.set(name, new Histogram(boundaries));
    return this.histograms.get(name)!;
  }
}

export const histogramRegistry = new HistogramRegistry();
