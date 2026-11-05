export type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * In-process handoff bus. Agents subscribe only to the topic the previous
 * stage is allowed to publish. Delivery is synchronous up to the first await;
 * returned promises are the caller's responsibility to track.
 */
export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<unknown>>>();

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<unknown>);
    return () => set!.delete(fn as Handler<unknown>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        const result = fn(payload);
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).catch((err) => {
            console.error(`[bus] ${String(type)} handler failed`, err);
          });
        }
      } catch (err) {
        console.error(`[bus] ${String(type)} handler threw`, err);
      }
    }
  }
}
