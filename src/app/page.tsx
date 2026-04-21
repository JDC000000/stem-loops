import Link from "next/link";
import { Logo } from "@/components/logo";
import { UrlForm } from "@/components/url-form";
import { Waveform } from "@/components/waveform";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* ------------------------------------------------------------- */}
      {/*  Nav                                                           */}
      {/* ------------------------------------------------------------- */}
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <Logo />
          <nav className="flex items-center gap-6 text-sm text-muted">
            <Link href="#how" className="hover:text-foreground transition-colors">
              How it works
            </Link>
            <Link href="#faq" className="hover:text-foreground transition-colors">
              FAQ
            </Link>
            <Link
              href="/login"
              className="hover:text-foreground transition-colors"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* ------------------------------------------------------------- */}
      {/*  Hero + form                                                   */}
      {/* ------------------------------------------------------------- */}
      <main className="flex-1">
        <section className="relative overflow-hidden">
          {/* Background waveform */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[320px] opacity-[0.18]">
            <Waveform className="w-full h-full" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[320px] bg-gradient-to-b from-transparent via-background/60 to-background" />

          <div className="relative mx-auto max-w-6xl px-6 pt-24 pb-16">
            {/* Tagline row */}
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-surface/60 backdrop-blur-sm text-xs font-mono text-muted mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Free for your first 3 songs
            </div>

            {/* Headline */}
            <h1 className="text-5xl sm:text-6xl md:text-7xl font-semibold tracking-tight leading-[1.02] max-w-4xl">
              Loops from{" "}
              <span className="relative inline-block">
                <span className="relative z-10 text-accent">anything</span>
                <span
                  className="absolute inset-x-0 bottom-1 h-3 bg-accent/15 -z-0"
                  aria-hidden="true"
                />
              </span>
              .<br />
              In seconds.
            </h1>

            <p className="mt-6 max-w-xl text-lg text-muted leading-relaxed">
              Paste a YouTube URL. Pick a stem. Get five bar-aligned, BPM-detected
              loops ready to drop into your DAW. Drums, bass, vocals, guitar, keys.
            </p>

            {/* Form */}
            <div className="mt-12">
              <UrlForm />
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- */}
        {/*  How it works                                                  */}
        {/* ------------------------------------------------------------- */}
        <section
          id="how"
          className="border-t border-border bg-surface/30 bar-grid"
        >
          <div className="mx-auto max-w-6xl px-6 py-24">
            <div className="mb-12">
              <div className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
                /01 — how it works
              </div>
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight max-w-2xl">
                From YouTube link to a folder of loops in about 3 minutes.
              </h2>
            </div>

            <div className="grid gap-px bg-border md:grid-cols-4 rounded-lg overflow-hidden border border-border">
              {STEPS.map((step, i) => (
                <div
                  key={step.title}
                  className="bg-background p-6 flex flex-col gap-4"
                >
                  <div className="font-mono text-xs text-accent tabular">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div className="text-base font-semibold">{step.title}</div>
                  <div className="text-sm text-muted leading-relaxed">
                    {step.body}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- */}
        {/*  FAQ                                                           */}
        {/* ------------------------------------------------------------- */}
        <section id="faq" className="border-t border-border">
          <div className="mx-auto max-w-3xl px-6 py-24">
            <div className="mb-12">
              <div className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
                /02 — questions
              </div>
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
                Everything you need to know.
              </h2>
            </div>

            <div className="divide-y divide-border border-y border-border">
              {FAQS.map((q) => (
                <details
                  key={q.q}
                  className="group py-6 cursor-pointer"
                >
                  <summary className="flex items-center justify-between gap-6 list-none">
                    <span className="text-base font-medium">{q.q}</span>
                    <span className="text-muted group-open:rotate-45 transition-transform text-xl font-mono">
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm text-muted leading-relaxed max-w-2xl">
                    {q.a}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* ------------------------------------------------------------- */}
      {/*  Footer                                                        */}
      {/* ------------------------------------------------------------- */}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm text-muted">
          <Logo />
          <div className="flex gap-6 font-mono text-xs">
            <span>© 2026 stemloop</span>
            <Link href="#" className="hover:text-foreground">
              Terms
            </Link>
            <Link href="#" className="hover:text-foreground">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

const STEPS = [
  {
    title: "Paste a URL",
    body: "Any public YouTube video. Music, live sessions, DJ sets — if it has audio, Stemloop can loop it.",
  },
  {
    title: "Pick a stem",
    body: "Drums, bass, vocals, guitar, or keys. Powered by state-of-the-art source separation (Demucs htdemucs).",
  },
  {
    title: "We detect BPM",
    body: "librosa identifies the downbeat and tempo. Loops align to bar boundaries with zero-sample drift.",
  },
  {
    title: "Download the loops",
    body: "Five loops per stem: quiet, low, medium, high, and peak energy. 24-bit WAV, ready to drop into your DAW.",
  },
];

const FAQS = [
  {
    q: "Is this legal?",
    a: "You're responsible for how you use extracted loops. Stemloop is a tool — the same as sampling from a record. For commercial releases, clear the sample. For personal practice, sketching, remix contests, and learning, you're fine.",
  },
  {
    q: "How long does it take?",
    a: "Typically 2-3 minutes per song. The bottleneck is AI source separation. Longer songs take longer. You'll see live progress while it runs.",
  },
  {
    q: "What quality are the files?",
    a: "24-bit stereo PCM WAV at the source sample rate (usually 44.1 or 48 kHz). Bar-aligned to zero-sample drift — they loop cleanly in any DAW.",
  },
  {
    q: "Why 5 loops per stem?",
    a: "We analyse energy across the whole track and pick one loop from each of 5 tiers — quiet/intro, low, medium, high, and peak. You get variety for free instead of 10 copies of the same hook.",
  },
  {
    q: "How long do the files stay available?",
    a: "24 hours. Download them to your machine as soon as they're ready.",
  },
  {
    q: "Do I need to sign up?",
    a: "Not for your first 3 songs. After that, sign in with Google — it's free and takes 5 seconds.",
  },
];
