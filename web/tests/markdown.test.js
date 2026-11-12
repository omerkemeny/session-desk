// Unit tests for the reply Markdown renderer in src/markdown.js, including hostile input; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline, renderMd } from '../src/markdown.js';

/** Every tag name in the output. @param {string} h */
const tags = h => [...h.matchAll(/<([a-z0-9]+)[\s>]/g)].map(m => m[1]);
const ALLOWED = new Set(['p', 'b', 'i', 'code', 'pre', 'a', 'div', 'span', 'blockquote', 'button']);

test('inline marks: bold, italic, code, links', () => {
  assert.equal(inline('**a** and *b* and `c`'), '<b>a</b> and <i>b</i> and <code>c</code>');
  assert.equal(inline('__a__ _b_'), '<b>a</b> <i>b</i>');
  assert.equal(inline('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4');
  assert.equal(inline('`**not bold**`'), '<code>**not bold**</code>');
  assert.equal(inline('[docs](https://x.dev/a)'), '<a href="https://x.dev/a" target="_blank" rel="noopener noreferrer">docs</a>');
  assert.equal(inline('see https://x.dev/a.'), 'see <a href="https://x.dev/a" target="_blank" rel="noopener noreferrer">https://x.dev/a</a>.');
});

test('blocks: headings, lists, quotes, fences, tables', () => {
  assert.equal(renderMd('# Title\ntext'), '<div class="mh h1">Title</div><p>text</p>');
  assert.equal(renderMd('- a\n- b'), '<div class="list"><div class="li l0"><span class="lm">-</span><span>a</span></div><div class="li l0"><span class="lm">-</span><span>b</span></div></div>');
  assert.match(renderMd('1. one\n  - nested'), /<span class="lm">1\.<\/span>.*class="li l1"/);
  assert.equal(renderMd('> quoted **x**'), '<blockquote><p>quoted <b>x</b></p></blockquote>');
  assert.match(renderMd('```js\nconst a = 1 < 2;\n```'), /<pre><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.equal(renderMd('| a | b |\n|---|---|'), '<pre class="tbl">| a | b |\n|---|---|</pre>');
  assert.equal(renderMd('line one\nline two\n\nnext'), '<p>line one\nline two</p><p>next</p>');
});

test('hostile input stays text', () => {
  const h = renderMd('<script>alert(1)</script> <img src=x onerror=alert(1)> "q"');
  assert.ok(!/<script|<img/.test(h));
  assert.ok(tags(h).every(t => ALLOWED.has(t)), tags(h).join());
  assert.ok(!/onerror=/.test(h.replace(/&lt;img src=x onerror=alert\(1\)&gt;/, '')));
  assert.equal(inline(renderMd('[x](javascript:alert(1))')).includes('href'), false);
  assert.equal(renderMd('[x](JaVaScRiPt:alert(1))').includes('<a'), false);
  assert.equal(renderMd('[x](data:text/html,hi)').includes('<a'), false);
  assert.ok(!renderMd('[x](https://a.dev/"onmouseover="alert(1))').includes('"onmouseover'));
  assert.ok(!renderMd('**<b>x</b>**').includes('<b>x</b>'));
  assert.equal(renderMd('0 marker'), '<p>0 marker</p>');
});

test('an unclosed fence runs to the end and is still escaped', () => {
  const h = renderMd('before\n```\n<b>code</b>\nmore');
  assert.match(h, /<pre><code>&lt;b&gt;code&lt;\/b&gt;\nmore<\/code><\/pre><\/div>$/);
});

test('very long lines and many markers render quickly', () => {
  const long = 'x'.repeat(200000), stars = '*a '.repeat(30000), under = '_'.repeat(50000), ticks = '`'.repeat(40000), links = '[a]('.repeat(20000);
  const t0 = Date.now();
  for (const s of [long, stars, under, ticks, links, '**'.repeat(50000), 'https://' + 'a'.repeat(100000)]) renderMd(s);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});
