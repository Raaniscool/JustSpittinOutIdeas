import test from 'node:test';
import assert from 'node:assert/strict';
import { SimilarityIndex, fingerprint, similarity, tokenize, jaccard, ideaContentKey } from '../server/src/pipeline/similarity.js';

const idea = (over = {}) => ({
  id: over.id || `i-${Math.random().toString(36).slice(2)}`,
  title: 'Invoice extraction copilot for dental practices',
  description: 'Parses scanned invoices with OCR and produces validated line items a human confirms in a review queue.',
  mechanism: 'OCR plus schema-locked extraction with a human review queue',
  targetUser: 'Dental practice administrators',
  problem: 'Staff re-key invoice lines into the accounting system every week',
  category: 'automation',
  ...over,
});

test('tokenize strips stopwords and stems lightly', () => {
  const t = tokenize('The invoices are being processed by an automated system');
  assert.ok(!t.includes('the'));
  assert.ok(!t.includes('are'));
  assert.ok(t.includes('invoice'));
  assert.ok(t.includes('process'));
});

test('identical ideas score 1.0 and unrelated ideas score low', () => {
  const a = fingerprint(idea({ id: 'a' }));
  const b = fingerprint(idea({ id: 'b' }));
  assert.ok(similarity(a, b) > 0.98);

  const c = fingerprint(
    idea({
      id: 'c',
      title: 'Cohort-based course on marine biology for teenagers',
      description: 'A six week live course where students analyse tide pool data collected by local volunteers.',
      mechanism: 'Live cohort sessions with a shared dataset and peer review',
      targetUser: 'Teenagers interested in marine science',
      problem: 'Schools lack access to real field data',
      category: 'education',
    }),
  );
  assert.ok(similarity(a, c) < 0.3, `unrelated ideas should be far apart, got ${similarity(a, c)}`);
});

test('three bands: twin, variation, unrelated', () => {
  const index = new SimilarityIndex();
  const base = idea({ id: 'base' });
  index.add(base);

  // 1. same idea pointed at another vertical, prose reworded => near-duplicate
  const twin = idea({
    id: 'twin',
    targetUser: 'Veterinary clinic administrators',
    problem: 'Clinic staff retype invoice lines into their practice software each week',
    description: 'Reads scanned supplier invoices for clinics and puts every line item into a confirmation queue before posting.',
  });
  const twinHit = index.findSimilar(twin, { limit: 5 })[0];
  assert.equal(twinHit.kind, 'duplicate', 'same title + same core mechanism is a near-duplicate even when reworded');
  assert.ok(twinHit.similarity >= 0.72);

  // 2. same problem, audience and mechanism, different headline and wording => variation
  const variant = idea({
    id: 'variant',
    title: 'Supplier paperwork confirmation queue for clinics',
    description: 'Captures supplier paperwork at the counter and routes only the uncertain fields to a person.',
  });
  const variantHit = index.findSimilar(variant, { limit: 5 })[0];
  assert.equal(variantHit.kind, 'variant');
  assert.ok(variantHit.similarity >= 0.38 && variantHit.similarity < 0.72, `expected the variation band, got ${variantHit.similarity}`);

  // 3. genuinely different idea => not flagged at all
  const unrelated = idea({
    id: 'unrelated',
    title: 'Cohort-based course on marine biology for teenagers',
    description: 'A six week live course where students analyse tide pool data collected by local volunteers.',
    mechanism: 'Live cohort sessions with a shared dataset and peer review',
    targetUser: 'Teenagers interested in marine science',
    problem: 'Schools lack access to real field data',
    category: 'education',
  });
  assert.deepEqual(index.findSimilar(unrelated, { limit: 5 }), []);
});

test('near-duplicates are marked, never deleted', () => {
  const index = new SimilarityIndex();
  index.add(idea({ id: 'a' }));
  const found = index.findSimilar(idea({ id: 'b' }), { limit: 5 });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'a', 'the twin is reported, and both records stay in the bank');
});

test('jaccard basics', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.ok(Math.abs(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])) - 1 / 3) < 1e-9);
});

test('content key is stable across wording noise but changes with meaning', () => {
  const k1 = ideaContentKey(idea({ id: 'x' }));
  const k2 = ideaContentKey(idea({ id: 'y', title: 'Invoice  extraction   copilot for dental practices!' }));
  const k3 = ideaContentKey(idea({ id: 'z', title: 'Something else entirely', description: 'Different description here' }));
  assert.equal(k1, k2, 'id and punctuation must not change the content key');
  assert.notEqual(k1, k3);
});

test('the index stays bounded', () => {
  const index = new SimilarityIndex({ maxScan: 10 });
  for (let i = 0; i < 40; i++) index.add(idea({ id: `i${i}`, title: `idea number ${i} about something` }));
  assert.equal(index.size(), 10);
});
