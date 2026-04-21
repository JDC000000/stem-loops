"use client";

import { ButtonHTMLAttributes } from "react";

type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  label: string;
  sublabel?: string;
};

export function Chip({
  selected = false,
  label,
  sublabel,
  className = "",
  ...props
}: ChipProps) {
  return (
    <button
      type="button"
      data-selected={selected}
      className={`
        group relative px-4 py-3 rounded-md border text-left transition-all
        ${
          selected
            ? "bg-accent/10 border-accent text-foreground"
            : "bg-surface border-border text-muted hover:border-border-strong hover:text-foreground"
        }
        ${className}
      `}
      {...props}
    >
      <div className="flex items-center gap-2">
        <span
          className={`
            w-2 h-2 rounded-full transition-colors
            ${selected ? "bg-accent" : "bg-border-strong group-hover:bg-muted"}
          `}
        />
        <span className="font-medium text-sm">{label}</span>
      </div>
      {sublabel ? (
        <div className="mt-1 font-mono text-[11px] text-muted-2 pl-4">
          {sublabel}
        </div>
      ) : null}
    </button>
  );
}
