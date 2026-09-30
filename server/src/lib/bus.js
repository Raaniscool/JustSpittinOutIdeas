/**
 * Minimal in-process pub/sub used to push incremental pipeline results to the
 * browser over a single Server-Sent-Events connection.
 */
class Bus {
  constructor() {
    this.listeners = new Set();
    this.recent = []; // ring buffer so a late subscriber can catch up
    this.recentMax = 120;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(type, payload) {
    const evt = { type, payload, t: Date.now() };
    this.recent.push(evt);
    if (this.recent.length > this.recentMax) this.recent.splice(0, this.recent.length - this.recentMax);
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch {
        /* a dead subscriber must not break the pipeline */
      }
    }
    return evt;
  }

  catchUp(since = 0) {
    return this.recent.filter((e) => e.t > since);
  }
}

export const bus = new Bus();
export const emit = (type, payload) => bus.publish(type, payload);
