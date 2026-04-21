"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  Job,
  JobStatus,
  STEM_LABELS,
  StemResult,
} from "@/lib/types";

const ACTIVE_STATUSES: JobStatus[] = [
  "queued",
  "downloading",
  "separating",
  "extracting",
];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

export function JobView({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
        if (!res.ok) {
          if (res.status === 404) {
            setError("Job not found.");
            return;
          }
          throw new Error("Network error");
        }
        const data = (await res.json()) as Job;
        if (cancelled) return;
        setJob(data);
        if (ACTIVE_STATUSES.includes(data.status)) {
          timer = setTimeout(poll, 1500);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
        timer = setTimeout(poll, 3000);
      }
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto max-w-5xl px-6 h-16 flex items-center justify-between">
          <Link href="/">
            <Logo />
          </Link>
          <Link
            href="/"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            ← New job
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-5xl px-6 py-16">
        {error && !job ? (
          <div className="rounded-md border border-error/40 bg-error/5 p-6">
            <div className="text-error font-semibold">Something went wrong</div>
            <div className="text-sm text-muted mt-1">{error}</div>
          </div>
        ) : !job ? (
          <SkeletonView />
        ) : job.status === "error" ? (
          <ErrorView job={job} />
        ) : job.status === "done" ? (
          <ResultsView job={job} />
        ) : (
          <ProgressView job={job} />
        )}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Skeleton / loading                                                        */
/* -------------------------------------------------------------------------- */
function SkeletonView() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 w-64 bg-surface rounded" />
      <div className="h-2 w-full bg-surface rounded" />
      <div className="h-48 w-full bg-surface rounded" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Error view                                                                */
/* -------------------------------------------------------------------------- */
function ErrorView({ job }: { job: Job }) {
  return (
    <div className="rounded-md border border-error/40 bg-error/5 p-8">
      <div className="font-mono text-xs uppercase tracking-widest text-error mb-3">
        /error
      </div>
      <h1 className="text-2xl font-semibold">Extraction failed</h1>
      <p className="text-sm text-muted mt-2 font-mono">
        {job.error ?? "Unknown error"}
      </p>
      <div className="mt-6">
        <Link href="/">
          <Button variant="secondary">Try another URL</Button>
        </Link>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Progress view                                                             */
/* -------------------------------------------------------------------------- */
function ProgressView({ job }: { job: Job }) {
  return (
    <div className="max-w-2xl">
      <div className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
        /status — {job.status}
      </div>
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
        {job.stage ?? "Working on it…"}
      </h1>
      <p className="mt-3 text-sm text-muted font-mono break-all">{job.url}</p>

      {/* Progress bar */}
      <div className="mt-10">
        <div className="flex items-center justify-between mb-3 font-mono text-xs text-muted">
          <span>PROGRESS</span>
          <span className="tabular text-foreground">{job.progress}%</span>
        </div>
        <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-700 ease-out"
            style={{ width: `${job.progress}%` }}
          />
        </div>
      </div>

      {/* Stage list */}
      <div className="mt-10 divide-y divide-border border-y border-border">
        {STAGE_LIST.map((s) => {
          const done = stageOrder(job.status) > stageOrder(s.key);
          const active = job.status === s.key;
          return (
            <div
              key={s.key}
              className="py-4 flex items-center gap-4 font-mono text-sm"
            >
              <span
                className={`
                  w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px]
                  ${
                    done
                      ? "bg-accent border-accent text-accent-ink"
                      : active
                        ? "border-accent text-accent animate-pulse"
                        : "border-border text-muted-2"
                  }
                `}
              >
                {done ? "✓" : ""}
              </span>
              <span
                className={
                  active
                    ? "text-foreground"
                    : done
                      ? "text-muted"
                      : "text-muted-2"
                }
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-xs text-muted-2 font-mono">
        This page will update automatically. You can keep it open or come back later.
      </p>
    </div>
  );
}

const STAGE_LIST: Array<{ key: JobStatus; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "downloading", label: "Downloading audio" },
  { key: "separating", label: "Separating stems (Demucs)" },
  { key: "extracting", label: "Extracting bar-aligned loops" },
  { key: "done", label: "Ready to download" },
];

function stageOrder(s: JobStatus): number {
  const order: Record<JobStatus, number> = {
    queued: 0,
    downloading: 1,
    separating: 2,
    extracting: 3,
    done: 4,
    error: -1,
  };
  return order[s];
}

/* -------------------------------------------------------------------------- */
/*  Results view                                                              */
/* -------------------------------------------------------------------------- */
function ResultsView({ job }: { job: Job }) {
  return (
    <div className="space-y-10">
      {/* Header */}
      <div>
        <div className="font-mono text-xs uppercase tracking-widest text-accent mb-3">
          /done — all loops ready
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          {job.title ?? "Your loops"}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted font-mono">
          {job.artist ? <span>{job.artist}</span> : null}
          {job.bpm ? (
            <span>
              BPM <span className="text-foreground tabular">{job.bpm}</span>
            </span>
          ) : null}
          <span>
            {job.bars} bar{job.bars === 1 ? "" : "s"} per loop
          </span>
          {job.expiresAt ? (
            <span>
              expires{" "}
              <span className="text-foreground">
                {new Date(job.expiresAt).toLocaleString()}
              </span>
            </span>
          ) : null}
        </div>
      </div>

      {/* Download all CTA */}
      <div className="flex flex-wrap gap-3">
        <Button size="lg">Download all as .zip</Button>
        <Link href="/">
          <Button variant="secondary" size="lg">
            Extract another
          </Button>
        </Link>
      </div>

      {/* Stems */}
      <div className="space-y-6">
        {(job.results ?? []).map((r) => (
          <StemBlock key={r.stem} result={r} />
        ))}
      </div>

      <div className="pt-6 border-t border-border text-xs text-muted-2 font-mono">
        ⚠ Files expire in 24 hours. Download them to your machine now.
      </div>
    </div>
  );
}

function StemBlock({ result }: { result: StemResult }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 bg-surface border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-accent" />
          <div className="font-semibold">{STEM_LABELS[result.stem]}</div>
          <div className="font-mono text-xs text-muted-2">
            {result.loops.length} loops
          </div>
        </div>
      </div>
      <div className="divide-y divide-border">
        {result.loops.map((loop) => (
          <div
            key={loop.index}
            className="px-5 py-4 flex items-center gap-4 hover:bg-surface/60 transition-colors"
          >
            <div className="font-mono text-xs text-muted-2 w-6 tabular">
              {String(loop.index).padStart(2, "0")}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm text-foreground truncate">
                {loop.filename}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-muted-2">
                <span className="text-accent">{loop.energyLabel}</span>
                <span className="tabular">
                  {formatTime(loop.startSec)} – {formatTime(loop.endSec)}
                </span>
                <span className="tabular">
                  {loop.durationSec.toFixed(2)}s
                </span>
                <span className="tabular">{loop.bpm} BPM</span>
              </div>
            </div>
            <a
              href={loop.downloadUrl}
              download={loop.filename}
              className="shrink-0"
            >
              <Button variant="secondary" size="sm">
                Download
              </Button>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
