// "Capo / transpose" in the player's ⋯ menu (Phase C, C4). A stepper over
// -6..+6 semitones: below 0 it reads "Capo N" (shapes drop by N), above 0 "+N".
// Display only (lib/play/transpose.ts); the pills use the brand's pill radius
// and 44px targets, and no accent fill (selected is #222 + 2px #fff only).
import styles from './Player.module.css';
import { MAX_TRANSPOSE, MIN_TRANSPOSE, transposeSummary } from '@/lib/play/transpose';

export function TransposeMenuItem({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className={styles.menuGroup} role="group" aria-labelledby="player-transpose" data-testid="transpose-group">
      <span id="player-transpose" className={styles.menuLabel}>
        Capo / transpose
      </span>
      <div className={styles.stepper}>
        <button
          type="button"
          className={styles.segment}
          aria-label="Lower by one semitone"
          disabled={value <= MIN_TRANSPOSE}
          onClick={() => onChange(value - 1)}
          data-testid="transpose-down"
        >
          {'−'}
        </button>
        <span className={styles.stepperValue} role="status" data-testid="transpose-value">
          {value > 0 ? (
            <>
              {`+${value}`}
              <span className={styles.sr}>{value === 1 ? ' semitone' : ' semitones'}</span>
            </>
          ) : (
            transposeSummary(value)
          )}
        </span>
        <button
          type="button"
          className={styles.segment}
          aria-label="Raise by one semitone"
          disabled={value >= MAX_TRANSPOSE}
          onClick={() => onChange(value + 1)}
          data-testid="transpose-up"
        >
          +
        </button>
      </div>
      {value !== 0 ? (
        <button
          type="button"
          className={styles.segment}
          onClick={() => onChange(0)}
          data-testid="transpose-reset"
        >
          Back to original chords
        </button>
      ) : null}
    </div>
  );
}
