'use client';

// "Paste a song": a link that scrolls to the home form and focuses its input. Used by the footer.
// (Moved out of DemoArt.tsx when the home page's drawn demos were removed, A4 2026-11-21.)
export function ToInputLink({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <a
      className={className}
      href="/#tool"
      onClick={(e) => {
        const tool = document.getElementById('tool');
        if (!tool) return; // not on the home page: follow the link
        e.preventDefault();
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        tool.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        const picked = document.getElementById('picked');
        const target =
          picked && !picked.hidden
            ? document.getElementById('picked-replace')
            : (document.getElementById('source') ?? document.getElementById('file-btn'));
        target?.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}
