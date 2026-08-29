export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

export class ReadinessProbe {
  private checks: ReadinessCheck[] = [];

  register(check: ReadinessCheck){
    this.checks.push(check);
  }

  async isReady(): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    const results: Record<string, boolean> = {};
    let allOk = true;
    for (const c of this.checks){
      try {
        results[c.name] = await c.check();
      } catch {
        results[c.name] = false;
      }
      if (!results[c.name]) allOk = false;
    }
    return { ready: allOk, checks: results };
  }
}

export const readinessProbe = new ReadinessProbe();
