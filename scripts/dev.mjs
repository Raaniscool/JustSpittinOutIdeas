/**
 * Dev runner: starts the API server and the Vite dev server together.
 * (A hand-rolled replacement for `concurrently` - one less dependency.)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = process.env.PORT || 8787;
const WEB_PORT = process.env.WEB_PORT || 5173;

const kids = [];

function run(name, cmd, args, color) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, PORT, WEB_PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        out.write(tag + buf.slice(0, i) + '\n');
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${tag}exited with ${code}`);
    shutdown(code ?? 0);
  });
  kids.push(child);
  return child;
}

let done = false;
function shutdown(code) {
  if (done) return;
  done = true;
  for (const k of kids) if (!k.killed) k.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`\n  IdeaLab dev  →  UI http://localhost:${WEB_PORT}   API http://localhost:${PORT}\n`);
run('api', process.execPath, ['server/src/index.js'], 36);
run('web', process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js')], 35);
