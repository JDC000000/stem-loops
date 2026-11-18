'use client';

// The full-screen layer the home page's demo opens (HomeDemo.tsx). Loaded only on the
// Play tap (next/dynamic), so the home page carries none of the player's code until then.
//
// It is portalled to <body> so the player's own <main> is not nested inside the page's,
// and while it is open everything else on the page is `inert` and aria-hidden: one main
// landmark, one tab order, no scrolling the page behind the player.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import JobView from '@/app/jobs/[id]/JobView';

export default function DemoPlayerLayer({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'demo-layer';
    el.setAttribute('data-testid', 'home-demo-layer');
    document.body.appendChild(el);
    const others = Array.from(document.body.children).filter((c) => c !== el) as HTMLElement[];
    const prior = others.map((c) => [c.hasAttribute('inert'), c.getAttribute('aria-hidden')] as const);
    for (const c of others) {
      c.setAttribute('inert', '');
      c.setAttribute('aria-hidden', 'true');
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setHost(el);
    return () => {
      others.forEach((c, i) => {
        const [wasInert, hidden] = prior[i];
        if (!wasInert) c.removeAttribute('inert');
        if (hidden === null) c.removeAttribute('aria-hidden');
        else c.setAttribute('aria-hidden', hidden);
      });
      document.body.style.overflow = overflow;
      el.remove();
    };
  }, []);

  if (!host) return null;
  return createPortal(<JobView id={jobId} signedIn={false} onBack={onClose} />, host);
}
