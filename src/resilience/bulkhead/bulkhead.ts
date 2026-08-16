export class Bulkhead {
  private activeCount = 0;

  constructor(private maxConcurrent: number) {}

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error("Bulkhead capacity reached");
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
    }
  }

  public getActiveCount(): number {
    return this.activeCount;
  }
}
