import type { KeyboardEvent } from 'react';
import type { LoopRegion, SectionLoopProps } from '@/lib/play/types';
import {
  formatTime,
  nameRegions,
  nextLoop,
  sameRegion,
  sanitizeRegions,
} from '@/lib/play/sections';
import styles from './SectionLoop.module.css';

export interface SectionLoopControlProps extends SectionLoopProps {
  /** Track length; regions beyond it are clamped or dropped. Optional. */
  readonly durationSec?: number;
}

/**
 * Story 4.5. Pick a song section to loop. This emits regions and nothing else:
 * the seamless wrap is the engine's `setLoop`. Stateless on purpose - `active`
 * comes from the engine snapshot, so the pressed state can never disagree with
 * what is actually playing.
 */
export function SectionLoop({ sections, active, onLoop, durationSec }: SectionLoopControlProps) {
  const named = nameRegions(sanitizeRegions(sections, durationSec));
  const cur = active && Number.isFinite(active.startSec) && Number.isFinite(active.endSec) ? active : null;
  if (named.length === 0 && !cur) return null;

  const activeNamed = named.find((n) => sameRegion(n.region, cur));
  // `active` may be a hand-dragged region (no label) or one we do not offer.
  const status = !cur
    ? 'Not looping'
    : `Looping ${activeNamed ? activeNamed.name : 'custom region'}, ${formatTime(cur.startSec)} to ${formatTime(cur.endSec)}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && cur) {
      e.preventDefault();
      onLoop(null);
    }
  };

  return (
    <section className={styles.root} aria-label="Loop a section" onKeyDown={onKeyDown}>
      <ul className={styles.list}>
        {named.map(({ region, name }: { region: LoopRegion; name: string }) => {
          const pressed = sameRegion(region, cur);
          return (
            <li key={`${region.startSec}-${region.endSec}`}>
              <button
                type="button"
                className={styles.chip}
                aria-pressed={pressed}
                data-active={pressed ? 'true' : undefined}
                onClick={() => onLoop(nextLoop(cur, region))}
              >
                <span className={styles.name}>{name}</span>
                <span className={styles.time}>
                  {formatTime(region.startSec)}&ndash;{formatTime(region.endSec)}
                </span>
                {pressed ? <span className={styles.badge}>Looping</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={styles.clear}
        disabled={!cur}
        onClick={() => onLoop(null)}
      >
        Clear loop
      </button>
      <p className={styles.status} role="status" aria-live="polite">{status}</p>
    </section>
  );
}
