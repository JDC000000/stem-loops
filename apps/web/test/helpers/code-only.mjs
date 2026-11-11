// Blank out comment and literal interiors so a SOURCE-TEXT assertion sees only
// code. Shared by test/play-player.test.mjs and test/chord-playhead.test.mjs.
//
// WHY THIS IS A SCANNER AND NOT A STACK OF `.replace()` CALLS.
//
// The comment-blind class has now appeared six times on this repo. Round 2
// answered it with three chained regexes — whole-line `//`, then block
// comments, then trailing `//`. Round 3 broke that in both directions at once:
//
//   UNDER-inclusive. A regex stack only deletes comments, so a STRING,
//   TEMPLATE or REGEX literal containing the pattern still satisfies a `match`
//   gate. `<span title={'<Player jobId={job.id} … />'} />` satisfied both mount
//   gates with the real mount DELETED.
//
//   OVER-inclusive. A `//` inside a string looks exactly like a comment, so the
//   trailing rule deleted real code after it. `aria-label="chords//legacy"` made
//   `<ChordOverlay` vanish before the matcher ran, and the `doesNotMatch` gate
//   guarding against a second position-less overlay REPORTED SUCCESS WITHOUT
//   HAVING CHECKED.
//
// Reordering the rules does not fix this; it moves the hole. Measured on both
// orderings:
//   line -> block -> trailing  loses real code to `const P = 1; // see /* note`
//   line -> trailing -> block  loses real code to `/* note // end */ code();`
// The two failures are mirror images, because each rule is deciding in
// isolation something that only a single left-to-right pass can decide.
//
// So this makes one pass, tracking which construct it is inside, and blanks the
// interior of each comment and each literal while PRESERVING LENGTH AND
// NEWLINES — `indexOf` ordering and reported line numbers keep meaning what
// they say. `${…}` interpolations inside a template are stepped over rather
// than blanked, because they contain real code.
//
// This is the SECONDARY layer. The primary answer to the mount gates is to
// assert on RENDERED OUTPUT (test/job-page-render.test.mjs): a string literal
// cannot put a mounted component into rendered HTML, which is a property no
// amount of source-text cleverness can fake. Source-text gates are kept for
// what rendering cannot see — a commented-out mount, a trailing `//` ordering
// claim — and this scanner is what makes them honest.
//
// KNOWN RESIDUE: JSX *text* is not a literal, so prose between tags is still
// code to this scanner. No current gate is exposed by that, and a render
// assertion is the answer if one ever is.

/**
 * One scanner, two gate kinds.
 *
 * `codeOnly` blanks comments AND literal interiors. Use it for a gate that must
 * not be SATISFIED by a literal — the mount gates, Story 2.7, render order.
 *
 * `withoutComments` blanks comments only and leaves literals readable. Use it
 * for a gate that INSPECTS a literal's value, such as the job-page gutter test,
 * which has to read `padding: '48px var(--sl-gutter, 16px) 96px'`. Blanking
 * that string would make the gate unable to see the thing it exists to check.
 *
 * Both are correct about comments, which is the actual defect being fixed: a
 * `//` inside a string is not a comment, and a `/*` inside a line comment does
 * not open a block. The old regex stack got both wrong depending on its rule
 * order.
 */
export function withoutComments(src) {
  return scan(src, false);
}

/** Source with comment AND literal interiors blanked, length preserved. */
export function codeOnly(src) {
  return scan(src, true);
}

function scan(src, blankLiterals) {
  const out = Array.from(src);
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // A `/` starts a regex rather than a division only after one of these.
  const REGEX_OK = /[([{,;:=!&|?+\-*%~^<>]$/;
  const prevSignificant = (at) => {
    for (let k = at - 1; k >= 0; k--) {
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return src.slice(Math.max(0, k - 6), k + 1);
    }
    return '';
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') break; // unterminated: do not run past EOL
        j++;
      }
      if (blankLiterals) blank(i + 1, j); // keep the quotes, blank the interior
      i = Math.min(n, j + 1);
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          if (blankLiterals) blank(i + 1, j); // text run before the interpolation
          j += 2;
          let depth = 1;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          i = j - 1; // the next text run starts here
          continue;
        }
        j++;
      }
      if (j < n && src[j] === '`') {
        if (blankLiterals) blank(i + 1, j);
        i = j + 1;
      } else {
        i = j;
      }
      continue;
    }

    if (c === '/' && REGEX_OK.test(prevSignificant(i))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        if (blankLiterals) blank(i + 1, j);
        i = j + 1;
        continue;
      }
    }

    i++;
  }
  return out.join('');
}
