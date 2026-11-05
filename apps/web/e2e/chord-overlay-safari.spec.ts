// Manual QA stub for the Variant Y live chord overlay on iOS Safari.
//
// Playwright is not wired up in this repo yet; this file documents the
// steps Jon runs on a real iPhone before shipping PR-Y1.5b (real model).
// When Playwright lands, flip the top-level describe.skip() to describe(),
// `pnpm add -D @playwright/test`, and wire up webkit against a real iPhone
// via BrowserStack / Sauce / a local Mac + USB.
//
// Decision record: claude/phase-2-y1-chord-model-decision.md v1.3 §Browser.

/* eslint-disable @typescript-eslint/no-explicit-any */

const describeSkip: any = (globalThis as any).describe?.skip ?? (() => {});
const describeFn: any = (globalThis as any).describe;
const testFn: any = (globalThis as any).test ?? (() => {});
const expectFn: any = (globalThis as any).expect;

type AnyPage = any;

// ---------------- Manual QA checklist ----------------
// Steps Jon walks through on a real iPhone running the latest stable iOS:
//
//   1. Open https://stem-loops.com in Safari.
//   2. Navigate to the chord overlay beta surface.
//   3. Confirm a banner appears reading "Live chord overlay is desktop-only"
//      (text pinned in tab-capture.ts :: checkTabCaptureSupport).
//   4. Confirm the "Start live overlay" button is disabled — iOS Safari
//      users must not be able to mash a broken button.
//   5. Confirm no AudioContext is created and no getDisplayMedia prompt
//      appears (check via Web Inspector connected over USB).
//   6. Confirm the page does not crash under Low Power Mode or with
//      Background App Refresh disabled.
//
// If any step fails, DO NOT SHIP. Bump the defect into evals/bugs.json with
// a repro and the affected iOS version.

describeSkip('iOS Safari — manual QA stub (Playwright not yet installed)', () => {
  if (!describeFn || !expectFn) {
    // Allow this file to be lifted into a Playwright project without any
    // other change once the harness is set up.
    return;
  }

  testFn('shows desktop-only banner on iPhone', async ({ page }: { page: AnyPage }) => {
    await page.goto('/chord');
    const banner = page.getByTestId('unsupported-banner');
    await expectFn(banner).toBeVisible();
    await expectFn(banner).toContainText(/desktop/i);
  });

  testFn('start button is disabled', async ({ page }: { page: AnyPage }) => {
    await page.goto('/chord');
    const btn = page.getByTestId('start-overlay');
    await expectFn(btn).toBeDisabled();
  });

  testFn('does not request screen capture', async ({ page }: { page: AnyPage }) => {
    let requested = false;
    await page.exposeFunction('markRequested', () => {
      requested = true;
    });
    await page.addInitScript(function () {
      const orig = (globalThis.navigator as any).mediaDevices?.getDisplayMedia;
      if (orig) {
        (globalThis.navigator as any).mediaDevices.getDisplayMedia =
          function () {
            (globalThis as any).markRequested();
            // eslint-disable-next-line prefer-rest-params
            return orig.apply(
              (globalThis.navigator as any).mediaDevices,
              // eslint-disable-next-line prefer-rest-params
              arguments as unknown as unknown[],
            );
          };
      }
    });
    await page.goto('/chord');
    await page.waitForTimeout(500);
    expectFn(requested).toBe(false);
  });
});

export {};
