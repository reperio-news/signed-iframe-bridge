/** Minimal typed event emitter for services. */
export type EventHandler<T = unknown> = (data: T) => void;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class TypedEmitter<EventMap extends {}> {
  private listeners = new Map<keyof EventMap, Set<EventHandler<never>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as EventHandler<never>);
    return () => this.off(event, handler);
  }

  /** Unsubscribe from an event. */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.listeners.get(event)?.delete(handler as EventHandler<never>);
  }

  /** Emit an event to all subscribers. */
  protected emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        (handler as EventHandler<EventMap[K]>)(data);
      }
    }
  }

  /** Remove all listeners. */
  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
