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
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) =>
    res
      .status(200)
      .type('html')
      .send(
        `<html><body style="font-family:ui-sans-serif;background:#0b0e14;color:#e6edf7;padding:40px">
        <h1>IdeaLab API is running</h1>
        <p>The UI has not been built yet. Run <code>npm run dev</code> for the dev server, or <code>npm run build &amp;&amp; npm start</code>.</p>
        <p>API: <a style="color:#7ee787" href="/api/health">/api/health</a> &middot; <a style="color:#7ee787" href="/api/stats">/api/stats</a></p>
        </body></html>`,
      ),
  );
}

app.use((err, _req, res, _next) => {
  console.error('[idealab] unhandled route error:', err.message);
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, HOST, async () => {
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
