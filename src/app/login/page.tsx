import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

export default async function LoginPage(
  props: PageProps<"/login">,
) {
  const sp = await props.searchParams;
  const reason = sp.reason === "limit";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <Link href="/">
            <Logo />
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-md space-y-8">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-muted mb-3">
              /sign in
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {reason ? "You've used your 3 free songs" : "Sign in to Stem-Loops"}
            </h1>
            <p className="mt-3 text-sm text-muted leading-relaxed">
              {reason
                ? "Sign in with Google to keep extracting loops. It's free, takes 5 seconds, and there's no payment info required."
                : "Sign in with Google to save your job history and extract unlimited loops."}
            </p>
          </div>

          <div className="space-y-3">
            {/* TODO: wire NextAuth signIn('google') */}
            <Button size="lg" className="w-full">
              <GoogleGlyph />
              Continue with Google
            </Button>

            <Link href="/" className="block">
              <Button variant="ghost" size="lg" className="w-full">
                ← Back
              </Button>
            </Link>
          </div>

          <div className="pt-6 border-t border-border text-xs text-muted-2 font-mono leading-relaxed">
            By signing in you agree to our Terms and Privacy Policy. We only
            store your email address and job history.
          </div>
        </div>
      </main>
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
