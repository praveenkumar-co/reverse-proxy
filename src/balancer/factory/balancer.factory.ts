import { LoadBalancer } from '../core/load-balancer.js';
import type { LoadBalancerOptions } from '../core/load-balancer.js';

export function createLoadBalancer(options: LoadBalancerOptions): LoadBalancer {
  return new LoadBalancer(options);
}
