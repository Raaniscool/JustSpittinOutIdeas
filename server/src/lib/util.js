/** Bounded FIFO cache with TTL, used for evaluation reuse and model lists. */
export class TtlCache {
  constructor({ max = 5000, ttlMs = 1000 * 60 * 60 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.t > this.ttlMs) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.v;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v: value, t: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses, max: this.max };
  }
}

/** Concurrency limiter (hand-rolled, dependency free). */
export function createLimiter(concurrency = 1) {
  let active = 0;
  const queue = [];
  const limit = Math.max(1, concurrency);

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });

  run.setConcurrency = (n) => {
    // Not dynamic for in-flight work; used when rebuilding the limiter.
    void n;
  };
  run.pending = () => queue.length;
  run.active = () => active;
  return run;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    }
  });
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function round1(v) {
  return Math.round((Number(v) + Number.EPSILON) * 10) / 10;
}

export function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/** Deterministic 32-bit string hash (for seeded RNG / cache keys). */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG - reproducible demo output and stable jitter. */
export function seededRandom(seed) {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
