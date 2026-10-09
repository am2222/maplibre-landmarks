import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:5180/#16.4/48.857948/2.290982/-104.1/85');
await page.waitForTimeout(16000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
await page.evaluate(() => new Promise((r) => { const m = window.__demo.map; m.easeTo({ center: [2.2745, 48.8625], duration: 4000 }); setTimeout(() => m.easeTo({ center: [2.291, 48.858], duration: 4000 }), 4100); setTimeout(r, 8400); }));
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n])); const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map(); const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => { const d = (dt[i] ?? 0) / 1000; const seen = new Set(); let cur = id; let underTrees = false; const chain = [];
  while (cur !== undefined) { const c = byId.get(cur).callFrame; chain.push(c); if (/trees\//.test(c.url)) underTrees = true; cur = parent.get(cur); }
  if (!underTrees) return;
  for (const c of chain) { const key = `${c.functionName || '(anon)'} ${c.url.split('/').slice(-2).join('/').replace(/\?.*/, '')}:${c.lineNumber + 1}`; if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) ?? 0) + d); } } });
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(Math.round(v).toString().padStart(6), k);
await b.close();
