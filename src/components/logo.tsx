export function Logo({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex items-center gap-2 font-semibold tracking-tight ${className}`}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Stemloop mark — three stacked bars forming a loop */}
        <rect x="2" y="9" width="3" height="6" rx="1" fill="currentColor" />
        <rect x="7" y="5" width="3" height="14" rx="1" fill="currentColor" />
        <rect x="12" y="7" width="3" height="10" rx="1" fill="currentColor" />
        <rect
          x="17"
          y="3"
          width="3"
          height="18"
          rx="1"
          fill="var(--accent)"
        />
      </svg>
      <span className="text-[17px]">stemloop</span>
    </div>
  );
}
