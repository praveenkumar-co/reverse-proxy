import type { RouteRule } from './route.types.js';

export class RouteMatcher {
  constructor(private rules: RouteRule[]) {}

  match(path: string, method?: string): RouteRule | undefined {
    return this.rules.find(r => {
      if (!path.startsWith(r.path)) return false;
      if (r.methods && method && !r.methods.includes(method.toUpperCase())) return false;
      return true;
    });
  }
}
