/**
 * IdeaLab server entry point.
 *
 * Serves the API, a single Server-Sent-Events stream for live pipeline updates,
 * and (after `npm run build`) the compiled UI.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, shutdown } from './app.js';
import { apiRouter } from './routes/api.js';
import { bus, emit } from './lib/bus.js';
import net from 'node:net';
import { HOST, PORT, ROOT } from './config.js';
import { getProvider } from './providers/index.js';
import { IdeaRepository } from './pipeline/ideas.js';

const ctx = createApp();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

// CORS is open on purpose: this is a local-first tool and the user may point a
// browser, a script, or another app at it.
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', apiRouter(ctx));

// Unknown API paths must answer as JSON, not fall through to the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: `no such endpoint: ${req.method} ${req.originalUrl}` }));

// ------------------------------------------------------------------- SSE ----
app.get(['/events', '/api/events'], (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const send = (type, payload) => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* client went away */
    }
  };

  // Catch a fresh subscriber up immediately.
  send('snapshot', {
    stats: ctx.stats.summary({ elapsedMs: Date.now() - ctx.startedAt }),
    calibration: ctx.calibration.stats(),
    bias: ctx.bias.snapshot(),
    distribution: ctx.repo.distribution(),
    knowledge: ctx.bank.stats(),
    jobs: ctx.jobs.list(),
    activeJob: ctx.jobs.active(),
    reviews: ctx.reviews?.snapshot({ limit: 0 }) || null,
    settings: ctx.settingsStore.data,
    evalCache: ctx.engine.evalCache.stats(),
  });

  const unsub = bus.subscribe((evt) => send(evt.type, evt.payload));
  const statsTimer = setInterval(() => {
    send('stats', ctx.stats.summary({ elapsedMs: Date.now() - ctx.startedAt }));
    send('calibration', ctx.calibration.stats());
  }, 5000);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(statsTimer);
    clearInterval(ping);
    unsub();
  });
});

// ------------------------------------------------------------- static UI ----
const distDir = path.join(ROOT, 'web', 'dist');

const devHintPage = (reason) => `<!doctype html><html><body style="font-family:ui-sans-serif,system-ui;background:#070a10;color:#e7eef8;padding:48px;max-width:720px;margin:0 auto">
<h1 style="font-size:20px">⚗ IdeaLab API is running</h1>
<p style="color:#a8b6c9">${reason}</p>
<pre style="background:#0f141d;border:1px solid #1e2735;border-radius:10px;padding:14px;overflow:auto">npm install     # once
npm run dev     # UI on :5173 with hot reload, API on :8787
# or
npm start       # builds the UI and serves everything from :8787</pre>
<p style="color:#6f7f95;font-size:13px">API is live: <a style="color:#58d3ff" href="/api/health">/api/health</a> &middot;
<a style="color:#58d3ff" href="/api/ideas?limit=5">/api/ideas</a> &middot;
<a style="color:#58d3ff" href="/api/stats">/api/stats</a> &middot;
<a style="color:#58d3ff" href="/events">/events</a></p>
</body></html>`;

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: 'index.html' }));
  app.get('*', (_req, res) => {
    // Checked per request: if the build directory disappears while the server is
    // running, say so instead of serving a blank page.
    if (fs.existsSync(path.join(distDir, 'index.html'))) return res.sendFile(path.join(distDir, 'index.html'));
    res.status(503).type('html').send(devHintPage('The compiled UI is missing (web/dist was removed). Run <code>npm run build</code>, or use <code>npm run dev</code>.'));
  });
} else {
  app.get('*', (_req, res) =>
    res.status(200).type('html').send(devHintPage('The UI has not been built yet.')),
  );
}

app.use((err, _req, res, _next) => {
  console.error('[idealab] unhandled route error:', err.message);
  res.status(500).json({ error: err.message });
});

/**
 * Bind the server. `HOST` unset means "everywhere", and on a dual-stack machine
 * that has to include IPv6: browsers that resolve `localhost` to ::1 first got a
 * connection refused when we listened on 0.0.0.0 only. `::` accepts both families.
 */
function bind(port, host, onReady) {
  if (!host) return app.listen(port, '::', onReady);
  const server = app.listen(port, host, onReady);
  if (net.isIPv4(host) && (host === '0.0.0.0' || host === '127.0.0.1')) {
    // Best-effort IPv6 twin so ::1 works too. Ignored if the stack has no IPv6
    // or the port is already taken there.
    const v6 = app.listen(port, '::1');
    v6.on('error', () => v6.close());
    server.on('close', () => v6.close());
  }
  return server;
}

const server = bind(PORT, HOST, async () => {
  const provider = getProvider(ctx.settingsStore.data.provider);
  const ping = await provider.ping?.().catch((e) => ({ reachable: false, error: e.message }));
  const model = ctx.settingsStore.data.model || (await ctx.engine.resolveModel());

  console.log('');
  console.log('  IdeaLab - local-first idea discovery laboratory');
  console.log('  -------------------------------------------------');
  console.log(`  UI/API      http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Provider    ${provider.id} (${provider.label})`);
  console.log(`  Endpoint    ${provider.id === 'ollama' ? ctx.settingsStore.data.ollama.host : 'in-process'}`);
  console.log(`  Reachable   ${ping?.reachable ? `yes (v${ping.version || '?'})` : `NO - ${ping?.error || 'unreachable'}`}`);
  console.log(`  Model       ${model || 'none detected'}`);
  console.log(`  Ideas bank  ${ctx.repo.count()} ideas | ${ctx.bank.stats().total} knowledge entries`);
  if (provider.id === 'ollama' && !ping?.reachable) {
    console.log('');
    console.log('  Ollama is not reachable. Start it with `ollama serve`, or switch the');
    console.log('  provider to "demo" in Settings to explore IdeaLab without a model.');
  }
  console.log('');
});

// Periodic flush so a crash cannot lose much work.
const flushTimer = setInterval(() => {
  for (const s of ctx.stores) void s.flush();
}, 5000);
flushTimer.unref?.();

let shuttingDown = false;
const onSignal = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[idealab] ${sig} - flushing and shutting down`);
  clearInterval(flushTimer);
  try {
    await shutdown(ctx);
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[idealab] unhandled rejection:', err?.message || err));

export { app, ctx, server };
