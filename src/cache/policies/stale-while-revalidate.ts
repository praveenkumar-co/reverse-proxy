export class StaleWhileRevalidate {
  private revalidating = new Set<string>();

  shouldRevalidate(key: string, age: number, maxAge: number): boolean {
    return age > maxAge && !this.revalidating.has(key);
  }
  markRevalidating(key: string){
    this.revalidating.add(key);
  }
  markDone(key: string){
    this.revalidating.delete(key);
  }
}