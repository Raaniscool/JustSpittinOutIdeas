/**
 * Dead-simple durable JSON store with debounced atomic writes.
 * Local-first: everything lives in ./data on the user's machine.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export class JsonStore {
  /**
   * @param {string} name file name (without extension) inside DATA_DIR
   * @param {any} fallback value used when the file does not exist yet
   */
  constructor(name, fallback, { debounceMs = 400 } = {}) {
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.fallback = fallback;
    this.data = fallback;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.writing = false;
    this.dirty = false;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.data = structuredClone(this.fallback);
      }
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
      } catch {
        /* ignore */
      }
      console.error(`[idealab] ${this.file} was unreadable (${err.message}); moved to ${backup}`);
      this.data = structuredClone(this.fallback);
    }
    return this.data;
  }

  /** Mark dirty and schedule a write. Safe to call very frequently. */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || this.writing) return;
    this.writing = true;
    this.dirty = false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(this.data), 'utf8');
      await fsp.rename(tmp, this.file);
    } catch (err) {
      console.error(`[idealab] failed to persist ${this.file}: ${err.message}`);
      this.dirty = true;
    } finally {
      this.writing = false;
      if (this.dirty) this.save();
    }
  }
}

export async function flushAll(stores) {
  await Promise.all(stores.map((s) => s.flush()));
}
