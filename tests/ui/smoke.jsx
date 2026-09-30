/**
 * UI render smoke test entry.
 *
 * Bundled and executed by tests/ui.test.js. Renders every real component with
 * realistic API fixtures using react-dom/server, which catches the class of bug
 * that is otherwise invisible without a browser: a component reading a field
 * the server never sends, or crashing on a null score mid-generation.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';

import App from '../../web/src/App.jsx';
import TopBar from '../../web/src/components/TopBar.jsx';
import FilterPanel from '../../web/src/components/FilterPanel.jsx';
import IdeaWall from '../../web/src/components/IdeaWall.jsx';
import IdeaCard from '../../web/src/components/IdeaCard.jsx';
import IdeaDetail from '../../web/src/components/IdeaDetail.jsx';
import KnowledgePanel from '../../web/src/components/KnowledgePanel.jsx';
import BiasPanel from '../../web/src/components/BiasPanel.jsx';
import StatsPanel from '../../web/src/components/StatsPanel.jsx';
import PipelineStrip from '../../web/src/components/PipelineStrip.jsx';
import SettingsPanel from '../../web/src/components/SettingsPanel.jsx';
import { ScoreBadge, FactorMini, FactorTable, ScoreRamp } from '../../web/src/components/Score.jsx';
import { scoreColor } from '@shared/scoring.js';
import * as F from './fixtures.js';

const noop = () => {};
const noopAsync = async () => {};
let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

const has = (html, ...needles) => {
  for (const n of needles) {
    assert.ok(html.includes(n), `expected markup to contain "${n}"`);
  }
};

check('ScoreBadge renders the exact colour for the exact score', () => {
  const a = renderToStaticMarkup(<ScoreBadge score={6.0} />);
  const b = renderToStaticMarkup(<ScoreBadge score={6.9} />);
  has(a, scoreColor(6).css.replace(/hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)/, (m, h, s, l) => `hsl(${h} ${s}% ${l}%)`));
  assert.notEqual(a, b, '6.0 and 6.9 must render differently');
  has(renderToStaticMarkup(<ScoreBadge score={7.4} />), '7.4');
  has(renderToStaticMarkup(<ScoreBadge score={null} pending />), '/10');
});

check('FactorMini and FactorTable render all factors', () => {
  const mini = renderToStaticMarkup(<FactorMini factors={F.card.factors} keys={['novelty', 'usefulness', 'feasibility', 'monetization', 'marketPotential']} />);
  has(mini, '7.1', '8.8');
  const table = renderToStaticMarkup(
    <FactorTable factors={F.card.factors} justifications={F.detail.idea.evaluation.justifications} adjustments={F.card.adjustments} evidence={F.detail.idea.evaluation.evidence} />,
  );
  has(table, 'Novelty', 'Technical difficulty', 'lowered from 6.2', 'weak-evidence');
});

check('ScoreRamp is a continuous gradient', () => {
  const html = renderToStaticMarkup(<ScoreRamp steps={20} />);
  assert.equal((html.match(/<i /g) || []).length, 20);
  has(html, '1 broken', '8+ rare');
});

check('IdeaCard shows title, exact score colour, factors, strength, weakness and the why-not-higher line', () => {
  const html = renderToStaticMarkup(<IdeaCard card={F.card} onOpen={noop} onStar={noop} selected={false} />);
  has(html, 'Interactive API Documentation Sandbox', 'High developer usefulness.', 'Existing documentation platforms create competition.');
  has(html, 'this higher', 'Similar products already exist');
  has(html, 'Developer tools', '★', 'similar');
  assert.ok(html.includes('--card-color') || html.includes('hsl('), 'card must carry its score colour');
});

check('IdeaCard renders an unscored idea without crashing', () => {
  const html = renderToStaticMarkup(<IdeaCard card={F.pendingCard} onOpen={noop} onStar={noop} selected={false} />);
  has(html, 'Still being evaluated', 'evaluating');
});

check('IdeaCard flags near-duplicates and calibration adjustments', () => {
  const dup = renderToStaticMarkup(<IdeaCard card={F.weakCard} onOpen={noop} onStar={noop} selected={false} />);
  has(dup, 'duplicate', '3.4');
  const adjusted = renderToStaticMarkup(<IdeaCard card={F.card} onOpen={noop} onStar={noop} selected={false} />);
  has(adjusted, 'adj');
});

check('IdeaWall renders a grid of cards and an empty state', () => {
  const html = renderToStaticMarkup(
    <IdeaWall items={[F.card, F.weakCard, F.pendingCard]} loading={false} onOpen={noop} onStar={noop} selectedId={null} density="comfortable" onGenerate={noop} />,
  );
  has(html, 'class="wall', 'Interactive API Documentation Sandbox', 'AI chatbot for recipe ideas', 'end · 3 ideas');
  const empty = renderToStaticMarkup(<IdeaWall items={[]} loading={false} onOpen={noop} onStar={noop} selectedId={null} onGenerate={noop} />);
  has(empty, 'No ideas match this view', 'Generate 10 ideas');
});

check('the pipeline strip shows generation and review as separate stages', () => {
  const html = renderToStaticMarkup(
    <PipelineStrip
      stats={F.stats}
      reviews={F.reviews}
      generating
      onPauseReviews={noop}
      onResumeReviews={noop}
      onClearReviews={noop}
      onRequeueReviews={noop}
    />,
  );
  has(html, 'pipeline-strip', 'generating', 'awaiting review', 'reviewed/min', '31.4', '12.6');
  has(html, '9', 'avg wait', 'pause review', 'cap 120');
  assert.ok(!html.includes('throttled — review'), 'a healthy queue does not warn');
});

check('the pipeline strip warns when review falls behind or is paused', () => {
  const throttled = renderToStaticMarkup(
    <PipelineStrip stats={F.stats} reviews={F.reviewsThrottled} generating onPauseReviews={noop} onResumeReviews={noop} onClearReviews={noop} onRequeueReviews={noop} />,
  );
  has(throttled, 'tone-bad', 'generation throttled', 'clear backlog');

  const paused = renderToStaticMarkup(
    <PipelineStrip stats={F.stats} reviews={F.reviewsPaused} generating={false} onPauseReviews={noop} onResumeReviews={noop} onClearReviews={noop} onRequeueReviews={noop} />,
  );
  has(paused, 'tone-warn', 'review paused', 'resume review', 'generator idle');

  const caught = renderToStaticMarkup(
    <PipelineStrip stats={F.stats} reviews={{ ...F.reviews, depth: 0, active: 0, avgWaitMs: 900 }} generating={false} onPauseReviews={noop} onResumeReviews={noop} onClearReviews={noop} onRequeueReviews={noop} />,
  );
  has(caught, 'review is idle');
});

check('pending ideas render as awaiting review rather than as broken cards', () => {
  const queued = renderToStaticMarkup(<IdeaCard card={{ ...F.pendingCard, scoringState: 'queued' }} onOpen={noop} onStar={noop} />);
  has(queued, 'queued for evaluation', 'pending');
  const scoring = renderToStaticMarkup(<IdeaCard card={F.pendingCard} onOpen={noop} onStar={noop} />);
  has(scoring, 'evaluating');
});

check('TopBar exposes provider, model, mode, category, generation controls and live stats', () => {
  const html = renderToStaticMarkup(
    <TopBar
      providers={F.providers}
      models={F.models}
      health={F.health}
      settings={F.settings}
      stats={F.stats}
      calibration={F.calibration}
      job={F.job}
      panel="lab"
      setPanel={noop}
      onPatch={noopAsync}
      onGenerate={noopAsync}
      onPause={noop}
      onResume={noop}
      onStop={noop}
      onRefreshModels={noopAsync}
      busy={false}
    />,
  );
  has(html, 'IdeaLab', 'Ollama (local models)', 'qwen3:1.7b', 'llama3.2:3b', 'gemma3:1b', 'Fast', 'Deep', 'Generate 1', 'Generate 10', 'Generate 50', 'Pause', 'Stop');
  has(html, 'ideas/min', 'useful/min', 'avg score', '≥7', '≥8', '≥9', 'calibration');
  has(html, 'Knowledge Bank', 'Bias', 'Performance', 'Settings');
  has(html, '18/50', 'Any');
});

check('TopBar renders with no settings, no models and no stats (first paint)', () => {
  const html = renderToStaticMarkup(
    <TopBar providers={[]} models={{ models: [], active: null }} health={null} settings={null} stats={null} calibration={null} job={null} panel="lab" setPanel={noop} onPatch={noopAsync} onGenerate={noopAsync} onPause={noop} onResume={noop} onStop={noop} onRefreshModels={noopAsync} busy={false} />,
  );
  has(html, 'IdeaLab', 'loading');
});

check('FilterPanel offers every documented filter', () => {
  const html = renderToStaticMarkup(
    <FilterPanel
      filters={{ q: '', category: 'all', status: 'all', tag: '', starred: false, hideDuplicates: false, hideArchived: true, sort: 'overall', dir: 'desc', min: { novelty: 8 } }}
      onChange={noop}
      distribution={F.distribution}
      tags={['api', 'devtools']}
      calibration={F.calibration}
      counts={F.distribution}
      onReset={noop}
    />,
  );
  has(html, 'Minimum scores', 'Novelty', 'Usefulness', 'Feasibility', 'Monetization', 'Market potential', 'AI leverage', 'Overall score');
  has(html, 'Most unusual', 'Hide near-duplicates', 'Starred only', 'Hide archived', 'Score distribution');
  has(html, '#api', 'value="8"');
});

check('IdeaDetail shows the full exploration view', () => {
  const html = renderToStaticMarkup(
    <IdeaDetail detail={F.detail} weights={F.settings.scoring.weights} runningAction={null} onClose={noop} onAction={noopAsync} onPatch={noopAsync} onOpenIdea={noop} />,
  );
  has(html, 'Interactive API Documentation Sandbox', 'The idea', 'Core mechanism', 'Potential customers', 'Business model', 'Distribution');
  has(html, 'Brutal evaluation', 'Biggest strength', 'Biggest weakness', 'this a 9?', 'Score maths (deterministic)');
  has(html, 'Improve', 'Mutate', 'Attack', 'Develop', 'Research', 'Re-evaluate');
  has(html, 'Kill shot', 'Fatal flaws', 'Unit economics', 'MVP plan', 'Build steps', 'First customers', 'Research preparation');
  has(html, 'Postman', 'unverified', 'IdeaLab did not search the web');
  has(html, 'Notes &amp; tags', 'Provenance', 'Similar ideas in the bank', 'Re-evaluation history', 'Mutations');
  has(html, 'lowered by the evidence guards');
});

check('IdeaDetail survives an idea with no evaluation and no analysis', () => {
  const html = renderToStaticMarkup(
    <IdeaDetail
      detail={{ idea: { id: 'x', title: 'Fresh idea', description: 'Not scored yet', category: 'software', scoringState: 'queued', tags: [], similar: [], analysis: {} }, similar: [], children: [], parent: null, weights: F.settings.scoring.weights }}
      weights={F.settings.scoring.weights}
      runningAction="attack"
      onClose={noop}
      onAction={noopAsync}
      onPatch={noopAsync}
      onOpenIdea={noop}
    />,
  );
  has(html, 'Fresh idea', 'awaiting evaluation', '… Attack');
});

check('KnowledgePanel shows gating state', () => {
  const html = renderToStaticMarkup(
    <KnowledgePanel knowledge={F.knowledge} onExtract={noopAsync} onPromote={noopAsync} onDelete={noopAsync} onAdd={noopAsync} extracting={false} />,
  );
  has(html, 'Knowledge Bank', 'Repetitive manual data entry', 'OCR and document parsing');
  has(html, 'verified', 'candidate', 'unverified', 'quarantined', 'Extract from recent ideas');
  has(html, 'dollar figure', 'used 7×', 'evidence 1');
});

check('BiasPanel shows concentration, flags and directives', () => {
  const html = renderToStaticMarkup(<BiasPanel bias={F.bias} onAnalyze={noopAsync} onReset={noopAsync} analyzing={false} />);
  has(html, 'Anti-bias monitor', 'AI-centric share', 'Category concentration', 'Herfindahl');
  has(html, 'At most 1 in 5 ideas', 'Meta-analyzer', 'Overused mechanism vocabulary', 'extraction');
});

check('StatsPanel reports the metrics that matter', () => {
  const html = renderToStaticMarkup(
    <StatsPanel stats={F.stats} calibration={F.calibration} distribution={F.distribution} evalCache={F.evalCache} model="qwen3:1.7b" provider={{ id: 'ollama' }} reviews={F.reviews} onReset={noopAsync} />,
  );
  has(html, 'Useful ideas / minute', 'Generated / minute', 'Reviewed / minute', 'Average generation', 'Average evaluation', 'Average score');
  // the two stages are reported separately, with the queue state between them
  has(html, '31.4', '12.6', '7 waiting', '2 in flight', 'avg wait 4.2s');
  has(html, 'Model comparison', 'qwen3:1.7b', 'llama3.2:3b', 'Calibration health', 'Score colour ramp');
  has(html, '84 entries', '6 hits');
});

check('SettingsPanel exposes weights, throughput and calibration controls', () => {
  const html = renderToStaticMarkup(<SettingsPanel settings={F.settings} onPatch={noopAsync} onReset={noopAsync} health={F.health} onPreload={noopAsync} onUnload={noopAsync} />);
  has(html, 'Ollama host', 'http://127.0.0.1:11434', 'keep_alive', 'Disable thinking');
  has(html, 'Ideas per generation call', 'Concurrent review workers', 'Max review backlog', 'num_ctx', 'Temperature');
  has(html, 'Score weights', 'Live score calculator', 'Technical difficulty', 'restore default weights');
  has(html, 'Enforce evidence for high scores', 'Novelty ≥ 7 requires named prior art', 'Auto-strictness');
});

check('App renders its first paint with nothing loaded yet', () => {
  const html = renderToStaticMarkup(<App />);
  has(html, 'IdeaLab', 'Generate 10', 'No ideas match this view');
});

console.log(`\n${checks - failures}/${checks} UI render checks passed`);
if (failures) process.exit(1);
