// @ts-check
// One-page look: open a URL in headless Chrome, save a screenshot and print the status pill, visible notes and console errors.
// Usage: node tools/shot.mjs URL OUT.png [--width N] [--wait MS] [--light] [--eval JS]
import { writeFileSync } from 'node:fs';
import { arg, flag, openPage, sleep, table } from './qa_lib.mjs';

const URL_ = process.argv[2], OUT = process.argv[3], W = Number(arg('--width', 1280)), WAIT = Number(arg('--wait', 4000)), EVAL = arg('--eval', '');
try {
  if (!URL_ || !OUT) throw new Error('usage: node tools/shot.mjs URL OUT.png [--width N] [--wait MS] [--light] [--eval JS]');
  const pg = await openPage(URL_, { width: W, dark: !flag('--light') }); await sleep(WAIT);
  if (EVAL) console.log('eval: ' + JSON.stringify(await pg.ev(EVAL)));
  const info = await pg.ev(`const t = s => { const e = document.querySelector(s); return e && !e.closest('[hidden]') ? e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 140) : ''; };
    return { title: document.title, pill: t('#mode'), upd: t('#upd'), lists: t('.lists'), empty: t('.empty') || t('.none'), toast: t('#toast'), overflow: document.documentElement.scrollWidth - innerWidth };`);
  writeFileSync(OUT, await pg.shot());
  console.log(table(['field', 'value'], Object.entries(info).map(([k, v]) => [k, String(v)])));
  console.log('console errors: ' + (pg.errs.length ? JSON.stringify(pg.errs.slice(0, 8)) : 'none'));
  await pg.close(); process.exit(0);
} catch (e) { console.log('FAIL tool error: ' + /** @type {Error} */ (e).message); process.exit(1); }
