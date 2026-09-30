import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Idea store with batched updates.
 *
 * Continuous generation can emit dozens of events per second. Instead of one
 * React render per event, updates are coalesced into a single render every
 * ~110ms. Cards are keyed by id and wrapped in React.memo, so only the ideas
 * that actually changed touch the DOM.
 */
export function useIdeaStore() {
  const [ideas, setIdeas] = useState(() => new Map());
  const pending = useRef(new Map());
  const timer = useRef(null);
  const [revision, bump] = useState(0);

  const flush = useCallback(() => {
    timer.current = null;
    if (pending.current.size === 0) return;
    const batch = pending.current;
    pending.current = new Map();
    setIdeas((prev) => {
      const next = new Map(prev);
      for (const [id, card] of batch) {
        if (card === null) next.delete(id);
        else next.set(id, card);
      }
      return next;
    });
    bump((r) => r + 1);
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(flush, 110);
    timer.current.unref?.();
  }, [flush]);

  const upsert = useCallback(
    (card) => {
      if (!card?.id) return;
      pending.current.set(card.id, card);
      schedule();
    },
    [schedule],
  );

  const upsertMany = useCallback((cards) => {
    for (const c of cards) if (c?.id) pending.current.set(c.id, c);
    schedule();
  }, [schedule]);

  const loadMany = useCallback((cards) => {
    setIdeas((prev) => {
      const next = new Map(prev);
      for (const c of cards) next.set(c.id, c);
      return next;
    });
    bump((r) => r + 1);
  }, []);

  const remove = useCallback((id) => {
    pending.current.delete(id);
    setIdeas((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    pending.current.clear();
    setIdeas(new Map());
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Stable identity: consumers put these in dependency arrays, so the returned
  // object must not change on every render.
  return useMemo(
    () => ({ ideas, upsert, upsertMany, loadMany, remove, clear, revision, count: ideas.size }),
    [ideas, upsert, upsertMany, loadMany, remove, clear, revision],
  );
}

/** Debounce a changing value (used for the search box and filter refetches). */
export function useDebounced(value, ms = 220) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
