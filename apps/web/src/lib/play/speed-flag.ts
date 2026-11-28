/**
 * #448 (class D, awaiting Jon's listening check): with a FIRST slow-down still
 * pending (75% tapped, the stretch nodes not running yet) a count before Play
 * ran at the rate playing (100%) and the music started late by the stretch
 * latency (~0.12 s). With this flag on, the count uses the pending rate
 * (count-in.ts countRateFor) and the engine reports that rate's latency
 * (engine.ts stretchLatencySec). '1' = on. OFF by default: with it off nothing
 * changes. Kept apart so the engine never imports the count module.
 */
export const COUNT_PENDING_RATE_KEY = 'sl.play.countPendingRate.v1';

export function readCountPendingRate(): boolean {
  try {
    return globalThis.localStorage?.getItem(COUNT_PENDING_RATE_KEY) === '1';
  } catch {
    return false;
  }
}
