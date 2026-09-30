/**
 * `npm start` - self-healing launcher.
 *
 * Installs dependencies if they are missing, builds the UI if it has not been
 * built, then serves the API and the compiled UI from a single port. Useful on a
 * fresh clone and in sandboxes that do not persist node_modules/dist.
 */
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(path.join(root, 'node_modules/express'))) {
  console.log('[idealab] installing dependencies…');
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(path.join(root, 'web/dist/index.html'))) {
  console.log('[idealab] building the UI…');
  const r = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log('[idealab] starting server…');
const child = spawn(process.execPath, ['server/src/index.js'], { cwd: root, stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
