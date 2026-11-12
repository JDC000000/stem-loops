// The chord artifact's R2 key is written by Python and read by TypeScript, and NOTHING
// made them agree until this file. `apps/web/src/lib/r2.ts:playChordsR2Key` carries only a
// hand-maintained comment asking the next maintainer to mirror
// `apps/worker/src/worker/storage/r2_uploader.py:upload_play_chords`:
//
//     "the worker writes exactly this key; drift here silently 404s the overlay"
//
// Silently is the operative word. A one-sided edit to either literal does not fail a build,
// a type check or any test — `usePlayChords` simply reports "no chords" and the chord
// overlay, which is the product's differentiator, renders empty for every job. There is no
// error anywhere a reader would look.
//
// WHY THIS SHAPE. A self-consistency check proves nothing: a gate that recomputes the key
// with the same function the code used only proves the code applied its own rule. So the
// two sides are reached by two DIFFERENT channels —
//   * TypeScript: the real `playChordsR2Key` is transpiled and EXECUTED. Not regexed.
//   * Python: the f-string literal is parsed out of the SOURCE, because there is no Python
//     runtime in this suite.
// and the results are compared. That is the cross-artifact form (SQL vs TypeScript) the
// project's standing orders name as the sound one, applied to Python vs TypeScript.
//
// WHY THE DOCSTRING STRIPPER IS NOT OPTIONAL, and it is the whole trap in this file:
// `upload_play_chords`'s own docstring contains the key VERBATIM —
//
//     Deterministic key ``jobs/<job_id>/play.chords.json`` so a retried job
//
// so a naive grep for the key in that file matches the PROSE and passes while the code
// says something else entirely. That is the comment-blind gate class this repo has shipped
// seven times in nine PRs. `pyCodeOnly()` below blanks docstrings and `#` comments before
// anything is extracted, and `test('the docstring stripper is not vacuous')` proves the
// stripper actually does it by feeding it a fixture whose ONLY occurrence is in a
// docstring and asserting the extraction finds nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { WEB, dataUrl } from './helpers/billing-harness.mjs';

const REPO = join(WEB, '..', '..');
const PY_PATH = join(REPO, 'apps', 'worker', 'src', 'worker', 'storage', 'r2_uploader.py');
const TS_PATH = join(WEB, 'src', 'lib', 'r2.ts');

const JOB_ID = '92cedac0-dfb1-4262-a950-95e3e9ab63d2';

/**
 * Blank out Python docstrings and `#` comments, preserving line count and offsets so a
 * reported line number still points at the real line.
 *
 * Triple-quoted strings are treated as docstrings wherever they appear. That is coarser
 * than Python's own grammar — a triple-quoted string used as a VALUE would also be blanked
 * — but it errs in the safe direction for this gate: blanking too much can only make the
 * extraction find nothing, which fails loudly, never silently pass.
 */
function pyCodeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const three = src.slice(i, i + 3);
    if (three === '"""' || three === "'''") {
      const close = src.indexOf(three, i + 3);
      const end = close === -1 ? n : close + 3;
      // keep newlines so line numbers survive
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    const ch = src[i];
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // a single-quoted string: copy it whole so an f-string literal survives
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') break;
        j++;
      }
      const end = Math.min(j + 1, n);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Pull the chord key's f-string template out of Python CODE (docstrings already blanked).
 * Returns the template with `{job_id}` left intact.
 *
 * Requires EXACTLY ONE match. Zero is a failure, not a skip — mutation rule 2. If the
 * worker is refactored so the key is built some other way, this gate must go red and be
 * rewritten, not quietly stop checking.
 */
function pyChordKeyTemplate(code) {
  const re = /f"(jobs\/\{job_id\}\/[A-Za-z0-9_.]+)"/g;
  const hits = [...code.matchAll(re)].map((m) => m[1]);
  assert.equal(
    hits.length,
    1,
    `expected exactly ONE f-string chord key in r2_uploader.py's CODE, found ${hits.length}: ` +
      `${JSON.stringify(hits)}. Zero means the key is no longer built as a literal f-string ` +
      `and this gate has stopped checking anything — rewrite it rather than deleting it.`,
  );
  return hits[0];
}

/**
 * Transpile and execute the real TS function. No regex, no reimplementation.
 *
 * `r2.ts` instantiates an S3 client at module scope, so the module cannot load without
 * its imports resolving — and a `data:` URL module cannot resolve bare specifiers like
 * `@aws-sdk/client-s3` at all. Each import is therefore redirected to a stub.
 *
 * This does not weaken the gate: `playChordsR2Key` is a pure string function that touches
 * none of them. What is being executed is the real function body from the real file. If it
 * ever starts depending on one of these, the stub returns something inert and the
 * comparison against Python fails loudly rather than passing quietly.
 */
async function loadTsKeyFn() {
  const src = readFileSync(TS_PATH, 'utf8');
  const s3Stub = dataUrl(
    `export class S3Client { constructor() {} }
     export class GetObjectCommand { constructor() {} }
     export class PutObjectCommand { constructor() {} }`,
  );
  const presignStub = dataUrl(`export const getSignedUrl = async () => 'stub://signed';`);
  const retentionStub = dataUrl(`export const RETENTION_SEC = 86400;`);

  const js = ts
    .transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(/from ['"]@aws-sdk\/client-s3['"]/g, `from '${s3Stub}'`)
    .replace(/from ['"]@aws-sdk\/s3-request-presigner['"]/g, `from '${presignStub}'`)
    .replace(/from ['"]@\/lib\/retention['"]/g, `from '${retentionStub}'`);

  // Any specifier left unredirected would throw an opaque ERR_MODULE_NOT_FOUND at import
  // time. Name it instead, so a new import in r2.ts produces a readable failure.
  const leftover = [...js.matchAll(/from ['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith('data:'));
  assert.deepEqual(
    leftover,
    [],
    `r2.ts gained import(s) this gate does not stub: ${JSON.stringify(leftover)}. ` +
      `Add a stub for each in loadTsKeyFn() — do not delete this assertion.`,
  );

  const mod = await import(dataUrl(js));
  assert.equal(
    typeof mod.playChordsR2Key,
    'function',
    'r2.ts no longer exports playChordsR2Key — the read side of the chord key contract moved',
  );
  return mod.playChordsR2Key;
}

test('the chord artifact R2 key agrees between the Python writer and the TypeScript reader', async () => {
  const pyTemplate = pyChordKeyTemplate(pyCodeOnly(readFileSync(PY_PATH, 'utf8')));
  const pyRendered = pyTemplate.replace('{job_id}', JOB_ID);

  const playChordsR2Key = await loadTsKeyFn();
  const tsRendered = playChordsR2Key(JOB_ID);

  assert.equal(
    tsRendered,
    pyRendered,
    `the chord key DRIFTED between the two languages and nothing else would have caught it.\n` +
      `  worker writes (apps/worker/src/worker/storage/r2_uploader.py): ${pyRendered}\n` +
      `  web reads     (apps/web/src/lib/r2.ts:playChordsR2Key):        ${tsRendered}\n` +
      `A mismatch 404s every chord fetch and the overlay renders empty with no error.`,
  );
});

test('the key is under the jobs/ prefix, which the retention sweep must know about', () => {
  const pyTemplate = pyChordKeyTemplate(pyCodeOnly(readFileSync(PY_PATH, 'utf8')));
  assert.ok(
    pyTemplate.startsWith('jobs/{job_id}/'),
    `the chord key's top-level prefix changed to ${JSON.stringify(pyTemplate)}. This is not ` +
      `only a reader/writer question: the per-job retention sweep in ` +
      `apps/worker/src/worker/cleanup.py deletes a job's own prefixes, and a chord key that ` +
      `escapes them survives the 24-hour deletion promise made on /privacy. If this moved ` +
      `deliberately, update cleanup.py's prefix list in the same PR.`,
  );
});

test('the docstring stripper is not vacuous', () => {
  // The real file's docstring contains the key verbatim. If pyCodeOnly() stopped working,
  // pyChordKeyTemplate would match the PROSE and this gate would pass while the code said
  // something else. Prove the stripper by handing it a file whose ONLY occurrence is prose.
  const proseOnly = [
    'def upload_play_chords(job_id, body):',
    '    """Deterministic key f"jobs/{job_id}/play.chords.json" so a retry overwrites.',
    '',
    '    More prose mentioning f"jobs/{job_id}/play.chords.json" again.',
    '    """',
    '    r2_key = build_it_some_other_way(job_id)  # f"jobs/{job_id}/decoy.json"',
    '    return r2_key',
  ].join('\n');

  const stripped = pyCodeOnly(proseOnly);
  assert.ok(
    !stripped.includes('play.chords.json'),
    'pyCodeOnly() left a docstring occurrence behind — every assertion in this file is ' +
      'then satisfiable by prose, which is exactly the defect this gate exists to avoid',
  );
  assert.ok(
    !stripped.includes('decoy.json'),
    'pyCodeOnly() left a `#` comment occurrence behind',
  );
  assert.throws(
    () => pyChordKeyTemplate(stripped),
    /found 0/,
    'extraction must FAIL LOUDLY when the key is only in prose, never fall back to it',
  );

  // And the inverse: a real code occurrence IS found, so the stripper is not just deleting
  // everything. A stripper that blanked the whole file would satisfy the assertions above.
  const codeToo = proseOnly.replace(
    '    r2_key = build_it_some_other_way(job_id)  # f"jobs/{job_id}/decoy.json"',
    '    r2_key = f"jobs/{job_id}/play.chords.json"',
  );
  assert.equal(pyChordKeyTemplate(pyCodeOnly(codeToo)), 'jobs/{job_id}/play.chords.json');
});
