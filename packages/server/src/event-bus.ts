import { config } from "./config.js";
import type { ServerEvent, ServerEventType } from "@dockermanager/shared";

type Listener = (event: ServerEvent) => void;

export class EventBus {
  private seq = 0;
  private buffer: ServerEvent[] = [];
  private listeners = new Set<Listener>();

  publish(type: ServerEventType, payload: unknown): ServerEvent {
    this.seq += 1;
    const event: ServerEvent = {
      seq: this.seq,
      type,
      at: new Date().toISOString(),
      payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > config.eventBufferSize) {
      this.buffer.splice(0, this.buffer.length - config.eventBufferSize);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken client must not block event delivery
      }
    }
    return event;
  }

  replayAfter(lastSeq: number): ServerEvent[] {
    if (!Number.isFinite(lastSeq) || lastSeq < 0) return [];
    return this.buffer.filter((event) => event.seq > lastSeq);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get currentSeq(): number {
    return this.seq;
  }
}

export const eventBus = new EventBus();
