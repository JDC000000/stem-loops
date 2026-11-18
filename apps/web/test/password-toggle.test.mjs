// Show/hide password (Jon, 2026-11-17, Slice 1b): every password field on sign-up, sign-in and
// "Set a new password" has a toggle. MOUNTED AND CLICKED (happy-dom, real React events) on the
// REAL LoginForm and ResetPasswordSetForm, with the real PasswordField.
//
// CANNOT COVER (no layout engine): the 44px target is asserted on the inline style, not on a
// measured box; that it sits inside the field is a screenshot matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { withDom } from './helpers/dom.mjs';
import { loadLoginFormComponent } from './helpers/render-login-form.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) },
}).outputText;

const { React, Form: LoginForm } = await loadLoginFormComponent();

// ResetPasswordSetForm with its three imports mapped to the real modules.
const cache = join(WEB, 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'password-toggle-'));
const put = (name, code) => { writeFileSync(join(dir, name), code); return './' + name; };
const rulesMod = put('password-rules.mjs', toJs(read('src/lib/auth/password-rules.ts')));
const stylesMod = put('form-styles.mjs', toJs(read('src/lib/ui/form-styles.ts')));
const fieldMod = put('PasswordField.mjs', toJs(read('src/components/PasswordField.tsx'), true));
put('ResetPasswordSetForm.mjs', toJs(read('src/components/ResetPasswordSetForm.tsx'), true)
  .replace(/from ['"]@\/lib\/auth\/password-rules['"]/g, `from '${rulesMod}'`)
  .replace(/from ['"]@\/lib\/ui\/form-styles['"]/g, `from '${stylesMod}'`)
  .replace(/from ['"]@\/components\/PasswordField['"]/g, `from '${fieldMod}'`));
const ResetForm = (await import(pathToFileURL(join(dir, 'ResetPasswordSetForm.mjs')).href)).default;
const rules = await import(pathToFileURL(join(dir, 'password-rules.mjs')).href);

const toggles = (dom) => dom.findAll('[data-testid="password-toggle"]');
const field = (btn) => btn.parentElement.querySelector('input');
const click = (dom, el) => dom.act(async () => { el.click(); });
const toSignup = async (dom) => click(dom, dom.findAll('button').find((b) => b.textContent === 'New here? Create account'));

function assertToggle(btn, shown) {
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.getAttribute('type'), 'button', 'a toggle that is not type=button submits the form');
  assert.equal(btn.getAttribute('aria-label'), shown ? 'Hide password' : 'Show password');
  assert.equal(btn.getAttribute('aria-pressed'), String(shown));
  const svg = btn.querySelector('svg');
  assert.ok(svg, 'an eye icon');
  assert.equal(svg.getAttribute('stroke'), 'currentColor', 'a stroke icon');
  assert.equal(svg.getAttribute('aria-hidden'), 'true', 'the icon is decorative; the label names the button');
  assert.equal(btn.style.width, '44px');
  assert.equal(btn.style.height, '44px');
  assert.equal(field(btn).getAttribute('type'), shown ? 'text' : 'password');
}

test('sign-in: the password field has a show/hide toggle that flips the field and its own state', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoginForm));
    const [btn] = toggles(dom);
    assert.ok(btn, 'no toggle on the sign-in form');
    assertToggle(btn, false);
    assert.equal(field(btn).getAttribute('autocomplete'), 'current-password');
    await click(dom, btn);
    assertToggle(btn, true);
    assert.equal(field(btn).getAttribute('autocomplete'), 'current-password', 'autocomplete survives the toggle');
    await click(dom, btn);
    assertToggle(btn, false);
  });
});

test('pressing the toggle does not submit the form', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoginForm));
    let submits = 0;
    dom.find('form').addEventListener('submit', (e) => { submits++; e.preventDefault(); });
    await click(dom, toggles(dom)[0]);
    await click(dom, toggles(dom)[0]);
    assert.equal(submits, 0);
    assert.equal(dom.find('h1').textContent, 'Sign in', 'still on the form');
  });
});

test('the toggle keeps the field focused and its caret where it was', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoginForm));
    const btn = toggles(dom)[0];
    const input = field(btn);
    await dom.act(async () => {
      input.focus();
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      set.call(input, 'hunter2abc9');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await dom.act(async () => { input.setSelectionRange(3, 6); });
    const down = await dom.pointer('pointerdown', btn, { pointerType: 'mouse' });
    assert.equal(down.defaultPrevented, true, 'pointerdown is prevented, so the press cannot blur the field');
    await click(dom, btn);
    assert.equal(field(btn).getAttribute('type'), 'text');
    assert.equal(dom.window.document.activeElement, input, 'focus stayed on the field');
    assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 6], 'the caret/selection did not move');
    assert.equal(input.value, 'hunter2abc9', 'the value is untouched');
  });
});

test('sign-up: toggle present, autocomplete new-password, and the rule is shown BEFORE typing', async () => {
  // A site key, so the form renders as it does in production (without one it shows the
  // "Sign-up is unavailable" alert instead of the captcha).
  process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY = 'test-site-key';
  await withDom(async (dom) => {
    await dom.mount(React.createElement(LoginForm));
    await toSignup(dom);
    const [btn] = toggles(dom);
    assertToggle(btn, false);
    const input = field(btn);
    assert.equal(input.getAttribute('autocomplete'), 'new-password');
    assert.equal(input.value, '', 'nothing typed yet');
    const rule = dom.find('#password-rule');
    assert.ok(rule, 'the rule is on screen before any input');
    assert.equal(rule.textContent, 'At least 10 characters, with a letter and a digit.');
    assert.equal(input.getAttribute('aria-describedby'), 'password-rule', 'and the field is described by it');
    assert.equal(dom.find('[role="alert"]'), null, 'shown as a hint, not as an error');
  });
});

test('"Set a new password": both fields have their own toggle, the rule is shown up front', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(ResetForm));
    const [a, b] = toggles(dom);
    assert.ok(a && b, 'a toggle on each field');
    assertToggle(a, false);
    assertToggle(b, false);
    for (const t of [a, b]) {
      assert.equal(field(t).getAttribute('autocomplete'), 'new-password');
      assert.equal(field(t).getAttribute('aria-describedby'), 'password-rule');
    }
    assert.equal(dom.find('#password-rule').textContent, 'At least 10 characters, with a letter and a digit.');
    await click(dom, a);
    assertToggle(a, true);
    assertToggle(b, false); // independent
  });
});

test('the rule text says exactly what validatePassword enforces', () => {
  assert.equal(rules.PASSWORD_RULE_TEXT, `At least ${rules.PASSWORD_MIN_LENGTH} characters, with a letter and a digit.`);
  const ok = (p) => rules.validatePassword(p) === null;
  assert.ok(ok('abcdefghi1'), '10 characters with a letter and a digit passes');
  assert.ok(!ok('abcdefgh1'), '9 characters fails');
  assert.ok(!ok('abcdefghij'), 'no digit fails');
  assert.ok(!ok('1234567890'), 'no letter fails');
});

test('no other password input in the app bypasses the toggle', () => {
  // Every <input type="password"> in a component must be PasswordField's own.
  for (const f of ['src/components/LoginForm.tsx', 'src/components/ResetPasswordSetForm.tsx']) {
    assert.doesNotMatch(read(f), /type="password"/, `${f} renders a bare password input`);
  }
});
