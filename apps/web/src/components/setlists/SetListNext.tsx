'use client';

// "Next song ›" (#322; Phase B, B2; AC 7): the player opened from a set list (?set=<id>) shows
// one slim row under its header — where you are in the set, and a ≥ 44 px "Next song ›" that
// opens the next song that can play, in ONE tap. Items that cannot play (audio expired,
// unavailable, still processing) are skipped and the row says so in one line. At the last
// song there is no Next: it never runs past the end and never wraps.
//
// The row also hands the set's name up, so the header's back link reads "Back to <set name>".
import { useEffect, useState } from 'react';
import {
  DEMO_SET_ID,
  nextInSet,
  playHref,
  skippedNotice,
  type SetListDetail,
} from '@/lib/set-lists';
import styles from './SetLists.module.css';

export interface SetListNextProps {
  readonly setId: string;
  readonly jobId: string;
  /** Called once the set is read, with its name (for "Back to <set name>"). */
  readonly onSet?: (set: { id: string; name: string }) => void;
}

export function SetListNext({ setId, jobId, onSet }: SetListNextProps) {
  const [list, setList] = useState<SetListDetail | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const url = setId === DEMO_SET_ID ? '/api/set-lists/demo' : `/api/set-lists/${encodeURIComponent(setId)}`;
    (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { list?: SetListDetail };
        if (body.list) setList(body.list);
      } catch {
        /* no set, no row: the player works exactly as without ?set= */
      }
    })();
    return () => ac.abort();
  }, [setId]);

  useEffect(() => {
    if (list) onSet?.({ id: list.id, name: list.name });
  }, [list, onSet]);

  if (!list) return null;
  const { next, skipped, index } = nextInSet(list.items, jobId);
  if (index < 0) return null; // this song is not in that list: show nothing rather than guess
  const where = `${index + 1} of ${list.items.length} · ${list.name}`;
  const line = skippedNotice(skipped) || (next ? where : `Last song in ${list.name}.`);

  return (
    <div className={styles.nextRow} data-testid="set-next-row">
      <p className={styles.nextText} role="status" data-testid="set-next-text">
        {line}
      </p>
      {next ? (
        <a
          className={styles.nextBtn}
          href={playHref(next.job_id as string, list.id)}
          aria-label={`Next song: ${next.title}`}
          data-testid="set-next"
        >
          Next song ›
        </a>
      ) : null}
    </div>
  );
}

export default SetListNext;
