import type { RouteRule } from './route.types.js';
export class RouteMatcher {
  constructor(private rules: RouteRule[]){}
  match(path: string, method?: string): RouteRule | undefined {
    const normalizedMethod = method?.toUpperCase();
    const candidates = this.rules.filter(r => {
      if(!path.startsWith(r.path)) return false;
      if(r.methods && r.methods.length > 0){
        // Method guard: a route restricted to specific methods rejects everything else,
        // including requests where the method is unknown.
        if(!normalizedMethod) return false;
        const allowed = r.methods.map(m => m.toUpperCase());
        if(!allowed.includes(normalizedMethod)) return false;
      }
      return true;
    });
    if(candidates.length === 0) return undefined;
    // Route specificity: the longest matching path prefix wins (e.g. "/api/v2" beats "/api"
    // for a request to "/api/v2/items"), falling back to config order for equal-length ties.
    return candidates.reduce((best, r) => (r.path.length > best.path.length ? r : best));
  }
}
