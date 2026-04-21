/**
 * Static decorative waveform SVG for the hero section.
 * Generated deterministically so it doesn't shift between server and client.
 */
export function Waveform({ className = "" }: { className?: string }) {
  const bars = 96;
  // Deterministic pseudo-random heights so SSR matches CSR
  const heights = Array.from({ length: bars }, (_, i) => {
    const x = i / bars;
    // Sum of sines gives a musical-looking profile
    const h =
      0.45 +
      0.35 * Math.sin(x * Math.PI * 6) +
      0.15 * Math.sin(x * Math.PI * 13 + 1.2) +
      0.12 * Math.sin(x * Math.PI * 27 + 2.4);
    return Math.max(0.08, Math.min(1, h));
  });

  return (
    <svg
      viewBox="0 0 960 160"
      className={className}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {heights.map((h, i) => {
        const barW = 6;
        const gap = 4;
        const x = i * (barW + gap);
        const barH = h * 140;
        const y = (160 - barH) / 2;
        // Highlight a ~4-bar region with the accent color
        const accent = i >= 40 && i < 56;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            rx={1.5}
            fill={accent ? "var(--accent)" : "var(--border-strong)"}
            opacity={accent ? 1 : 0.9}
          />
        );
      })}
    </svg>
  );
}
