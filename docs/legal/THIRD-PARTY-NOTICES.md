# Third-party notices

The repository had no third-party notice file before 2026-11-23; this is it. Add an entry for every
third-party file we serve to browsers unmodified or under a licence that asks for a notice.

## SoundTouchJS AudioWorklet (`@soundtouchjs/audio-worklet` 2.1.1, with `@soundtouchjs/core`, `@soundtouchjs/worklet-base`, `@soundtouchjs/interpolation-strategy-lanczos` 2.1.1)

- **Used for:** the player's slow-down with pitch kept (Phase C C1, Beta): 90% and 75%.
- **Licence:** Mozilla Public License 2.0 (MPL-2.0), <https://mozilla.org/MPL/2.0/>.
- **Copyright:** Steve 'Cutter' Blades and contributors. Source: <https://github.com/cutterbl/SoundTouchJS>
  (`packages/audio-worklet`), npm `@soundtouchjs/audio-worklet@2.1.1`.
- **What we ship:**
  - `apps/web/public/vendor/soundtouch/soundtouch-processor.js`: the package's `.dist/soundtouch-processor.js`,
    **unmodified** (test `play-slowdown.test.mjs` checks it byte-for-byte against the installed package).
  - `apps/web/public/vendor/soundtouch/soundtouch-processor.js.map`: the package's source map, unmodified. It
    carries the original TypeScript sources (`sourcesContent`), so the Source Code Form is served next to the
    Executable Form.
  - `apps/web/public/vendor/soundtouch/LICENSE`: the package's own LICENSE file (a pointer to the MPL-2.0 text).
  - The main-thread `SoundTouchNode` class, bundled by Next.js from the unmodified npm package.
- **Obligations (MPL-2.0 is file-level copyleft):** we do not modify these files. If we ever do, the modified
  files must be offered as source under MPL-2.0. Our own code that uses them is not affected.
- **Licence gate (Jon, 2026-11-23):** the package README says it "Moved from LGPL to MPL-2.0", and it ports
  SoundTouch C++, which is LGPL-2.1. How that relicensing was done is not verified. **Confirm the SoundTouchJS
  MPL relicensing before promoting slow-down beyond Beta.**
