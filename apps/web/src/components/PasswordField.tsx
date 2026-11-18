'use client';

// A password input with a show/hide toggle (Jon, 2026-11-17, Slice 1b). Used on sign-up,
// sign-in and both fields of "Set a new password".
//
// The toggle is a real <button type="button"> — so it can never submit the form — with
// aria-label "Show password" / "Hide password" and aria-pressed, an inline stroke eye icon,
// and a 44px square target. It does not take focus from the field or move its caret:
//   - pointerdown is prevented, so a mouse or finger press never blurs the input;
//   - the caret/selection is read before the type flips and put back after (some browsers
//     reset it when an input's type changes);
//   - a keyboard user who tabbed to the button keeps focus on the button, as expected.
// autoComplete is passed straight through, so "new-password" / "current-password" survive.
//
// Purely presentational: it holds no password state of its own and makes no network call.
import { useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes } from 'react';

export const SHOW_PASSWORD = 'Show password';
export const HIDE_PASSWORD = 'Hide password';

/** The toggle's tap target, in px. WCAG 2.5.5 / the brand book's 44px minimum. */
export const TOGGLE_SIZE = 44;

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  inputStyle?: CSSProperties;
};

const wrap: CSSProperties = { position: 'relative', display: 'flex', alignItems: 'center' };
const toggle: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: '50%',
  transform: 'translateY(-50%)',
  width: TOGGLE_SIZE,
  height: TOGGLE_SIZE,
  minWidth: TOGGLE_SIZE,
  minHeight: TOGGLE_SIZE,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-md)',
};

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {open ? null : <path d="M4 4l16 16" />}
    </svg>
  );
}

export function PasswordField({ inputStyle, ...inputProps }: Props) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);
  const restore = useRef<{ start: number | null; end: number | null } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const r = restore.current;
    restore.current = null;
    if (!el || !r) return;
    el.focus();
    if (r.start !== null && r.end !== null) {
      try {
        el.setSelectionRange(r.start, r.end);
      } catch {
        /* an input type that does not support selection: nothing to restore */
      }
    }
  }, [visible]);

  const onToggle = () => {
    const el = ref.current;
    // Only a field that HAD focus gets it back; a keyboard user on the button stays there.
    if (el && typeof document !== 'undefined' && document.activeElement === el) {
      restore.current = { start: el.selectionStart, end: el.selectionEnd };
    }
    setVisible((v) => !v);
  };

  return (
    <span style={wrap}>
      <input
        {...inputProps}
        ref={ref}
        type={visible ? 'text' : 'password'}
        style={{ ...inputStyle, paddingRight: TOGGLE_SIZE + 4 }}
      />
      <button
        type="button"
        aria-label={visible ? HIDE_PASSWORD : SHOW_PASSWORD}
        aria-pressed={visible}
        data-testid="password-toggle"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggle}
        style={toggle}
      >
        <EyeIcon open={!visible} />
      </button>
    </span>
  );
}

export default PasswordField;
