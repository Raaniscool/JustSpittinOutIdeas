/**
 * Tiny persistent HTTP client for talking to a local model server.
 *
 * Why not global fetch?  We want an explicit, long-lived keep-alive socket
 * pool so that hundreds of sequential requests to Ollama reuse the same TCP
 * connection (no TLS/handshake/setup churn, no reconnect stalls) and so we can
 * cap in-flight sockets to match OLLAMA_NUM_PARALLEL.
 */
import http from 'node:http';
import https from 'node:https';

const agents = new Map();

function agentFor(origin, maxSockets) {
  const key = `${origin}|${maxSockets}`;
  let agent = agents.get(key);
  if (!agent) {
    const mod = origin.startsWith('https') ? https : http;
    agent = new mod.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets,
      maxFreeSockets: maxSockets,
      scheduling: 'fifo',
      timeout: 0,
    });
    // Never let an idle agent keep the process alive.
    agent.unref?.();
    agents.set(key, agent);
  }
  return agent;
}

export class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * POST JSON and stream the raw response body.
 * @param {string} url
 * @param {object} payload
 * @param {{signal?: AbortSignal, timeoutMs?: number, maxSockets?: number, onChunk?: (chunk: string)=>void, headers?: Record<string,string>}} [opts]
 * @returns {Promise<{text: string, status: number}>}
 */
export async function postJsonStream(url, payload, opts = {}) {
  const { signal, timeoutMs = 0, maxSockets = 16, onChunk, headers = {} } = opts;
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const body = Buffer.from(JSON.stringify(payload));

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent: agentFor(u.origin, maxSockets),
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          accept: 'application/x-ndjson, application/json',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve({ text, status: res.statusCode });
        };
        const timer = timeoutMs
          ? setTimeout(() => {
              req.destroy(new HttpError(`Request timed out after ${timeoutMs}ms`, { url, status: res.statusCode }));
            }, timeoutMs)
          : null;

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (onChunk) {
            try {
              onChunk(chunk);
            } catch (err) {
              finish(err);
            }
          }
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            finish(new HttpError(httpErrorMessage(text, res.statusCode, url), { status: res.statusCode, body: text, url }));
            return;
          }
          finish(null);
        });
        res.on('error', (err) => finish(err));
      },
    );

    req.on('error', (err) => {
      reject(
        new HttpError(
          err.code === 'ECONNREFUSED'
            ? `Cannot reach ${u.origin} - is the model server running? (${err.code})`
            : err.message,
          { url, status: 0, body: String(err.code || '') },
        ),
      );
    });

    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.write(body);
    req.end();
  });
}

export async function getJson(url, { timeoutMs = 5000, signal } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        agent: agentFor(u.origin, 8),
        headers: { accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new HttpError(httpErrorMessage(text, res.statusCode, url), { status: res.statusCode, body: text }));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new HttpError(`Invalid JSON from ${url}`, { status: res.statusCode, body: text }));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new HttpError(`Timeout contacting ${url}`, { url })));
    req.on('error', (err) =>
      reject(
        new HttpError(
          err.code === 'ECONNREFUSED'
            ? `Cannot reach ${u.origin} - is Ollama running? Start it with \`ollama serve\`.`
            : err.message,
          { url, status: 0 },
        ),
      ),
    );
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.end();
  });
}

function httpErrorMessage(text, status, url) {
  let detail = text?.slice(0, 600) || '';
  try {
    const parsed = JSON.parse(text);
    detail = parsed.error || parsed.message || detail;
  } catch {
    /* keep raw */
  }
  return `HTTP ${status} from ${url}: ${detail}`;
}
