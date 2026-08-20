import { LoadBalancer } from '../core/load-balancer.js';
import type { LoadBalancerOptions } from '../../types/balancer.types.js';

export function createLoadBalancer(options: LoadBalancerOptions): LoadBalancer {
  return new LoadBalancer(options);
}
