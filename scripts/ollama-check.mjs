/**
 * Quick pre-flight check: is Ollama running, and what is installed?
 *   node scripts/ollama-check.mjs [http://127.0.0.1:11434]
 */
const host = (process.argv[2] || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const get = async (p) => {
  const res = await fetch(host + p, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

try {
  const version = await get('/api/version');
  const { models } = await get('/api/tags');
  console.log(`Ollama ${version.version} at ${host}`);
  if (!models?.length) {
    console.log('No models installed. Try:  ollama pull qwen3:1.7b');
    process.exit(0);
  }
  console.log(`${models.length} model(s):`);
  const rows = models
    .map((m) => ({
      name: m.name,
      size: `${(m.size / 1024 ** 3).toFixed(1)} GB`,
      params: m.details?.parameter_size || '-',
      quant: m.details?.quantization_level || '-',
      family: m.details?.family || '-',
    }))
    .sort((a, b) => parseFloat(a.size) - parseFloat(b.size));
  const width = Math.max(...rows.map((r) => r.name.length), 5);
  for (const r of rows) console.log(`  ${r.name.padEnd(width)}  ${r.size.padStart(8)}  ${r.params.padStart(6)}  ${r.quant}  ${r.family}`);
  console.log('\nSmallest = fastest. For high-volume scanning, a 1-4B model is usually the right trade.');
} catch (err) {
  console.error(`Cannot reach Ollama at ${host}: ${err.message}`);
  console.error('Start it with:  ollama serve');
  process.exit(1);
}
