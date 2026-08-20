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

  public enter(): boolean {
    if (this.activeCount >= this.maxConcurrent) {
      return false;
    }
    this.activeCount++;
    return true;
  }

  public leave(): void {
    if (this.activeCount > 0) {
      this.activeCount--;
    }
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public getMaxConcurrent(): number {
    return this.maxConcurrent;
  }
}
