import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * Renders the real React components with realistic API payloads.
 * esbuild compiles the JSX (it ships with Vite), the bundle is written into
 * node_modules/.cache so `react` still resolves, and a non-zero exit means a
 * component crashed or lost a field the API is supposed to send.
 */
test('the whole UI renders without crashing', async () => {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    console.log('# esbuild not installed - skipping the UI render smoke test');
    return;
  }

  const outfile = path.join(root, 'node_modules', '.cache', 'idealab-ui-smoke.mjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, 'tests', 'ui', 'smoke.jsx')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    alias: { '@shared': path.join(root, 'shared') },
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'node:*'],
    absWorkingDir: root,
    logLevel: 'warning',
  });

  assert.ok(fs.existsSync(outfile), 'bundle should exist');

  const { code, out } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });

  if (code !== 0) console.log(out);
  assert.equal(code, 0, `UI render smoke test failed:\n${out}`);
  assert.match(out, /UI render checks passed/);
  assert.ok(!out.includes('FAIL -'), out);

  // The component count is a proxy for "we actually rendered the app".
  const checks = Number(/(\d+)\/(\d+) UI render checks passed/.exec(out)?.[2] || 0);
  assert.ok(checks >= 15, `expected a broad render pass, got ${checks} checks`);

  fs.rmSync(outfile, { force: true });
});
