# QA round 4: soak, idle cost, accessibility, flows

Measured on `v4-round3` (branch `r4-qa`) in headless Chrome, real server on invented data (fixtures plus `tools/bench_home.py`, a stub CLI, free ports), demo mode for the crowd run.
Tools (no npm packages, free ports only, each prints a table, exits non-zero only when the tool itself breaks):

- `node tools/soak.mjs [--mode day|crowd|idle] [--minutes N] [--quick] [--every SEC] [--out FILE]`
- `node tools/a11y.mjs [--quick] [--order all] [--out FILE]`
- `node tools/flows.mjs [--quick] [--only reply,home,reload,two,search,hostile,crowd]`
- shared plumbing: `tools/qa_lib.mjs` (data folder, stub CLI, server, page probes, samplers)

Slopes per hour come from 15-minute (day), 5-minute (crowd) and 3-minute (idle) runs, so they are rough; floors and first/last values are the safer read.
The crowd and idle runs overlapped each other on the same machine; the day soak and the flows ran alone.

## Defects, by severity

### 1. High: the Terminal tab is a keyboard trap
- What: once focus is in the terminal, Tab, Shift+Tab and Esc all go to the CLI. A keyboard user cannot reach Close, the tabs or End terminal again without a mouse. Seen in all 4 Terminal contexts (1280 and 390 px, dark and light): the Tab walk stops at `textarea.xterm-helper-textarea`.
- Where: `web/src/drawer.js:152` skips the drawer's Tab handling for targets inside `.xt`; xterm (created in `web/src/terminal.js:42`) consumes Tab.
- Reproduce: `node tools/a11y.mjs --order all`, rows "sidebar Terminal": `trap YES`.
- Fix: give the terminal one documented way out, for example `term.attachCustomKeyEventHandler(e => !(e.type === 'keydown' && e.key === 'Tab' && e.ctrlKey))` plus a drawer keydown that moves focus to `#close` on Ctrl+Tab (Ctrl+Shift+Tab to the tabs), and name the key in the `#xtnote` hint.
- Owner: sidebar / terminal page code.

### 2. Medium: "End terminal" (or any SIGHUP end) is reported as "Terminal host stopped"
- What: ending a terminal in one page makes the other page (and a re-attach) print "Terminal host stopped. Open the Terminal tab again to start a new terminal." The host did not stop; only that CLI ended.
- Where: the host ends a terminal with SIGHUP (`desk/termhost.py:215`, also 308 and 438); `os.waitstatus_to_exitcode` turns that into `-1` (`desk/termhost.py:202`), which is the same value the server uses for "host gone" (`desk/terms.py:151`, 179, 192) and that `exitText(-1)` in `web/src/feed.js` maps to the host text. `web/src/terminal.js:103` retries once, then shows it.
- Reproduce: `node tools/flows.mjs --only two` (check "End terminal in one page ends it in the other": passes, but its measured tail shows the wrong text).
- Fix: keep `-1` for "host gone" only; report signal deaths as `128 + signal` (or send `{"exit": code, "signal": n}`) in `termhost.py` and `terms.py`, and let the page say "Terminal was ended" for them.
- Owner: terminal (server, with a small page text change).

### 3. Medium: a long search query breaks the page width
- What: a 2,000-character query without spaces gives 13,700 px of horizontal page overflow. The empty-list text `No match for “<query>”` does not wrap.
- Where: `web/src/lists.js:96` writes the query into `.none`; `web/styles/lists.css:28` has no wrap rule.
- Reproduce: `node tools/flows.mjs --only search` (check "2,000-character query": `overflow 13700`).
- Fix: `.none { overflow-wrap: anywhere }` (one line in `web/styles/lists.css:28`); optionally cut the echoed query to about 80 characters with an ellipsis.
- Owner: lists.

### 4. Medium-low: each terminal open/close keeps some memory and leaves unread POST responses
- What: 20 more open-Terminal, End terminal, close cycles on unchanged data: DOM node counter (after forced GC) 853 to 993 (about 7 retained detached nodes per cycle), heap 2.94 to 3.43 MB (about 25 KB per cycle); the in-document node count stayed at 459, so these are detached nodes. Every cycle also leaves one or two `POST /api/term/resize` or `/api/term/close` that the DevTools protocol never sees finish because nothing reads the response; in the 15-minute soak open requests went 1 to 32. Server-side TCP connections stayed at 1-2, so no socket leaks, and the page kept working.
- Where: fire-and-forget posts in `web/src/terminal.js:60` (resize, `.catch(() => {})` only) and `web/src/main.js` (`endterm`, `post('api/term/close', ...)`); terminal teardown in `web/src/terminal.js:120`.
- Reproduce: soak table row "page open requests" (`node tools/soak.mjs --minutes 5`), and the open/close cycle numbers above (the soak prints the open request paths in `extra.openReqs`).
- Fix: finish every fire-and-forget post: `post(...).then(r => r.body && r.body.cancel()).catch(() => {})`. Then re-measure; if detached nodes still grow, take a heap snapshot after 20 cycles and look for `Terminal`/`HTMLTextAreaElement` retainers (xterm's dispose and the `follow()` closure in `terminal.js:76` are the first suspects).
- Owner: terminal page code.

### 5. Medium-low: server CPU on a busy day is about a quarter of a core
- What: during the day soak (10 live sessions, two transcript lines a second, a 30 MB transcript growing about 2 KB a second, registry flips every 8 s) the server used 0.23 s CPU per wall second (median, max 0.36). Idle it uses 0.002. For a tool left on all day this is the largest steady cost found.
- Where: change feed checks recent and live transcripts every `INTERVAL = 1.0` s (`desk/events.py:10`); each change makes the page fetch `/api/sessions`, which rebuilds every summary. Not profiled this round.
- Reproduce: `node tools/soak.mjs --mode day --minutes 15`, row "server CPU s / wall s".
- Fix: profile one minute of the day soak (`python3 -m cProfile` on `server.py` with the same data) before changing anything; likely wins are caching summaries per file signature so a one-line append re-parses only that session, and not re-running `holders()` (an `os.kill` per registry file) on every fetch.
- Owner: server.

### 6. Low: a hidden tab still re-renders on every change
- What: with the tab hidden (second tab in front, `document.hidden` true) the canvas loop stops (0 rAF callbacks/s, page CPU 0.0011 s/s when nothing changes: good). But the change feed stays open and every pushed change still fetches `/api/sessions` and runs `renderAll()`; the garden is repainted every minute and actors re-dressed every 30 s. DOM node counter rose 497 to 549 in 3 hidden minutes with no data change.
- Still running while hidden: `setInterval(drawGarden, 60000)` (`web/src/main.js:109`), `setInterval(loadWeather, 900000)` (`web/src/main.js:114`), the 30-s re-dress interval (`web/src/actors.js:93`), the feed and its 30-s safety poll (`web/src/feed.js`), terminal streams (needed). Stopped: backdrop loop (`web/src/backdrop.js:647`), fishing (`web/src/fishing.js:94`), list animations (`web/src/lists.js:64`).
- Fix: while hidden, let the feed only mark "dirty" and run one `poll()` on `visibilitychange`; skip `drawGarden` and the 30-s re-dress when `document.hidden`.
- Owner: lists/page code (feed), garden (intervals).

### 7. Low: the garden loop wakes 60 times a second to paint 10
- What: visible and idle, the page runs 60 rAF callbacks/s and 1.4 layouts/s with nothing changing; page CPU 0.0195 s/s (2% of a core). The 14-character demo crowd: 87 rAF callbacks/s, 0.036 s/s, 44-45 running CSS animations.
- Where: `web/src/backdrop.js:648` requests every frame and skips until 95 ms passed (`:649`).
- Fix: schedule the next tick with `setTimeout(() => requestAnimationFrame(bgTick), 100)` so the page wakes about 10 times a second; check what causes the 1.4 layouts/s at idle (likely a forced layout in the per-tick path or tag layout).
- Owner: garden and backdrop.

### 8. Low: reduced motion leaves the terminal cursor blinking
- What: with `prefers-reduced-motion: reduce`, the main page has 0 running CSS animations and 0 canvas callbacks (good); the sidebar Terminal still runs `blink_block_1` on the xterm cursor. The preference is also read once at load (`web/src/state.js:10`), so changing it needs a reload.
- Where: `web/src/terminal.js:42` `cursorBlink:true`.
- Fix: `cursorBlink: !reduced`.
- Owner: terminal page code.

### 9. Low: one text colour just under 4.5:1
- What: the transcript prompt and reply marker `.ln .g` is 4.48:1 (`#8f8d88` on `#27272d`, 13 px), in every Transcript context.
- Where: `--t-dim` in `web/styles/drawer.css:3`, used at `:45`.
- Fix: `--t-dim: #93918c` (about 4.7:1 on `#27272d`, 5.6:1 on `#17171a`).
- Owner: sidebar.

### 10. Low: a listed session can be impossible to open
- What: `/api/sessions` lists any transcript file, but `/api/session` and the term routes accept only ids matching `[0-9a-fA-F-]{8,64}`; a transcript with any other name shows a row that opens to "Could not load this session" (404). Real CLI ids are UUIDs, so this only bites odd files.
- Where: `desk/web.py:216` versus the listing in `desk/sessions.py`.
- Fix: apply `transcripts.SID` when listing, or count such files in `formatChecked.anomalies` instead of listing them.
- Owner: data / server.

Expected noise (not defects): after each server restart the first `term/open` gets 403 and retries with the new token (`web/src/terminal.js:20`); with 6 terminals running `term/open` answers 409 and the tab says why. These are network errors in the console, not script errors. The soak saw no script exceptions.

## Soak: compressed day, 15 min (real server, invented data)

Driver: two transcript lines a second across 10 live sessions, a 30 MB transcript growing about 2 KB a second (30.9 to 32.9 MB), registry status flips every 8 s (107), one session appears and one finishes every minute (14 each), a sidebar opened every 20 s on a different session alternating Transcript and Terminal (43 opens, 21 terminals), Stats every minute (15), search typed and cleared every 40 s (22), two server restarts. 61 samples, every 15 s, heap after forced GC.

| metric | first | last | slope/h | note |
|---|---|---|---|---|
| page heap MB (after GC) | 2.10 | 4.73 | +6.8 | floor 2.10 to 4.27; grows with data (14 more sessions) and item 4 |
| page DOM nodes | 679 | 2484 | +2354 | floor 679 to 1396; swings 1400-2860 with the open sidebar and terminal; item 4 |
| page event listeners | 52 | 58 | +24 | floor 52 to 54: stable |
| page rAF callbacks / s | 69.5 | 67.4 | +1.5 | flat; item 7 |
| page CPU s / wall s | 0.03 | 0.03 | -0.01 | flat |
| page running CSS animations | 28 | 30 | -0.4 | flat |
| page open requests | 1 | 32 | +123 | unread POST responses, item 4 |
| page console errors (total) | 0 | 22 | +89 | network only: 403 after restarts, 409 at the terminal cap, refused while restarting |
| page live-region announcements | 0 | 63 | +251 | `#hits` 56 (all while a search was active), `#toast` 7 |
| server RSS MB | 79.4 | 67.6 | -62 | flat between restarts (31-89) |
| server CPU s / wall s | 0.22 | 0.25 | +0.06 | median 0.23, item 5 |
| server open fds | 6 | 8 | -2.7 | flat |
| server threads | 3 | 5 | -0.9 | flat |
| server TCP established | 1 | 2 | -0.2 | flat |
| termhost RSS MB | 23.3 | 17.1 | -31 | flat |
| termhost open fds | 8 | 12 | +14 | follows live terminals (cap 6) |

What grows: page heap and DOM node floors (data plus terminal cycles, item 4) and never-finished POSTs (item 4). Nothing on the server grows.
Isolated cycles on unchanged data: 20 Transcript open/close: nodes 816 to 833, heap 1.95 to 2.10 MB (stable); 40 searches: no change; 20 Stats open/close: about 7 detached nodes per open (small, same pattern as item 4).

## Demo crowd, 5 min (`?crowd=14`, garden only)

| metric | first | last | slope/h |
|---|---|---|---|
| page heap MB (after GC) | 1.98 | 2.23 | +1.3 |
| page DOM nodes | 641 | 632 | -5 |
| page event listeners | 59 | 59 | 0 |
| page rAF callbacks / s | 93 | 80 | -1.9 (mean 86.6) |
| page CPU s / wall s | 0.04 | 0.05 | mean 0.036 |
| running CSS animations | 45 | 44 | -3 |
| console errors | 0 | 0 | 0 |

No leak in the garden alone.

## Idle cost, 3 min each (dark, 1280 px, 4 waiting and 2 working sessions, nothing changing)

| | page CPU s / wall s | rAF callbacks / s | layouts in 3 min | server CPU s / wall s | DOM nodes |
|---|---|---|---|---|---|
| visible | 0.0195 | 60.1 | 248 | 0.0017 | 480 to 497 |
| hidden (second tab in front, `document.hidden` true) | 0.0011 | 0 | 5 | 0.0023 | 497 to 549 |

Hidden is close to free; visible costs 2% of a core for a still garden (item 7). What still runs hidden: item 6.

## Accessibility (1280 and 390 px, dark and light; main page, sidebar Transcript, sidebar Terminal, Stats)

| context (each width and theme) | interactive | unnamed | Tab stops | no visible focus | trap | contrast < min |
|---|---|---|---|---|---|---|
| main page | 19 | 0 | 19 | 0 | | 0 |
| sidebar Transcript | 9 (2 disabled or tabindex -1) | 0 | 6 | 0 | | 1 (item 9) |
| sidebar Terminal | 5 | 0 | 6, then stuck | 0 | YES (item 1) | 0 |
| Stats panel | 7 | 0 | 7 | 0 | | 0 |

Same result at 1280 and 390 px, dark and light. Tab order, main page: Stats button, the waiting characters newest first, the working miners, search, Working rows, Resting rows; sensible. Sidebar: tabs, Close, transcript, then the footer buttons, wrapping inside the dialog. Stats: period buttons, Close, the two charts.
Garden characters are buttons whose name has the title, the state and the wait ("Audit invented task 3: needs your answer, waiting 1 min (yellow, flower)"); miners say "working". No label problems.
Live regions: `#hits` (polite) and `#toast` (status). Over the 15-minute day: 63 announcements, about 8 per 2 minutes, all from typed searches and toasts; with 200 waiting sessions and nothing changing, 0 in 70 s. Not chatty.
Canvas-drawn text (sky, plaque art, scenery) is out of scope; text over the garden is measured against the garden's CSS colour, so it is approximate.

## Flows (`tools/flows.mjs`)

Not covered by `tools/smoke.mjs` or `tools/smoke_real.mjs` before this round: quick reply in real mode (ok and failing), Send home and Wake up, Reload terminal when behind, End terminal, two pages on one server, search text needing escaping, hostile session fields, very many waiting sessions, Stats and the transcript in real mode, light theme, narrow width, reduced motion.

| flow | result | numbers |
|---|---|---|
| quick reply: text reaches the stub, reply shows, failing run shows its error | pass | 0.46 s to the stub, 0.9 s to show; "Last reply failed: stub refused: invented failure" |
| Send home, survives reload, Wake up from the Transcript tab | pass | |
| Reload terminal when another program wrote | pass | note after 0.3 s, new CLI process after 0.15 s, note clears |
| two pages: both update, terminal in both, typing crosses, End terminal crosses | pass, wrong end text (item 2) | 2 feed listeners, 1 CLI process |
| search `<b>`, `&`, quotes, `it's`, `a < b && c`, `<img onerror>` | pass | no markup injected, under 1 ms each |
| 2,000-character search | FAIL (item 3) | 13,700 px overflow |
| HTML and 400-char unbroken strings in title, project, last message (1280 and 390 px) | pass | no markup runs, no overflow, tag 136 px, sidebar fits |
| 200 waiting sessions | pass | `/api/sessions` 42 ms (209 rows), garden full 0.19 s after navigation commit, 69 rAF/s, CPU 0.053 s/s, search 2 ms, sign "200 need you +176", one long task of 76 ms |

## Healthy

- No script exceptions in any run; no unnamed control in 16 contexts; every Tab stop shows focus; garden labels complete.
- Reduced motion: main page 0 CSS animations and 0 canvas callbacks in 5 s.
- Transcript open/close and search: no growth over 20 and 40 cycles.
- Server: RSS, threads, descriptors and connections flat over the soak and two restarts; idle CPU 0.002 s/s.
- Hidden tab: canvas loop stops, page CPU 0.0011 s/s.
- 200 waiting sessions stay responsive; escaping and hostile strings are safe.

## Not run or not covered

- The real CLI (stub only, by rule); screen-reader speech (names come from Chrome's accessibility tree); canvas text contrast; a minimised window (hidden was a second tab in front, which does set `document.hidden`).
- The server CPU in item 5 is not profiled; the per-hour slopes are extrapolated from short runs.

## Round 5 follow-up

- Item 1 (terminal keyboard trap): fixed. F6 or Ctrl+Shift+Left leaves the terminal; `tools/a11y.mjs` reports no trap in the four Terminal contexts.
- Item 2 (wrong end message): fixed. Exit codes are the CLI's own, 128 + signal, or -1 only for a lost terminal.
- Item 3 (long search query), item 8 (cursor blink), item 9 (contrast): fixed in round 4's merge.
- Item 4 (memory per terminal cycle): the detached nodes were held by this tool's own live-region probe, now a WeakMap. The page shows no node growth over 40 open/close cycles (`soak.mjs --mode term`). Unread request answers are released as well.
- Item 5 (server CPU on a busy day): fixed. The cause was a quadratic end-row search on files without a checkpoint line; the same day soak measures a median of about 0.02 CPU seconds per wall second, down from 0.22.
- Item 6 (hidden tab): fixed on the page side (no requests while hidden, one fetch on show) and in the garden's timers.
- Item 7 (garden loop wake-ups): the loop wakes about 10 times a second instead of 60; visible idle page CPU did not measurably drop.
- Item 10 (unopenable row): fixed. Only transcripts named by a session id are listed.

