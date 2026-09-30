import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeBank, detectClaims } from '../server/src/knowledge/bank.js';
import { JsonStore } from '../server/src/lib/store.js';
import { SEED_ENTRIES } from '../server/src/knowledge/seed.js';

function freshBank() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idealab-kb-'));
  const store = new JsonStore('knowledge', { entries: [], version: 1 });
  store.file = path.join(dir, 'knowledge.json');
  store.load();
  return new KnowledgeBank(store);
}

test('the seed bank loads with the required component kinds', () => {
  const bank = freshBank();
  const stats = bank.stats();
  assert.ok(stats.total >= 50, `expected a substantial seed bank, got ${stats.total}`);
  for (const kind of ['problem', 'technology', 'business-model', 'distribution', 'monetization', 'audience']) {
    assert.ok(bank.usable(kind).length >= 5, `kind ${kind} should be seeded`);
  }
  assert.ok(stats.byStatus.verified === stats.total, 'seed entries start verified');
});

test('seed entries carry the required metadata', () => {
  for (const e of SEED_ENTRIES) {
    assert.ok(e.name && e.description && e.kind, `entry missing fields: ${JSON.stringify(e)}`);
    assert.ok(Array.isArray(e.examples), `${e.name} needs examples`);
    assert.ok(Array.isArray(e.strengths) && e.strengths.length, `${e.name} needs strengths`);
    assert.ok(Array.isArray(e.weaknesses) && e.weaknesses.length, `${e.name} needs weaknesses`);
  }
});

test('claims without a source are detected', () => {
  assert.deepEqual(detectClaims({ description: 'The market is worth $2.3B and growing 40% a year' }).length >= 2, true);
  assert.deepEqual(detectClaims({ description: 'Proven to reduce churn' }), ['unsubstantiated proof claim']);
  assert.equal(detectClaims({ description: 'Parses scanned invoices into structured records' }).length, 0);
});

test('extracted components without traceable evidence are rejected', () => {
  const bank = freshBank();
  const before = bank.stats().total;
  const out = bank.ingest(
    {
      problems: [{ name: 'Vague inefficiency', description: 'A problem nobody in the batch actually mentioned.', evidence: { ideaIds: ['ghost'] } }],
      technologies: [], businessModels: [], distribution: [], monetization: [], audiences: [],
    },
    ['idea-1'],
  );
  assert.equal(out.accepted.length, 0);
  assert.match(out.rejected[0].reason, /no evidence/);
  assert.equal(bank.stats().total, before);
});

test('claim-laden extractions are quarantined, not added to the usable pool', () => {
  const bank = freshBank();
  const out = bank.ingest(
    {
      monetization: [
        {
          name: 'Enterprise outcome pricing',
          description: 'The outcome pricing market is worth $2.3B and proven to grow 40% yearly.',
          evidence: { ideaIds: ['idea-1'] },
        },
      ],
      problems: [], technologies: [], businessModels: [], distribution: [], audiences: [],
    },
    ['idea-1'],
  );
  assert.equal(out.accepted.length, 0);
  assert.match(out.rejected[0].reason, /quarantined/);
  const quarantined = bank.list({ status: 'unverified' });
  assert.equal(quarantined.length, 1);
  assert.ok(quarantined[0].claimFlags.length > 0);
  assert.ok(!bank.usable('monetization').some((e) => e.name === 'Enterprise outcome pricing'), 'quarantined entries must never reach a prompt');
});

test('a supported extraction becomes a candidate, then verified on second support', () => {
  const bank = freshBank();
  const first = bank.ingest(
    {
      problems: [
        {
          name: 'Manual re-keying of shipping documents',
          description: 'Freight staff retype document fields between systems that do not integrate.',
          examples: ['bill of lading entry'],
          evidence: { ideaIds: ['idea-1'] },
        },
      ],
      technologies: [], businessModels: [], distribution: [], monetization: [], audiences: [],
    },
    ['idea-1'],
  );
  assert.equal(first.accepted.length, 1);
  const entry = bank.findByName('Manual re-keying of shipping documents', 'problem');
  assert.equal(entry.status, 'candidate', 'a single observation is not knowledge yet');
  assert.ok(!bank.usable('problem').some((e) => e.id === entry.id), 'candidates must not seed generation');

  const second = bank.ingest(
    {
      problems: [{ name: 'Manual re-keying of shipping documents', description: 'same block seen again', evidence: { ideaIds: ['idea-2'] } }],
      technologies: [], businessModels: [], distribution: [], monetization: [], audiences: [],
    },
    ['idea-2'],
  );
  assert.deepEqual(second.promoted, ['Manual re-keying of shipping documents']);
  const promoted = bank.findByName('Manual re-keying of shipping documents', 'problem');
  assert.equal(promoted.status, 'verified');
  assert.equal(promoted.supportCount, 2);
  assert.ok(bank.usable('problem').some((e) => e.id === promoted.id));
});

test('a human can promote a quarantined entry by supplying a source', () => {
  const bank = freshBank();
  const { entry } = bank.add(
    { kind: 'problem', name: 'Cold chain spoilage', description: 'The market loses 15% of produce to temperature excursions.' },
    { origin: 'manual', status: 'verified' },
  );
  assert.equal(entry.status, 'unverified', 'an unsourced statistic must be quarantined');
  const promoted = bank.promote(entry.id, { byUser: true, source: 'FAO food loss report, cited by the user' });
  assert.equal(promoted.status, 'verified');
});

test('recombination sampling returns verified components across kinds', () => {
  const bank = freshBank();
  let combosWithFour = 0;
  const touched = new Set();
  for (let i = 0; i < 60; i++) {
    const { combo, entries } = bank.sampleCombo(() => (i % 7) / 7);
    const keys = Object.keys(combo);
    if (keys.length >= 4) combosWithFour++;
    for (const e of entries) touched.add(e.id);
    for (const e of entries) assert.equal(e.status, 'verified');
  }
  assert.ok(combosWithFour > 40, 'most sampled combos should mix several kinds');
  assert.ok(touched.size > 12, 'sampling should spread across the bank rather than repeat a few blocks');
});

test('usage is recorded so sampling can explore underrused blocks', () => {
  const bank = freshBank();
  const { entries } = bank.sampleCombo(Math.random);
  bank.recordUsage(entries);
  const after = entries.map((e) => bank.get(e.id).usageCount);
  assert.ok(after.every((n) => n >= 1));
});

test('duplicate names merge instead of piling up', () => {
  const bank = freshBank();
  const before = bank.stats().total;
  const a = bank.add({ kind: 'problem', name: 'Slow expert access', description: 'already seeded' });
  assert.equal(a.created, false);
  assert.equal(bank.stats().total, before);
});
