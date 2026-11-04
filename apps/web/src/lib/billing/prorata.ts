// Pro-rata credit clawback math for partial Stripe refunds (M4 follow-up).
//
// Policy (Option A): after a refund of `amountRefunded` (cumulative, minor
// units) against an original charge of `amountTotal`, the user should have
// lost floor(amountRefunded * creditsGranted / amountTotal) credits in total.
// Each event claws back only the delta versus what earlier events already
// clawed back, so repeated / out-of-order events are no-ops and a sequence of
// partials can never exceed creditsGranted.
//
// Integer arithmetic (a*c/t, not (a/t)*c) avoids float error at exact
// boundaries, e.g. floor((0.1+0.2)/0.3*...) style off-by-one.

export interface ProRataInput {
  /** Cumulative amount refunded so far on the charge (Stripe amount_refunded). */
  amountRefunded: number;
  /** Original charge amount (credit_purchases.amount_cad_cents). */
  amountTotal: number;
  creditsGranted: number;
  /** Credits already clawed back for this charge (sum of prior refund rows). */
  alreadyClawed: number;
  /** Stripe charge.refunded === true. */
  isFullRefund: boolean;
}

/** Credits to claw back NOW (>= 0). Never exceeds creditsGranted - alreadyClawed. */
export function computeProRataClawback(input: ProRataInput): number {
  const granted = Math.trunc(Number(input.creditsGranted));
  const already = Math.max(0, Math.trunc(Number(input.alreadyClawed) || 0));
  if (!Number.isFinite(granted) || granted <= 0) return 0;
  const remaining = Math.max(0, granted - already);
  if (remaining === 0) return 0;
  // Full refund closes the gap exactly, whatever floor() left behind.
  if (input.isFullRefund) return remaining;

  const total = Number(input.amountTotal);
  const refunded = Number(input.amountRefunded);
  // Zero/free purchase or nothing refunded: no basis for a pro-rata amount.
  if (!Number.isFinite(total) || !Number.isFinite(refunded) || total <= 0 || refunded <= 0) {
    return 0;
  }
  const capped = Math.min(refunded, total); // over-refund protection
  const target = Math.floor((capped * granted) / total);
  return Math.min(remaining, Math.max(0, target - already));
}
