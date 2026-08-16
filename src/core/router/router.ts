import { RouteMatcher } from './route.matcher.js';
import type { RouteRule } from './route.types.js';

export class Router {
  private matcher: RouteMatcher;

  constructor(rules: RouteRule[]) {
    this.matcher = new RouteMatcher(rules);
  }

  route(path: string, method?: string): RouteRule | undefined {
    return this.matcher.match(path, method);
  }

  updateRules(rules: RouteRule[]) {
    this.matcher = new RouteMatcher(rules);
  }
}
