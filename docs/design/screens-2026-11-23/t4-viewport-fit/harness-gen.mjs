// usage: node gen.mjs <rev|WT> <top> <right> <bottom> <left> <out.html> <scene>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [rev, t, r, b, l, out, scene] = process.argv.slice(2);
const W = '/home/claude/wt-t4-viewport-fit/apps/web/';
const get = (p) => rev === 'WT' ? readFileSync(W + p, 'utf8') : execFileSync('git', ['-C', W, 'show', `${rev}:apps/web/${p}`], { encoding: 'utf8' });
const sai = (s) => s.replace(/env\(safe-area-inset-(top|right|bottom|left), 0px\)/g, 'var(--sai-$1)');
const css = ['src/styles/design-tokens.css', 'src/app/globals.css', 'src/components/play/Player.module.css', 'src/components/play/Sheet.module.css', 'src/components/setlists/SetLists.module.css']
  .map((p) => sai(get(p)).replace(/@import[^;]+;/g, '')).join('\n');
const banner = get('src/components/FlashBanner.tsx');
const bannerTop = sai(banner.match(/top: ('[^']*'|\d+)/)[1].replace(/'/g, '').replace(/^(\d+)$/, '$1px'));
const pmh = get('src/app/login/page.tsx').match(/minHeight: '([^']+)'/)[1];
const prw = get('src/styles/pricing-page.css').match(/\.pr-wrap[^}]*?min-height: ([^;]+);/s)[1];
const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>
:root{--sai-top:${t}px;--sai-right:${r}px;--sai-bottom:${b}px;--sai-left:${l}px}
${css}
.fb{position:fixed;top:${bannerTop};left:50%;transform:translateX(-50%);z-index:1000;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:8px;background:#151515;color:#fff;border:1px solid #444;font-size:14px}
.tr{display:flex;gap:8px;justify-content:space-around;padding:8px 12px;border-top:1px solid #333}.tr b{border:1px solid #666;border-radius:22px;padding:12px 18px}
.bar{height:64px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid #333}
</style></head><body>
${scene === 'login' || scene === 'pricing' ? `<main style="min-height:${scene === 'login' ? pmh : prw};padding:24px 16px;box-sizing:border-box;background:#111"><h1>${scene}</h1><p>Fits without scrolling when the page height is compensated.</p></main><pre id=m style="position:fixed;left:8px;right:8px;bottom:60px;margin:0;background:#400;color:#fff;font:14px monospace"></pre><script>addEventListener('load',()=>{const d=document.documentElement;m.textContent='scrollH '+d.scrollHeight+' / innerH '+innerHeight+(d.scrollHeight>innerHeight?'  SCROLLS':'  no scroll')})</script>` : scene === 'player' ? `<div class="fb">Saved to your library</div>
<div class="root"><div class="head" style="border-bottom:1px solid #333"><span class="back">&larr; Library</span><div class="titles"><div class="title">Song title</div><div class="sub">120 BPM &middot; A minor</div></div></div>
<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:72px">Am7</div>
<div class="tr"><b>-5</b><b>Play</b><b>+5</b><b>Loop</b><b>Mix</b></div></div>
<div class="backdrop modeless"><div class="sheet"><div style="padding:14px 0;border-bottom:1px solid #333">Mix</div><div style="padding:30px 0">Drums &middot; Bass &middot; Guitar &middot; Keys</div><div style="border:1px solid #666;border-radius:22px;padding:12px;text-align:center">Done</div></div></div>`
: `<div class="fb">Added to JAMS.</div><div class="bar">stem-loops</div><main class="page"><div class="head"><h1 class="title">Friday set</h1></div>${Array.from({length: 14}, (_, i) => `<div style="padding:16px;border:1px solid #333;margin:8px 0">Song ${i + 1}</div>`).join('')}<div class="submit-cta"><button style="width:100%;min-height:48px;background:#c6f432;border:0;border-radius:24px;font-weight:700">Create</button></div></main><p class="toast">Added to JAMS.</p>`}
</body></html>`;
writeFileSync(out, html);
