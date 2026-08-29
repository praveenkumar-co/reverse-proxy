export interface PassiveProbeEvent {
  upstreamId: string;
  statusCode: number;
  latencyMs: number;
}
export class PassiveProbe {
  private listeners: Array<(event: PassiveProbeEvent) => void> = [];
  onEvent(fn: (event: PassiveProbeEvent) => void){
    this.listeners.push(fn);
  }
  record(event: PassiveProbeEvent){
    for(const fn of this.listeners) fn(event);
  }
}
export const passiveProbe = new PassiveProbe();
