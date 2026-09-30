import React, { useEffect, useRef, useState } from 'react';
import IdeaCard from './IdeaCard.jsx';

const PAGE = 48;

/**
 * The wall of idea cards.
 *
 * Renders in pages: an IntersectionObserver sentinel grows the visible window
 * as the user scrolls, so a bank of thousands of ideas never costs thousands of
 * DOM nodes.
 */
export default function IdeaWall({ items, loading, onOpen, onStar, selectedId, density, onLoadMore, hasMore, onGenerate }) {
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // Reset the render window when the result set changes shape (new filter/sort).
  const signature = `${items.length}:${items[0]?.id || ''}:${density}`;
  const lastSig = useRef(signature);
  if (lastSig.current !== signature) {
    lastSig.current = signature;
    if (shown > PAGE) setShown(PAGE);
  }

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        // grow the visible window; ask for more data only when we run out
        setShown((s) => Math.min(items.length, s + PAGE));
        if (shownRef.current >= items.length) onLoadMore?.();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, onLoadMore]);


  if (!items.length && !loading) {
    return (
      <div className="empty">
        <h3>No ideas match this view</h3>
        <p className="small">
          Loosen the filters, or generate a batch. IdeaLab is built for volume: generate 50, keep the two that survive.
        </p>
        <div className="split" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button className="btn primary" onClick={() => onGenerate?.({ count: 10 })}>
            Generate 10 ideas
          </button>
        </div>
      </div>
    );
  }

  const visible = items.slice(0, shown);

  return (
    <>
      <div className={`wall ${density === 'compact' ? 'compact' : ''}`}>
        {visible.map((card) => (
          <IdeaCard key={card.id} card={card} onOpen={onOpen} onStar={onStar} selected={card.id === selectedId} />
        ))}
      </div>
      <div className="sentinel" ref={sentinel}>
        {shown < items.length ? `rendering ${shown} of ${items.length}…` : hasMore ? 'loading more…' : items.length ? `end · ${items.length} ideas` : ''}
      </div>
    </>
  );
}
