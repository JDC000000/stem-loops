// /trial is retired (copy audit F30 and F64, approved by Jon 2026-11-13). Its 3-song trial
// offered less than the Free plan's 5 tracks a month, so the page sends everyone to /pricing.
// Billing code is untouched: /api/users/me/trial/{grant,consume}, lib/trial.ts and the trial
// path in /api/jobs still serve anyone who already holds a grant. StartTrialButton.tsx has no
// caller now; delete it in a follow-up. layout.tsx stays, so test/signed-in-nav.test.mjs
// (which lists /trial) is unchanged.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function TrialPage() {
  redirect('/pricing');
}
