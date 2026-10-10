// One icon family: 24px grid, 1.5 stroke, currentColor. The sprite renders once per page;
// <Ic> references a symbol by id.
export type IconName = 'play' | 'stop' | 'check' | 'file' | 'alert' | 'x' | 'chev' | 'up' | 'down' | 'done';

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 } as const;

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" {...S} strokeLinejoin="round" /></symbol>
      <symbol id="i-stop" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1" {...S} strokeLinejoin="round" /></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" {...S} strokeLinecap="round" strokeLinejoin="round" /></symbol>
      <symbol id="i-file" viewBox="0 0 24 24"><path d="M7 3.5h6.5L18 8v12.5H7zM13.5 3.5V8H18" {...S} strokeLinejoin="round" /></symbol>
      <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" {...S} /><path d="M12 7.5v5.5M12 16v.5" {...S} strokeLinecap="round" /></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...S} strokeLinecap="round" /></symbol>
      <symbol id="i-chev" viewBox="0 0 24 24"><path d="M6.5 9.5l5.5 5.5 5.5-5.5" {...S} strokeLinecap="round" strokeLinejoin="round" /></symbol>
      <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5.5M6 11l6-6 6 6" {...S} strokeLinecap="round" strokeLinejoin="round" /></symbol>
      <symbol id="i-down" viewBox="0 0 24 24"><path d="M12 4.5V17M6 11.5l6 6 6-6M5 20.5h14" {...S} strokeLinecap="round" strokeLinejoin="round" /></symbol>
      <symbol id="i-done" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" {...S} /><path d="M8 12.5l2.75 2.75L16 10" {...S} strokeLinecap="round" strokeLinejoin="round" /></symbol>
    </svg>
  );
}

export function Ic({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`ic${className ? ` ${className}` : ''}`} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

// Mirrored waveform envelope (path from envPath), stretched to its box.
export function Wave({ d, variant }: { d: string; variant?: 'loop' | 'played' }) {
  const cls = variant === 'loop' ? 'wv is-loop' : variant === 'played' ? 'wv is-played' : 'wv';
  return (
    <svg className={cls} viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
