import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectEvents } from './api.js';
import { useIdeaStore, useDebounced } from './lib/ideaStore.js';
import TopBar from './components/TopBar.jsx';
import PipelineStrip from './components/PipelineStrip.jsx';
import FilterPanel from './components/FilterPanel.jsx';
import IdeaWall from './components/IdeaWall.jsx';
import IdeaDetail from './components/IdeaDetail.jsx';
import KnowledgePanel from './components/KnowledgePanel.jsx';
import BiasPanel from './components/BiasPanel.jsx';
import StatsPanel from './components/StatsPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { scoreColor } from '@shared/scoring.js';

const DEFAULT_FILTERS = {
  q: '',
  category: 'all',
  status: 'all',
  tag: '',
  starred: false,
  hideDuplicates: false,
  hideArchived: true,
  sort: 'overall',
  dir: 'desc',
  min: {},
};

const factorValue = (card, key) => {
  if (key === 'overall') return card.overall ?? -1;
  if (key === 'unusualness') return card.unusualness ?? -1;
  return card.factors?.[key] ?? -1;
};

const COMPARATORS = {
  overall: (a, b) => factorValue(b, 'overall') - factorValue(a, 'overall'),
  novelty: (a, b) => factorValue(b, 'novelty') - factorValue(a, 'novelty'),
  usefulness: (a, b) => factorValue(b, 'usefulness') - factorValue(a, 'usefulness'),
  monetization: (a, b) => factorValue(b, 'monetization') - factorValue(a, 'monetization'),
  market: (a, b) => factorValue(b, 'marketPotential') - factorValue(a, 'marketPotential'),
  feasibility: (a, b) => factorValue(b, 'feasibility') - factorValue(a, 'feasibility'),
  newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  unusual: (a, b) => (b.unusualness || 0) - (a.unusualness || 0),
  hardest: (a, b) => factorValue(b, 'technicalDifficulty') - factorValue(a, 'technicalDifficulty'),
};

const deepMerge = (base, patch) => {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch === undefined ? base : patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
};

export default function App() {
  const store = useIdeaStore();
  const { upsert, loadMany } = store;
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState({ models: [], active: null });
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [bias, setBias] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [panel, setPanel] = useState('lab');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [runningAction, setRunningAction] = useState(null);
  const [toast, setToast] = useState(null);
  const [loaded, setLoaded] = useState(0);
  const [serverTotal, setServerTotal] = useState(0);
  const [bootError, setBootError] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const selectedRef = useRef(null);
  selectedRef.current = selectedId;
  const toastTimer = useRef(null);
  const debouncedQ = useDebounced(filters.q, 200);

  const say = useCallback((message, bad = false) => {
    setToast({ message, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  // ---------------------------------------------------------------- loading
  const refreshDetail = useCallback(async (id) => {
    if (!id) return;
    try {
      setDetail(await api.idea(id));
    } catch (err) {
      /* idea may have been deleted */
    }
  }, []);

  const loadIdeas = useCallback(
    async (limit = 1500) => {
      try {
        const data = await api.ideas({ limit, sort: 'newest', hideArchived: 0 });
        loadMany(data.items);
        setLoaded(data.items.length);
        setServerTotal(data.total);
      } catch (err) {
        setBootError(err.message);
      }
    },
    [loadMany],
  );

  useEffect(() => {
    (async () => {
      try {
        const [s, p, m, st, b, rv] = await Promise.all([
          api.settings(),
          api.providers(),
          api.models().catch(() => ({ models: [], active: null })),
          api.stats().catch(() => null),
          api.bias().catch(() => null),
          api.reviews().catch(() => null),
        ]);
        setSettings(s.settings);
        setProviders(p.providers);
        setModels(m);
        if (st) {
          setStats(st.stats);
          setCalibration(st.calibration);
        }
        setBias(b);
        if (rv) setReviews(rv);
        await loadIdeas();
        api.health().then(setHealth).catch(() => {});
        api.knowledge().then(setKnowledge).catch(() => {});
        api.jobs().then((j) => {
          setJobs(j.jobs);
          setActiveJob(j.active);
        }).catch(() => {});
      } catch (err) {
        setBootError(err.message);
      }
    })();
  }, [loadIdeas]);

  // ------------------------------------------------------------- live feed
  useEffect(() => {
    const stop = connectEvents({
      'idea:new': (p) => upsert(p.card),
      'idea:scored': (p) => {
        upsert(p.card);
        if (p.card?.id === selectedRef.current) refreshDetail(p.card.id);
      },
      'idea:updated': (p) => {
        upsert(p.card);
        setRunningAction(null);
        if (p.card?.id === selectedRef.current) refreshDetail(p.card.id);
      },
      'review:queued': (p) => setReviews((prev) => ({ ...(prev || {}), ...p })),
      'review:start': (p) => setReviews((prev) => ({ ...(prev || {}), ...p })),
      'review:done': (p) => {
        setReviews((prev) => ({ ...(prev || {}), depth: p?.depth ?? prev?.depth, active: p?.active ?? prev?.active }));
        if (p && !p.ok && !p.aborted && p.error) say(`Review failed: ${p.error}`, true);
      },
      'review:paused': (p) => setReviews((prev) => ({ ...(prev || {}), ...p, paused: true })),
      'review:resumed': (p) =>
        setReviews((prev) => {
          const next = { ...(prev || {}), ...p, paused: false };
          if (next.maxDepth) next.throttled = (next.depth ?? 0) >= next.maxDepth;
          return next;
        }),
      'review:throttled': (p) => {
        setReviews((prev) => ({ ...(prev || {}), ...p, throttled: true }));
        say('Generation throttled: the review backlog hit its cap', true);
      },
      'review:cleared': (p) => {
        setReviews((prev) => ({ ...(prev || {}), depth: 0, throttled: false }));
        if (p?.dropped) say(`Dropped ${p.dropped} ideas from the review queue (they stay on the wall, unscored)`);
      },
      'review:rehydrated': (p) => {
        if (p?.count) say(`Re-queued ${p.count} unreviewed ideas from the previous session`);
        api.reviews().then(setReviews).catch(() => {});
      },
      snapshot: (p) => {
        if (p.reviews) setReviews(p.reviews);
        setStats(p.stats);
        setCalibration(p.calibration);
        setSettings(p.settings);
        setJobs(p.jobs || []);
        setActiveJob(p.activeJob || null);
        if (p.knowledge) setKnowledge((prev) => ({ ...(prev || { entries: [] }), stats: p.knowledge }));
      },
      'job:update': (p) => {
        setActiveJob(p);
        setJobs((prev) => {
          const next = prev.filter((j) => j.id !== p.id);
          return [p, ...next].slice(0, 20);
        });
        if (p.status === 'error' && p.error) say(`Job failed: ${p.error}`, true);
      },
      'job:error': (p) => say(`Generation error: ${p.error}`, true),
      stats: (p) => setStats(p),
      calibration: (p) => setCalibration(p),
      'bias:update': () => api.bias().then(setBias).catch(() => {}),
      'knowledge:update': () => api.knowledge().then(setKnowledge).catch(() => {}),
    });
    return stop;
  }, [upsert, refreshDetail, say]);

  // keep the provider/model picture fresh (models can be installed at any time)
  useEffect(() => {
    const t = setInterval(() => {
      api.health().then(setHealth).catch(() => {});
    }, 20000);
    return () => clearInterval(t);
  }, []);

  // the performance panel wants cache/distribution detail the SSE feed omits
  const [statsFull, setStatsFull] = useState(null);
  useEffect(() => {
    if (panel !== 'stats') return;
    let alive = true;
    const pull = () => api.stats().then((d) => alive && setStatsFull(d)).catch(() => {});
    pull();
    const t = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [panel]);

  const refreshModels = useCallback(async () => {
    const provider = settings?.provider;
    try {
      const m = await api.models(provider, true);
      setModels(m);
      if (m.error) say(m.error, true);
      else if (!m.models.length) say('Provider reported no installed models.', true);
      else say(`${m.models.length} model(s) available from ${provider}`);
      api.health().then(setHealth).catch(() => {});
    } catch (err) {
      say(err.message, true);
    }
  }, [settings?.provider, say]);

  // ---------------------------------------------------------------- actions
  const onPatch = useCallback(
    async (patch) => {
      // optimistic (deep) so the UI never feels laggy and nested keys survive
      setSettings((prev) => deepMerge(prev, patch));
      try {
        const out = await api.patchSettings(patch);
        setSettings(out.settings);
        if (patch.provider || patch.model) {
          const m = await api.models(out.settings.provider, true).catch(() => null);
          if (m) setModels(m);
        }
      } catch (err) {
        say(err.message, true);
      }
    },
    [say],
  );

  const onGenerate = useCallback(
    async ({ count, continuous }) => {
      try {
        const { job } = await api.startJob({
          count: count ?? 10,
          continuous: !!continuous,
          category: settings?.pipeline?.category || 'any',
          mode: settings?.pipeline?.mode || 'fast',
          model: settings?.model || undefined,
        });
        setActiveJob(job);
        setPanel('lab');
        say(
          continuous
            ? 'Continuous generation started — it will keep going until you stop it.'
            : `Generating ${count} idea${count > 1 ? 's' : ''} in ${settings?.pipeline?.mode || 'fast'} mode…`,
        );
      } catch (err) {
        say(err.message, true);
      }
    },
    [settings, say],
  );

  const reviewControl = useCallback(
    async (fn, okMessage) => {
      try {
        const out = await fn();
        if (out?.reviews) setReviews(out.reviews);
        else api.reviews().then(setReviews).catch(() => {});
        if (okMessage) say(okMessage);
      } catch (err) {
        say(err.message, true);
      }
    },
    [say],
  );

  const jobControl = useCallback(
    async (fn, id) => {
      try {
        const out = await fn(id);
        if (out?.job) setActiveJob(out.job);
      } catch (err) {
        say(err.message, true);
      }
    },
    [say],
  );

  const onStar = useCallback(
    async (card) => {
      try {
        const out = await api.patchIdea(card.id, { starred: !card.starred, status: !card.starred ? 'starred' : 'new' });
        upsert(out.idea);
        if (selectedRef.current === card.id) refreshDetail(card.id);
      } catch (err) {
        say(err.message, true);
      }
    },
    [upsert, refreshDetail, say],
  );

  const onOpenIdea = useCallback(
    async (id) => {
      setSelectedId(id);
      setRunningAction(null);
      try {
        setDetail(await api.idea(id));
      } catch (err) {
        say(err.message, true);
      }
    },
    [say],
  );

  const onAction = useCallback(
    async (id, action) => {
      setRunningAction(action);
      try {
        await api.action(id, action);
        say(`${action} queued — it runs through the same queue as generation`);
      } catch (err) {
        setRunningAction(null);
        say(err.message, true);
      }
    },
    [say],
  );

  const onPatchIdea = useCallback(
    async (id, patch) => {
      try {
        const out = await api.patchIdea(id, patch);
        upsert(out.idea);
        setDetail((d) => (d && d.idea.id === id ? { ...d, idea: { ...d.idea, ...patch } } : d));
      } catch (err) {
        say(err.message, true);
      }
    },
    [upsert, say],
  );

  const onExtract = useCallback(async () => {
    setExtracting(true);
    try {
      const out = await api.extractKnowledge(24);
      setKnowledge(await api.knowledge());
      const rej = (out.rejected || []).length;
      say(`Extracted ${out.accepted?.length || 0} building block(s)${out.promoted?.length ? `, promoted ${out.promoted.length}` : ''}${rej ? `, rejected ${rej} (gating)` : ''}`);
    } catch (err) {
      say(err.message, true);
    } finally {
      setExtracting(false);
    }
  }, [say]);

  const onAnalyzeBias = useCallback(async () => {
    setAnalyzing(true);
    try {
      await api.analyzeBias();
      setBias(await api.bias());
      say('Meta-analysis complete — directives will be injected into the next batch.');
    } catch (err) {
      say(err.message, true);
    } finally {
      setAnalyzing(false);
    }
  }, [say]);

  // ------------------------------------------------------------- filtering
  const visible = useMemo(() => {
    let list = [...store.ideas.values()];
    const q = debouncedQ.trim().toLowerCase();
    const min = filters.min || {};

    if (filters.hideArchived && filters.status === 'all') list = list.filter((c) => c.status !== 'archived');
    if (filters.category !== 'all') list = list.filter((c) => c.category === filters.category);
    if (filters.status !== 'all') list = list.filter((c) => (filters.status === 'starred' ? c.starred : c.status === filters.status));
    if (filters.starred) list = list.filter((c) => c.starred);
    if (filters.tag) list = list.filter((c) => (c.tags || []).includes(filters.tag));
    if (filters.hideDuplicates) list = list.filter((c) => !c.duplicateOf);
    if (q) {
      list = list.filter((c) =>
        [c.title, c.description, c.biggestWeakness, c.biggestStrength, c.summary].filter(Boolean).some((t) => String(t).toLowerCase().includes(q)),
      );
    }
    for (const [key, value] of Object.entries(min)) {
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) continue;
      list = list.filter((c) => factorValue(c, key) >= v);
    }
    const cmp = COMPARATORS[filters.sort] || COMPARATORS.overall;
    list.sort((a, b) => (filters.dir === 'asc' ? -cmp(a, b) : cmp(a, b)));
    return list;
  }, [store.ideas, filters, debouncedQ]);

  const distribution = useMemo(() => {
    const histogram = Array(10).fill(0);
    const byStatus = {};
    let scored = 0;
    let ge7 = 0;
    let ge8 = 0;
    let ge9 = 0;
    for (const c of store.ideas.values()) {
      byStatus[c.status || 'new'] = (byStatus[c.status || 'new'] || 0) + 1;
      if (c.overall == null) continue;
      scored++;
      histogram[Math.min(9, Math.max(0, Math.floor(c.overall) - 1))]++;
      if (c.overall >= 7) ge7++;
      if (c.overall >= 8) ge8++;
      if (c.overall >= 9) ge9++;
    }
    return { histogram, scored, ge7, ge8, ge9, count: store.ideas.size, byStatus };
  }, [store.ideas]);

  const tags = useMemo(() => {
    const set = new Set();
    for (const c of store.ideas.values()) for (const t of c.tags || []) set.add(t);
    return [...set].sort();
  }, [store.ideas]);

  // ------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        setSelectedId(null);
        setDetail(null);
      } else if (e.key === 'g') {
        onGenerate({ count: 10 });
      } else if (e.key === 'c') {
        onGenerate({ continuous: true });
      } else if (e.key === 'x') {
        jobControl(api.stopAll);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onGenerate, jobControl]);

  const provider = providers.find((p) => p.id === settings?.provider);
  const synthetic = provider?.synthetic;
  const unreachable = !synthetic && health && health.ollama?.reachable === false;
  const busy = !!activeJob && activeJob.status === 'running';

  return (
    <div className="app">
      <TopBar
        providers={providers}
        models={models}
        health={health}
        settings={settings}
        stats={stats}
        calibration={calibration}
        job={activeJob}
        panel={panel}
        setPanel={setPanel}
        onPatch={onPatch}
        onGenerate={onGenerate}
        onPause={() => jobControl(api.pauseJob, activeJob?.id)}
        onResume={() => jobControl(api.resumeJob, activeJob?.id)}
        onStop={() => jobControl(api.stopJob, activeJob?.id)}
        onRefreshModels={refreshModels}
        busy={false}
      />

      <PipelineStrip
        stats={stats}
        reviews={reviews}
        generating={!!activeJob && ['running', 'queued', 'paused'].includes(activeJob.status)}
        onPauseReviews={() => reviewControl(api.pauseReviews, 'Review paused - generation keeps going, ideas stay unscored')}
        onResumeReviews={() => reviewControl(api.resumeReviews, 'Review resumed')}
        onClearReviews={() => reviewControl(api.clearReviews)}
        onRequeueReviews={() => reviewControl(api.requeueReviews, 'Re-queued every unscored idea')}
      />

      <div className="main">
        {panel === 'lab' && (
          <FilterPanel
            open={sidebarOpen}
            filters={filters}
            onChange={setFilters}
            distribution={distribution}
            tags={tags}
            calibration={calibration}
            counts={distribution}
            onReset={() => setFilters(DEFAULT_FILTERS)}
          />
        )}

        <div className="content">
          {bootError && (
            <div className="banner bad">
              <span>
                <b>Cannot talk to the IdeaLab server:</b> {bootError}
              </span>
            </div>
          )}

          {unreachable && (
            <div className="banner bad">
              <span>
                <b>Ollama is not reachable at {settings?.ollama?.host}.</b> Start it with <span className="mono">ollama serve</span>, check the host in
                Settings, or{' '}
                <button className="btn sm" onClick={() => onPatch({ provider: 'demo' })}>
                  switch to the demo simulator
                </button>{' '}
                to explore IdeaLab without a model.
              </span>
            </div>
          )}

          {!unreachable && !synthetic && settings && models.models?.length === 0 && (
            <div className="banner">
              <span>
                <b>No models installed in Ollama.</b> Pull one first — e.g. <span className="mono">ollama pull qwen3:1.7b</span> (fast, good for volume) or{' '}
                <span className="mono">ollama pull llama3.2:3b</span> — then hit ⟳ next to the model picker.
              </span>
            </div>
          )}

          {synthetic && (
            <div className="banner info">
              <span>
                <b>Demo simulator active.</b> Ideas are synthetic templates and scores are simulated from a calibrated distribution. Everything else — the
                pipeline, brutal scoring, evidence guards, duplicate detection, bias monitor, Knowledge Bank gating — is the real thing.
                <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => onPatch({ provider: 'ollama' })}>
                  switch to Ollama
                </button>
              </span>
            </div>
          )}

          {panel === 'lab' && (
            <>
              <div className="wall-head">
                <span className="count">
                  {visible.length} idea{visible.length === 1 ? '' : 's'} in view
                  {serverTotal > loaded ? ` · ${loaded} of ${serverTotal} loaded` : ` · ${store.count} in the bank`}
                </span>
                {Object.entries(filters.min).filter(([, v]) => Number(v) > 0).map(([k, v]) => (
                  <span className="chip accent" key={k}>
                    {k} ≥ {v}
                  </span>
                ))}
                {filters.q && <span className="chip">“{filters.q}”</span>}
                {serverTotal > loaded && (
                  <button className="btn sm ghost" onClick={() => loadIdeas(serverTotal)}>
                    load all {serverTotal}
                  </button>
                )}
                <span className="grow" />
                <span className="legend">
                  <span><i style={{ background: scoreColor(3).css }} />3 weak</span>
                  <span><i style={{ background: scoreColor(5.5).css }} />5.5 ordinary</span>
                  <span><i style={{ background: scoreColor(7).css }} />7 strong</span>
                  <span><i style={{ background: scoreColor(8.5).css }} />8.5 rare</span>
                  <span><i style={{ background: scoreColor(9.6).css }} />9.6 exceptional</span>
                </span>
                <button className="btn sm ghost only-narrow" onClick={() => setSidebarOpen((v) => !v)}>
                  {sidebarOpen ? 'hide filters' : 'filters'}
                </button>
              </div>

              <IdeaWall
                items={visible}
                loading={busy}
                onOpen={onOpenIdea}
                onStar={onStar}
                selectedId={selectedId}
                density={settings?.ui?.density}
                onGenerate={onGenerate}
              />
            </>
          )}

          {panel === 'knowledge' && (
            <KnowledgePanel
              knowledge={knowledge}
              onExtract={onExtract}
              extracting={extracting}
              onPromote={async (id) => {
                try {
                  await api.promoteKnowledge(id);
                  setKnowledge(await api.knowledge());
                } catch (err) {
                  say(err.message, true);
                }
              }}
              onDelete={async (id) => {
                try {
                  await api.deleteKnowledge(id);
                  setKnowledge(await api.knowledge());
                } catch (err) {
                  say(err.message, true);
                }
              }}
              onAdd={async (entry) => {
                try {
                  const out = await api.addKnowledge(entry);
                  setKnowledge(await api.knowledge());
                  say(out.created ? `Added “${out.entry.name}” to the Knowledge Bank` : `“${out.entry.name}” was already in the bank`);
                } catch (err) {
                  say(err.message, true);
                }
              }}
            />
          )}

          {panel === 'bias' && (
            <BiasPanel
              bias={bias}
              onAnalyze={onAnalyzeBias}
              analyzing={analyzing}
              onReset={async () => {
                try {
                  await api.resetBias();
                  setBias(await api.bias());
                  say('Cached meta-analysis cleared');
                } catch (err) {
                  say(err.message, true);
                }
              }}
            />
          )}

          {panel === 'stats' && (
            <StatsPanel
              stats={stats}
              reviews={statsFull?.reviews || reviews}
              calibration={statsFull?.calibration || calibration}
              distribution={statsFull?.distribution || distribution}
              evalCache={statsFull?.evalCache}
              model={settings?.model || models?.active}
              provider={provider}
              onReset={async () => {
                const out = await api.resetStats();
                setStats(out.stats);
                say('Session counters reset');
              }}
            />
          )}

          {panel === 'settings' && (
            <SettingsPanel
              settings={settings}
              onPatch={onPatch}
              health={health}
              onReset={async () => {
                const out = await api.resetSettings();
                setSettings(out.settings);
                say('Settings restored to defaults');
              }}
              onPreload={async () => {
                const out = await api.preload(settings?.model || models?.active);
                say(out.ok ? 'Model weights loaded into memory' : `Preload failed: ${out.error}`);
              }}
              onUnload={async () => {
                const out = await api.unload(settings?.model || models?.active);
                say(out.ok ? 'Model unloaded from memory' : `Unload failed: ${out.error}`);
              }}
            />
          )}
        </div>
      </div>

      {selectedId && detail && (
        <IdeaDetail
          detail={detail}
          weights={settings?.scoring?.weights}
          runningAction={runningAction}
          onClose={() => {
            setSelectedId(null);
            setDetail(null);
          }}
          onAction={onAction}
          onPatch={onPatchIdea}
          onOpenIdea={onOpenIdea}
        />
      )}

      {toast && <div className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.message}</div>}
    </div>
  );
}
