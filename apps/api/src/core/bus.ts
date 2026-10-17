import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface IncidentChanged {
  incidentId: string;
  kind: string;
  at: string;
}

/**
 * In-process event bus. Production replaces this with NATS/Kafka behind the
 * same interface (TRD); the outbox row is already written in the transaction.
 */
@Injectable()
export class Bus {
  private readonly emitter = new EventEmitter().setMaxListeners(10_000);

  publishIncident(e: IncidentChanged) {
    this.emitter.emit(`incident:${e.incidentId}`, e);
  }

  onIncident(incidentId: string, fn: (e: IncidentChanged) => void): () => void {
    const key = `incident:${incidentId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }
}
