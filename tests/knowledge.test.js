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

test('a manual entry with an unsourced claim is quarantined at once', () => {
  const bank = freshBank();
  // The API stores manual entries without a source as 'candidate', and a candidate
  // is one evidence merge away from 'verified'.
  const { entry } = bank.add(
    { kind: 'monetization', name: 'Usage pricing for lab equipment', description: 'A $4B market growing 35% a year, obviously.' },
    { origin: 'manual', status: 'candidate' },
  );
  assert.equal(entry.status, 'unverified', 'quarantined rather than left promotable');
  assert.ok(entry.claimFlags.length > 0);
  assert.ok(!bank.usable('monetization').some((e) => e.id === entry.id));
});

test('legacy data cannot be laundered into the pool by new evidence', () => {
  // Entries written by an older build could sit at 'candidate' while carrying
  // unsourced claims. The merge path re-checks them, so stale data on disk cannot
  // be promoted into the components generation is seeded from.
  const bank = freshBank();
  const name = 'Legacy outcome pricing claim';
  bank.ingest(
    {
      problems: [], technologies: [], businessModels: [], distribution: [], audiences: [],
      monetization: [{ name, description: 'Charged against a measured outcome.', evidence: { ideaIds: ['idea-1'] } }],
    },
    ['idea-1'],
  );
  const legacy = bank.findByName(name, 'monetization');
  assert.equal(legacy.status, 'candidate');
  // emulate the pre-gate state: a candidate whose text carries an unsourced claim
  legacy.description = 'Worth $2.3B and growing 40% year over year.';
  legacy.claimFlags = detectClaims(legacy);
  assert.ok(legacy.claimFlags.length > 0, 'sanity: the claim is detectable');

  const out = bank.ingest(
    {
      problems: [], technologies: [], businessModels: [], distribution: [], audiences: [],
      monetization: [{ name, description: 'Seen again in a second idea.', evidence: { ideaIds: ['idea-2'] } }],
    },
    ['idea-2'],
  );
  const after = bank.findByName(name, 'monetization');
  assert.deepEqual(out.promoted, [], 'second corroboration does not promote it');
  assert.equal(after.status, 'unverified', 'it is quarantined instead');
  assert.match(out.rejected.map((r) => r.reason).join(' '), /quarantined on merge/, 'and the refusal is explained');
  assert.ok(!bank.usable('monetization').some((e) => e.id === after.id));
});

test('corroboration never promotes an entry carrying an unsourced claim', () => {
  const bank = freshBank();
  const name = 'Per-outcome pricing for compliance work';
  const extraction = (ideaId, description) => ({
    problems: [], technologies: [], businessModels: [], distribution: [], audiences: [],
    monetization: [{ name, description, evidence: { ideaIds: [ideaId] } }],
  });

  bank.ingest(extraction('idea-1', 'Charged against a measured compliance outcome.'), ['idea-1']);
  const entry = bank.findByName(name, 'monetization');
  assert.equal(entry.status, 'candidate', 'clean text from one idea is a candidate');

  // Someone edits a market number into it without citing anything.
  bank.update(entry.id, { description: 'Worth $2.3B and growing 40% year over year, proven by adoption data.' });
  assert.equal(bank.findByName(name, 'monetization').status, 'unverified', 'editing in an unsourced claim quarantines it');

  // A second idea corroborating the *component* must not launder the claim.
  const out = bank.ingest(extraction('idea-2', 'Seen again in a second idea.'), ['idea-2']);
  const after = bank.findByName(name, 'monetization');
  assert.equal(after.supportCount, 2, 'the evidence did merge');
  assert.equal(after.status, 'unverified', 'two ideas repeating a number is still not a source');
  assert.deepEqual(out.promoted, [], 'nothing was promoted');
  assert.ok(!bank.usable('monetization').some((e) => e.id === after.id), 'it must never seed a prompt');

  // Citing a real source is still the way out.
  assert.equal(bank.promote(after.id, { byUser: true, source: 'Gartner outcome-pricing survey, 2025' }).status, 'verified');
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
