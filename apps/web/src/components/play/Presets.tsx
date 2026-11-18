'use client';

import { useState } from 'react';
import type { StemState } from '@/lib/play/types';
import {
  DEFAULT_PART,
  PARTS,
  PART_QUESTION,
  PRESET_NAMES,
  PRESET_ORDER,
  type Part,
  type PresetId,
  activePreset,
  partLabel,
  presetBlocked,
} from '@/lib/play/presets';
import styles from './Presets.module.css';

export interface PresetsProps {
  readonly stems: readonly StemState[];
  /** The remembered part, or null when the player has not been asked yet. */
  readonly part: Part | null;
  /** Apply a preset. For 'mine', `part` is the part to mute. */
  readonly onPreset: (id: PresetId, part: Part) => void;
  /** The player answered "Which part do you play?" (remember it). */
  readonly onPart: (part: Part) => void;
  /** Visible legend; the stage's no-chords state and the Mix sheet both use "Practice presets". */
  readonly legend?: string;
  readonly idPrefix?: string;
}

/**
 * The four practice presets in a 2x2 grid (design v1.4, P1.3), each one tap.
 * Which is pressed is derived from the mix (lib/play/presets.ts), so touching
 * any mute or solo afterwards shows "Custom" in the legend by construction.
 *
 * DB-13 option (a): the FIRST tap of "Mute my part" asks "Which part do you
 * play?" (Guitar pre-selected · Bass · Keys · Drums · Vocals), then mutes it and
 * remembers the answer; after that it is one tap, with a "Change" link.
 */
export function Presets({ stems, part, onPreset, onPart, legend = 'Practice presets', idPrefix = 'presets' }: PresetsProps) {
  const [asking, setAsking] = useState(false);
  const [choice, setChoice] = useState<Part>(part ?? DEFAULT_PART);
  const active = activePreset(stems, part);
  const blockedMine = presetBlocked('mine', part, stems);

  const pick = (id: PresetId) => {
    if (id === 'mine' && !part) {
      setChoice(DEFAULT_PART);
      setAsking(true);
      return;
    }
    onPreset(id, part ?? DEFAULT_PART);
  };

  return (
    <fieldset className={styles.root} data-testid={`${idPrefix}`}>
      <legend className={styles.legend}>
        {legend}
        {active === 'custom' ? ' · Custom' : ''}
      </legend>
      {asking ? (
        <div className={styles.ask} role="group" aria-labelledby={`${idPrefix}-ask`}>
          <p className={styles.question} id={`${idPrefix}-ask`}>
            {PART_QUESTION}
          </p>
          <div className={styles.parts}>
            {PARTS.map((p) => (
              <button
                key={p}
                type="button"
                className={styles.part}
                aria-pressed={choice === p}
                onClick={() => setChoice(p)}
                data-autofocus={p === choice ? true : undefined}
              >
                {partLabel(p)}
              </button>
            ))}
          </div>
          <div className={styles.askActions}>
            <button
              type="button"
              className={styles.confirm}
              onClick={() => {
                setAsking(false);
                onPart(choice);
                onPreset('mine', choice);
              }}
            >
              Mute {partLabel(choice).toLowerCase()}
            </button>
            <button type="button" className={styles.cancel} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.grid}>
            {PRESET_ORDER.map((id) => {
              const blocked = id === 'mine' ? blockedMine : null;
              return (
                <button
                  key={id}
                  type="button"
                  className={styles.preset}
                  aria-pressed={active === id}
                  aria-disabled={blocked ? true : undefined}
                  aria-describedby={blocked ? `${idPrefix}-blocked` : undefined}
                  data-preset={id}
                  onClick={() => {
                    if (!blocked) pick(id);
                  }}
                >
                  {PRESET_NAMES[id]}
                </button>
              );
            })}
          </div>
          {blockedMine ? (
            <p className={styles.note} id={`${idPrefix}-blocked`}>
              {blockedMine}
            </p>
          ) : part ? (
            <p className={styles.note}>
              Your part: {partLabel(part)}.{' '}
              <button
                type="button"
                className={styles.change}
                onClick={() => {
                  setChoice(part);
                  setAsking(true);
                }}
              >
                Change
              </button>
            </p>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

export default Presets;
