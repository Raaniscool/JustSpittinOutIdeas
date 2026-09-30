/**
 * Ollama provider.
 *
 * Throughput decisions made here:
 *  - one persistent keep-alive socket pool shared by every call (no reconnects)
 *  - `keep_alive` on every request so the weights stay resident between bursts
 *  - streaming NDJSON, so ideas are parsed and evaluated while the batch is
 *    still being generated
 *  - structured output (`format` = JSON schema) so the model cannot spend
 *    tokens on prose and we never pay for a parse-retry loop
 *  - `think:false` for reasoning models: deliberation tokens are pure latency
 *    for a scanning workload
 *  - modest `num_ctx` / `num_predict`: a small model with a huge context window
 *    is a slow model
 */
import { getJson, postJsonStream, HttpError } from '../lib/http.js';
import { JsonItemStream, parseObjectResponse } from '../lib/jsonStream.js';

export class ProviderError extends Error {
  constructor(message, { cause, retryable = false, code } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.cause = cause;
    this.retryable = retryable;
    this.code = code;
  }
}

function describeError(err, host, model) {
  if (err instanceof HttpError && err.status === 0) {
    return new ProviderError(
      `Cannot reach Ollama at ${host}. Start it with \`ollama serve\` (and check the host in Settings).`,
      { cause: err, retryable: true, code: 'unreachable' },
    );
  }
  if (err instanceof HttpError && err.status === 404) {
    return new ProviderError(
      `Model "${model}" is not installed in Ollama. Run: ollama pull ${model}`,
      { cause: err, code: 'model-missing' },
    );
  }
  const msg = err?.message || String(err);
  if (/context length|exceeds the context|too many tokens/i.test(msg)) {
    return new ProviderError(`Context overflow - lower num_ctx or shorten the prompt. (${msg})`, { cause: err, code: 'context' });
  }
  if (/out of memory|OOM/i.test(msg)) {
    return new ProviderError(`Ollama ran out of memory with ${model}. Try a smaller model or lower num_ctx. (${msg})`, {
      cause: err,
      retryable: true,
      code: 'oom',
    });
  }
  const retryable = /aborted|timeout|ECONNRESET|socket hang up|503|502/i.test(msg);
  return new ProviderError(msg, { cause: err, retryable });
}

export const ollamaProvider = {
  id: 'ollama',
  label: 'Ollama (local models)',
  description: 'Any model installed in your local Ollama runtime.',
  capabilities: { listModels: true, streaming: true, structured: true, parallel: true, preload: true },
  settings: null,
  state: {
    reachable: null,
    version: null,
    lastChecked: 0,
    lastError: null,
    structuredOk: true, // flips off if this Ollama build rejects JSON schemas
    thinkOk: true,
    modelCache: { at: 0, models: [] },
  },

  configure(settings) {
    this.settings = settings;
    const host = (settings?.ollama?.host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.host = host;
    return this;
  },

  get host() {
    return this._host || 'http://127.0.0.1:11434';
  },
  set host(v) {
    this._host = v;
  },

  async ping({ force = false } = {}) {
    const fresh = Date.now() - (this.state.lastChecked || 0) < 15000;
    if (fresh && !force) return { reachable: this.state.reachable, version: this.state.version };
    try {
      const info = await getJson(`${this.host}/api/version`, { timeoutMs: 3000 });
      this.state.reachable = true;
      this.state.version = info?.version || 'unknown';
      this.state.lastError = null;
    } catch (err) {
      this.state.reachable = false;
      this.state.version = null;
      this.state.lastError = err.message;
    }
    this.state.lastChecked = Date.now();
    return { reachable: this.state.reachable, version: this.state.version, error: this.state.lastError, host: this.host };
  },

  async listModels({ force = false } = {}) {
    const cache = this.state.modelCache;
    if (!force && cache.models.length && Date.now() - cache.at < 20000) return cache.models;
    const data = await getJson(`${this.host}/api/tags`, { timeoutMs: 6000 }).catch((err) => {
      throw describeError(err, this.host, '');
    });
    const models = (data?.models || [])
      .map((m) => {
        const details = m.details || {};
        const size = Number(m.size || 0);
        return {
          id: m.model || m.name,
          name: m.model || m.name,
          provider: 'ollama',
          family: details.family || '',
          parameterSize: details.parameter_size || '',
          quantization: details.quantization_level || '',
          sizeBytes: size,
          sizeLabel: size ? `${(size / 1024 ** 3).toFixed(1)} GB` : '',
          modifiedAt: m.modified_at || '',
          // Heuristic: smaller/quantised models are the high-throughput choice.
          hint: size && size < 3 * 1024 ** 3 ? 'fast' : size > 12 * 1024 ** 3 ? 'slow' : 'balanced',
        };
      })
      .sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
    this.state.modelCache = { at: Date.now(), models };
    return models;
  },

  /** Load weights into memory without generating, so the first real call is fast. */
  async preload(model) {
    try {
      await postJsonStream(
        `${this.host}/api/generate`,
        { model, prompt: '', keep_alive: this.keepAlive(), options: { num_predict: 0 } },
        { timeoutMs: 120000 },
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async unload(model) {
    try {
      await postJsonStream(`${this.host}/api/generate`, { model, prompt: '', keep_alive: 0 }, { timeoutMs: 15000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  keepAlive() {
    return this.settings?.ollama?.keepAlive ?? '30m';
  },

  /**
   * @param {object} req
   * @param {string} req.model
   * @param {string} req.system  constant role prompt (cache-friendly prefix)
   * @param {string} req.prompt  variable user message
   * @param {object} [req.schema] JSON schema for structured output
   * @param {number} [req.temperature]
   * @param {number} [req.maxTokens]
   * @param {number} [req.numCtx]
   * @param {AbortSignal} [req.signal]
   * @param {(delta:string)=>void} [req.onToken] raw token callback
   * @param {(item:object)=>void} [req.onItem] fires the moment each element of
   *        the response array is complete - this is what lets IdeaLab evaluate
   *        idea #1 while the model is still generating idea #6.
   * @param {string|null} [req.itemArrayKey] array in the schema to stream items from
   */
  async complete(req) {
    const {
      model,
      system,
      prompt,
      schema,
      temperature = 0.7,
      maxTokens = 1024,
      numCtx = 2048,
      signal,
      onToken,
      onItem,
      itemArrayKey,
      seed,
      topP,
    } = req;
    if (!model) throw new ProviderError('No model selected. Choose one in the model picker.', { code: 'no-model' });

    const options = {
      temperature,
      num_predict: maxTokens,
      num_ctx: numCtx,
      ...(topP ? { top_p: topP } : {}),
      ...(seed !== undefined ? { seed } : {}),
    };

    const useSchema = schema && this.state.structuredOk;
    const useThinkFlag = this.state.thinkOk && this.settings?.ollama?.disableThinking !== false;
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      stream: true,
      keep_alive: this.keepAlive(),
      options,
      ...(useSchema ? { format: schema } : { format: 'json' }),
      ...(useThinkFlag ? { think: false } : {}),
    };

    const started = Date.now();
    let text = '';
    let lineBuf = '';
    let usage = {};
    const timeoutMs = this.settings?.ollama?.requestTimeoutMs || 180000;
    const arrayKey = itemArrayKey !== undefined ? itemArrayKey : firstArrayKey(schema);
    // Incremental item extraction runs while tokens are still arriving.
    const itemStream = onItem && arrayKey ? new JsonItemStream({ arrayKey, keepRaw: false }) : null;

    const consumeLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (obj.error) throw new ProviderError(`Ollama: ${obj.error}`, { retryable: /context|memory/i.test(obj.error) });
      const delta = obj.message?.content;
      if (delta) {
        text += delta;
        if (onToken) onToken(delta, text);
        if (itemStream) for (const item of itemStream.push(delta)) safeOnItem(onItem, item);
      }
      if (obj.done) {
        usage = {
          promptTokens: obj.prompt_eval_count ?? null,
          completionTokens: obj.eval_count ?? null,
          totalDurationMs: obj.total_duration ? Math.round(obj.total_duration / 1e6) : Date.now() - started,
          evalDurationMs: obj.eval_duration ? Math.round(obj.eval_duration / 1e6) : null,
          tokensPerSec: obj.eval_count && obj.eval_duration ? Math.round((obj.eval_count / (obj.eval_duration / 1e9)) * 10) / 10 : null,
          model: obj.model || model,
        };
      }
    };

    const run = async (payload) => {
      text = '';
      lineBuf = '';
      usage = {};
      if (itemStream) {
        itemStream.items.length = 0;
        itemStream.done = false;
        itemStream.mode = arrayKey ? 'seek' : 'collect';
        itemStream.depth = 0;
        itemStream.pending = '';
        itemStream.raw = '';
        itemStream.tail = '';
      }
      await postJsonStream(`${this.host}/api/chat`, payload, {
        signal,
        timeoutMs,
        maxSockets: Math.max(8, (this.settings?.performance?.evaluateConcurrency || 3) * 2),
        onChunk: (chunk) => {
          lineBuf += chunk;
          let idx;
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, idx);
            lineBuf = lineBuf.slice(idx + 1);
            consumeLine(line);
          }
        },
      });
      if (lineBuf.trim()) consumeLine(lineBuf);
      if (itemStream) for (const item of itemStream.finish()) safeOnItem(onItem, item);
      return text;
    };

    try {
      await run(body);
    } catch (err) {
      const msg = err?.message || '';
      // Older Ollama builds do not understand JSON-schema `format`.
      if (useSchema && /schema|format/i.test(msg)) {
        this.state.structuredOk = false;
        console.warn('[idealab] Ollama rejected JSON schema format; falling back to format:"json" for this session.');
        await run({ ...body, format: 'json' });
      } else if (useThinkFlag && /think/i.test(msg)) {
        this.state.thinkOk = false;
        const { think, ...rest } = body;
        await run(rest);
      } else {
        throw describeError(err, this.host, model);
      }
    }

    return {
      text,
      usage,
      object: parseObjectResponse(text),
      items: itemStream ? itemStream.items : undefined,
      elapsedMs: Date.now() - started,
      model,
      provider: 'ollama',
    };
  },
};

function safeOnItem(onItem, item) {
  try {
    onItem(item);
  } catch (err) {
    console.error('[idealab] onItem handler failed:', err.message);
  }
}

function firstArrayKey(schema) {
  if (!schema?.properties) return null;
  for (const [key, value] of Object.entries(schema.properties)) {
    if (value?.type === 'array') return key;
  }
  return null;
}

export default ollamaProvider;
