// Shared inline styles for the auth and account forms (sign-in, reset password, delete
// account). One definition, so the four forms cannot drift apart again. Brand book v2.2:
//   §7.2 inputs: 48px tall, on --bg-elevated, a 1.5px --border-control edge, --radius-md (M27)
//   §7.1 secondary button: transparent, a 1.5px --border-control edge, #e0e0e0 text (M20)
//   §7.10 text links: white and underlined, never lime (M19, A5)
// Values are tokens only (src/styles/design-tokens.css). The focus ring comes from the global
// :focus-visible rule (stem-color.css), so nothing here removes the outline.
import type { CSSProperties } from 'react';

export const fieldStyle: CSSProperties = {
  width: '100%',
  minHeight: 'var(--h-field)',
  padding: '0 12px',
  borderRadius: 'var(--radius-md)',
  fontSize: 16,
  border: '1.5px solid var(--border-control)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  boxSizing: 'border-box',
};

/** Box shared by every full-width form button; add a variant below. */
export const buttonBase: CSSProperties = {
  width: '100%',
  minHeight: 'var(--h-control)',
  padding: '0 16px',
  borderRadius: 'var(--radius-md)',
  fontWeight: 600,
  cursor: 'pointer',
  boxSizing: 'border-box',
};

/** The one lime action on the view. */
export const primaryButton: CSSProperties = {
  border: 'none',
  background: 'var(--accent)',
  color: 'var(--text-inverse)',
};

/** Every other button: a visible control edge (4.10:1 on the page), no lime. */
export const secondaryButton: CSSProperties = {
  border: '1.5px solid var(--border-control)',
  background: 'transparent',
  color: 'var(--text-secondary)',
};

/** An inline text action: white, underlined, with a 44px tap target. */
export const textButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 4,
  font: 'inherit',
  minHeight: 'var(--h-control)',
  padding: '0 8px',
  display: 'inline-flex',
  alignItems: 'center',
};
