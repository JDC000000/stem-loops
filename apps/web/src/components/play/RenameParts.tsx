'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { MAX_PART_NAME_LEN } from '@/lib/play/part-names';
import { Sheet } from './Sheet';
import styles from './RenameParts.module.css';

export interface RenamePartsProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocus?: () => HTMLElement | null;
  /** The default names ("Part 1", ...), in strip order. */
  readonly defaults: readonly string[];
  /** What each chip shows now (custom name or the default). */
  readonly current: readonly string[];
  /** Each part's start time, shown beside its field. */
  readonly times: readonly string[];
  /** Save: the text of every field, in strip order (the caller trims and drops defaults). */
  readonly onSave: (drafts: string[]) => void;
}

/**
 * "Rename parts" (Phase C C3). A sheet with one text field per part: max 24
 * characters, an empty field puts the default name back. Names are kept on
 * this device only (lib/play/part-names). Reached from the player's ⋯ menu;
 * the chips' tap / long-press gestures are untouched.
 */
export function RenameParts({ open, onClose, returnFocus, defaults, current, times, onSave }: RenamePartsProps) {
  const [drafts, setDrafts] = useState<string[]>([]);
  // Fresh copy of the saved names each time the sheet opens.
  useEffect(() => {
    if (open) setDrafts(current.map((c, i) => (c === defaults[i] ? '' : c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(defaults.map((_, i) => drafts[i] ?? ''));
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy="rename-parts-title" returnFocus={returnFocus} testId="rename-parts-sheet">
      <form className={styles.form} onSubmit={submit} data-testid="rename-parts-form">
        <h2 id="rename-parts-title" className={styles.title}>
          Rename parts
        </h2>
        <p className={styles.note}>Saved on this device only. Leave a field empty to use the default name.</p>
        <ul className={styles.list}>
          {defaults.map((d, i) => (
            <li key={i} className={styles.row}>
              <label className={styles.label} htmlFor={`rename-part-${i}`}>
                {d}
                {times[i] ? <span className={styles.time}>{` · ${times[i]}`}</span> : null}
              </label>
              <input
                id={`rename-part-${i}`}
                className={styles.input}
                type="text"
                maxLength={MAX_PART_NAME_LEN}
                autoComplete="off"
                placeholder={d}
                value={drafts[i] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setDrafts((cur) => {
                    const next = cur.slice();
                    next[i] = v;
                    return next;
                  });
                }}
                data-testid={`rename-part-input-${i}`}
              />
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose} data-testid="rename-parts-cancel">
            Cancel
          </button>
          <button type="submit" className={styles.save} data-testid="rename-parts-save">
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export default RenameParts;
