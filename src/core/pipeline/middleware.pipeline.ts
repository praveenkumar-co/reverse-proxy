import type { RequestContext } from './context.js';

export type MiddlewareFn = (ctx: RequestContext, next: () => Promise<void>) => Promise<void>;

export class MiddlewarePipeline {
  private stack: MiddlewareFn[] = [];

  use(fn: MiddlewareFn): this {
    this.stack.push(fn);
    return this;
  }

  async run(ctx: RequestContext): Promise<void> {
    let index = 0;
    const next = async (): Promise<void> => {
      if (index >= this.stack.length) return;
      const fn = this.stack[index++]!;
      await fn(ctx, next);
    };
    await next();
  }
}
