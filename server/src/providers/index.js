/**
 * Provider registry.
 *
 * Adding a new backend (LM Studio, llama.cpp server, OpenAI-compatible cloud,
 * ...) means writing one object with `listModels()` and `complete()` and adding
 * it here. Nothing else in IdeaLab knows which provider is in use.
 *
 *   interface Provider {
 *     id: string
 *     label: string
 *     capabilities: { listModels, streaming, structured, parallel, preload }
 *     configure(settings, ctx) -> this
 *     ping() -> { reachable, version, host, error }
 *     listModels({force}) -> [{ id, name, provider, sizeLabel, hint, ... }]
 *     preload(model) -> { ok }
 *     complete({ role, model, system, prompt, schema, temperature, maxTokens,
 *                numCtx, signal, onToken, onItem, itemArrayKey })
 *        -> { text, object, items, usage, elapsedMs, model, provider }
 *   }
 */
import ollamaProvider from './ollama.js';
import demoProvider from './demo.js';

const registry = new Map();

export function registerProvider(provider) {
  if (!provider?.id || typeof provider.complete !== 'function') {
    throw new Error('A provider must have an id and a complete() method');
  }
  registry.set(provider.id, provider);
  return provider;
}

registerProvider(ollamaProvider);
registerProvider(demoProvider);

export function listProviders() {
  return [...registry.values()].map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description || '',
    capabilities: p.capabilities || {},
    synthetic: !!p.capabilities?.synthetic,
  }));
}

export function getProvider(id) {
  const p = registry.get(id) || registry.get('ollama');
  return p;
}

/** Push current settings + shared context (Knowledge Bank) into every provider. */
export function configureProviders(settings, ctx = {}) {
  for (const p of registry.values()) {
    try {
      p.configure?.(settings, ctx);
    } catch (err) {
      console.error(`[idealab] provider ${p.id} failed to configure: ${err.message}`);
    }
  }
}

export { ProviderError } from './ollama.js';
