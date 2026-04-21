"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Chip } from "./ui/chip";
import {
  ALL_STEMS,
  BAR_OPTIONS,
  BarCount,
  STEM_DESCRIPTIONS,
  STEM_LABELS,
  StemKind,
} from "@/lib/types";

const YT_REGEX =
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\/.+/i;

export function UrlForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [stems, setStems] = useState<StemKind[]>(["drums"]);
  const [bars, setBars] = useState<BarCount>(4);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleStem = (s: StemKind) => {
    setStems((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  };

  const validate = (): string | null => {
    if (!url.trim()) return "Paste a YouTube URL";
    if (!YT_REGEX.test(url.trim())) return "That doesn't look like a YouTube URL";
    if (stems.length === 0) return "Pick at least one stem";
    return null;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), stems, bars }),
      });
      if (res.status === 402) {
        // Payment / auth required — freemium wall hit
        router.push("/login?reason=limit");
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Something went wrong");
      }
      const data = (await res.json()) as { id: string };
      router.push(`/jobs/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="w-full max-w-3xl space-y-8">
      {/* URL input */}
      <div className="space-y-2">
        <label
          htmlFor="url"
          className="block text-xs uppercase tracking-widest text-muted font-mono"
        >
          YouTube URL
        </label>
        <Input
          id="url"
          type="url"
          placeholder="https://youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* Stem picker */}
      <div className="space-y-3">
        <label className="block text-xs uppercase tracking-widest text-muted font-mono">
          Stems
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {ALL_STEMS.map((s) => (
            <Chip
              key={s}
              label={STEM_LABELS[s]}
              sublabel={STEM_DESCRIPTIONS[s]}
              selected={stems.includes(s)}
              onClick={() => toggleStem(s)}
              disabled={submitting}
            />
          ))}
        </div>
      </div>

      {/* Bars picker */}
      <div className="space-y-3">
        <label className="block text-xs uppercase tracking-widest text-muted font-mono">
          Loop length
        </label>
        <div className="flex gap-2">
          {BAR_OPTIONS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBars(b)}
              disabled={submitting}
              className={`
                flex-1 h-12 rounded-md border font-mono text-sm transition-all
                ${
                  bars === b
                    ? "bg-accent/10 border-accent text-foreground"
                    : "bg-surface border-border text-muted hover:border-border-strong hover:text-foreground"
                }
              `}
            >
              {b} bar{b === 1 ? "" : "s"}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error ? (
        <div className="text-sm text-error font-mono">{error}</div>
      ) : null}

      {/* Submit */}
      <div className="pt-2">
        <Button
          type="submit"
          size="lg"
          disabled={submitting}
          className="w-full sm:w-auto"
        >
          {submitting ? "Starting…" : "Extract loops →"}
        </Button>
        <p className="mt-3 text-xs text-muted-2 font-mono">
          Free for your first 3 songs. No signup needed.
        </p>
      </div>
    </form>
  );
}
