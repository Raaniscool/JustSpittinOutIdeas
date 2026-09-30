/**
 * Incremental JSON extraction from a token stream.
 *
 * The point of this module is throughput: while Ollama is still emitting idea
 * #7 of a batch, ideas #1..#6 are already parsed and being evaluated. We never
 * wait for the full completion before starting downstream work.
 *
 * `JsonItemStream` is a string-aware brace-depth state machine that emits each
 * complete element of a named JSON array (or each top-level value) the instant
 * its closing brace arrives. Memory stays flat because consumed characters are
 * discarded.
 */
export class JsonItemStream {
  /**
   * @param {{arrayKey?: string|null, onItem?: (value:any)=>void}} [opts]
   *   arrayKey - name of the array whose elements are emitted.
   *              null => emit top-level values (first array/object in stream).
   */
  constructor(opts = {}) {
    this.arrayKey = opts.arrayKey === undefined ? null : opts.arrayKey;
    this.onItem = opts.onItem || (() => {});

    this.mode = this.arrayKey ? 'seek' : 'collect';
    this.depth = 0;
    this.pending = '';
    this.inString = false;
    this.escaped = false;
    this.tail = ''; // small lookbehind for keys split across chunks
    this.arrayDepth = 0;
    this.items = [];
    this.raw = '';
    this.keepRaw = opts.keepRaw !== false;
    this.done = false;
  }

  /** Feed a chunk; returns newly completed values. */
  push(chunk) {
    if (this.done || !chunk) return [];
    if (this.keepRaw) this.raw += chunk;
    const out = [];
    for (let i = 0; i < chunk.length; i++) {
      const value = this.#step(chunk[i]);
      if (value !== NO_VALUE) out.push(value);
      if (this.done) break;
    }
    return out;
  }

  /** Flush: try to salvage truncated JSON so a cut-off stream is not wasted. */
  finish() {
    const out = [];
    if (this.items.length === 0 && this.raw.trim()) {
      const repaired = repairJson(this.raw);
      if (repaired && typeof repaired === 'object') {
        const arr = this.arrayKey && Array.isArray(repaired[this.arrayKey]) ? repaired[this.arrayKey] : repaired;
        const list = Array.isArray(arr) ? arr : [arr];
        for (const it of list) {
          if (it && typeof it === 'object') {
            this.items.push(it);
            out.push(it);
            this.#emit(it);
          }
        }
      }
    } else if (this.pending) {
      const salvaged = repairJson(this.pending);
      if (salvaged && typeof salvaged === 'object') {
        this.items.push(salvaged);
        out.push(salvaged);
        this.#emit(salvaged);
      }
    }
    this.done = true;
    return out;
  }

  #emit(value) {
    try {
      this.onItem(value);
    } catch {
      /* a consumer error must never stall the stream */
    }
  }

  #step(c) {
    if (this.mode === 'seek') {
      this.tail = (this.tail + c).slice(-64);
      const needle = `"${this.arrayKey}"`;
      const at = this.tail.indexOf(needle);
      if (at !== -1) {
        const rest = this.tail.slice(at + needle.length).replace(/^\s*:\s*/, '');
        if (rest.startsWith('[')) {
          this.mode = 'collect';
          this.tail = '';
          this.arrayDepth = 1;
          return NO_VALUE;
        }
        if (rest.length > 0 && !/^\s*:?\s*$/.test(rest)) this.tail = this.tail.slice(-8);
      }
      return NO_VALUE;
    }

    // mode === 'collect'
    if (this.depth > 0) {
      this.pending += c;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
        return NO_VALUE;
      }
      if (c === '"') {
        this.inString = true;
        return NO_VALUE;
      }
      if (c === '{' || c === '[') {
        this.depth++;
        return NO_VALUE;
      }
      if (c === '}' || c === ']') {
        this.depth--;
        if (this.depth === 0) {
          const raw = this.pending;
          this.pending = '';
          this.inString = false;
          const parsed = safeParse(raw);
          if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
            this.items.push(parsed);
            this.#emit(parsed);
            return parsed;
          }
        }
        return NO_VALUE;
      }
      return NO_VALUE;
    }

    // between items
    if (c === '{' || c === '[') {
      this.depth = 1;
      this.pending = c;
      return NO_VALUE;
    }
    if (c === ']' && this.arrayKey) {
      this.done = true; // array closed
      return NO_VALUE;
    }
    return NO_VALUE;
  }
}

const NO_VALUE = Symbol('no-value');

export function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return repairJson(text);
  }
}

/**
 * Best-effort repair of model JSON: strips code fences, trailing commas,
 * balances brackets, and cuts trailing prose after the last closing brace.
 */
export function repairJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json|javascript)?/i, '').replace(/```$/i, '').trim();
  const starts = ['{', '['].map((c) => s.indexOf(c)).filter((i) => i !== -1);
  if (!starts.length) return null;
  s = s.slice(Math.min(...starts));

  // Trim to the end of the first balanced value.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end >= 0) {
    s = s.slice(0, end + 1);
  } else {
    if (inStr) s += '"';
    const stack = [];
    inStr = false;
    esc = false;
    for (const c of s) {
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
    }
    s = s.replace(/,\s*$/, '');
    while (stack.length) s += stack.pop() === '{' ? '}' : ']';
  }

  s = s.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Parse a complete model response into an object, tolerating prose noise. */
export function parseObjectResponse(text) {
  if (!text) return null;
  const direct = safeParse(text);
  if (direct && typeof direct === 'object') return direct;
  return repairJson(text);
}
