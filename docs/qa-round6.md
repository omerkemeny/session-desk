# QA round 6: first ten minutes, soak, new flows, accessibility

Measured on `v6-round5` (branch `r6-qa`) on macOS with headless Chrome, `/usr/bin/python3` 3.9.6 for the zip runs, invented data only, a stub CLI, free ports.
Tools (no npm packages, free ports only, each prints a table and exits non-zero only when the tool itself breaks):

- `node tools/soak.mjs --mode day|crowd|idle|term [--minutes N] [--cycles N] [--quick] [--heap]`: new `--heap` (heap snapshot through DevTools at start and end, self size and count by class, top growth), new floor column (lowest value in the first and the last quarter), new row "page layouts / s".
- `node tools/a11y.mjs [--quick] [--order all]`: new Legend page contexts (both widths and themes, heading order, reduced motion), announcement count when a session starts waiting, "unreachable" now matched by element identity with the old text match shown beside it.
- `node tools/flows6.mjs [--quick] [--only pill,legend,f6,exits,elsewhere,diverged,restart,titles,midnight,counts]`: the flows added since round 4.
- `node tools/shot.mjs URL OUT.png [--width N] [--eval JS]`: one screenshot plus the status pill, lists, overflow and console errors (used for the first-ten-minutes walk).
- `tools/qa_lib.mjs`: `heapClasses`, `heapDiff`, `appCopy` (a private app copy so a flow can change page files), stub CLI exits 3 on the line `EXIT3`.

The first-ten-minutes walk was done by hand from the zip (commands below); the day soak ran alone for its first 13 minutes, then overlapped the crowd soak.

## Defects, by severity

### 1. Medium: a stranger with no `~/.claude` or no CLI sees a happy empty garden
- What: with an empty `HOME` (no `~/.claude`, no `claude` on `PATH`) the page says "live", "Nobody needs you. Enjoy the garden.", "No agent is working right now.", "No finished session here.", and `/api/health` says `"ok": true`. Nothing tells the new user that the data folder or the CLI is missing; only `python3 server.py doctor` does (2 FAIL lines, exit 1). Screenshot: `A-empty.png` in the walk.
- Where: `desk/web.py` `health()` (ok ignores the data folder and CLI); `web/index.html:28` quiet note; empty texts in `web/src/lists.js`.
- Reproduce: `env -i HOME=<empty dir> PATH=/usr/bin:/bin PORT=0 /usr/bin/python3 server.py`, then `node tools/shot.mjs http://127.0.0.1:<port>/ a.png`.
- Fix: health gets `dataFolder: false` / `cli: false` (and `ok` false); the page shows one line in place of the quiet note: "No Claude Code sessions folder at ~/.claude. Run `claude` once, or run `python3 server.py doctor`."
- Owner: server (health) + lists/page code (empty state) + docs (README "Run" should say what an empty first run looks like).

### 2. Medium: Terminal tab with the CLI missing says "CLI ended (code 127). Open the Terminal tab again to restart it."
- What: sessions present, no `claude` on `PATH`: the Terminal tab prints that line; reopening repeats it forever. No hint that the CLI was not found. Quick reply is untested here (the session was busy), but uses the same path.
- Where: `web/src/feed.js:106-111` `exitText`; the host runs a missing path and reports 127.
- Reproduce: scenario B below without the stub on `PATH`; open any row's Terminal tab.
- Fix: `exitText(127)` = "The claude CLI was not found. Install it or set DESK_CLAUDE_BIN; `python3 server.py doctor` checks it." (one line in `feed.js`), or the server refuses `term/open` with that text when `config.CLAUDE` is not executable.
- Owner: terminal page code (+ server).

### 3. Medium: read-only app folder passes `doctor`, then `start` crashes and terminals fail with "internal error"
- What: `chmod -R a-w session-desk`: `doctor` prints "all checks passed" (run folder "not created yet"); `python3 server.py start` dies with a `PermissionError` traceback on `.desk-run`; foreground `python3 server.py` starts, but the Terminal tab shows "Could not start the CLI: internal error" after about 5 s (blank before), `/api/health` still `"ok": true` with `termhost.error: null`.
- Where: `desk/doctor.py:46-50` `check_run_dir` (no write check when the folder does not exist); `desk/ctl.py:290` and `desk/termhost.py:95` (unhandled `makedirs`); `desk/web.py:163` (500 "internal error").
- Reproduce: unzip, `chmod -R a-w session-desk`, run `doctor`, `start`, then the foreground server and `tools/shot.mjs` with a Terminal open.
- Fix: in `check_run_dir`, when the folder is missing, `os.access(os.path.dirname(rd), os.W_OK)` else FAIL "cannot create <rd>; move the folder somewhere writable or set DESK_STATE_DIR"; `ctl.main` catches `OSError` and prints that one line; the term route returns the `OSError` text instead of "internal error".
- Owner: server; docs (README has no word on `DESK_STATE_DIR`, which `desk/config.py:16` reads).

### 4. Medium (accessibility): nothing is announced when a session starts waiting
- What: the expected behaviour is exactly one polite announcement; measured: 0 announcements in 20 s after a working session turned waiting (live regions are only `#hits` and `#toast`, both unchanged), and the page title does not change either. A screen-reader user never learns that a session needs them.
- Where: no code path; `web/src/actors.js:225-247` (sign count) is where the transition is known.
- Reproduce: `node tools/a11y.mjs --quick`, line "announcements in 20 s after one session started waiting": `{"total":0}`.
- Fix: one visually hidden `aria-live="polite"` element; when the set of waiting ids gains an id (not on every poll), write "<title> needs you" once; nothing on loss or re-render.
- Owner: garden (actors) / page code.

### 5. Low: Python 3.8 gives a raw `ModuleNotFoundError: No module named 'zoneinfo'`
- What: `python3.8 server.py` crashes with a traceback from `desk/stats.py:12`. README and guide say 3.9 or newer, and `doctor` says so (`FAIL python 3.8.10; needs 3.9 or newer`), but the server itself never says it. A stranger on an older Mac Python sees the traceback first.
- Where: `server.py:5` imports `desk.ctl` before any version check.
- Fix: in `server.py` before the import: `if sys.version_info < (3, 9): sys.exit("Session Desk needs Python 3.9 or newer (this is %s)." % sys.version.split()[0])`.
- Owner: server.

### 6. Low: port taken gives a 15-line traceback
- What: a second `python3 server.py` on a port in use ends in `OSError: [Errno 48] Address already in use` after a traceback through `ctl.py:282`, `app.py:40`, `app.py:27` and `socketserver.py`. README line 96 and guide line 218 quote the right words, so the docs hold, but a one-line message would match them better.
- Fix: catch `OSError` with `errno.EADDRINUSE` in `desk/app.py:40` and print "Port N is in use: open http://127.0.0.1:N, run `python3 server.py stop`, or start with PORT=9000."
- Owner: server.

### 7. Low: two foreground servers from one folder run side by side
- What: `python3 server.py start` refuses a second copy ("already running", exit 1), but a foreground `PORT=0 python3 server.py` next to it starts a second server on another port; `status` shows only the first. Both share `.desk-run` and the stats cache.
- Where: `desk/app.py` `main()` takes no run-folder lock (`desk/ctl.py` does for `start`).
- Fix: the foreground path checks `server.json` like `start` and prints "already running at <url>".
- Owner: server.

### 8. Low: `doctor` advice is off in two lines
- "data folder ... is missing or unreadable; set DESK_CLAUDE_DIR" (`desk/doctor.py:39`): for a new user the fix is "run `claude` once and log in"; DESK_CLAUDE_DIR is for unusual setups.
- "cli ... (version not asked; set DESK_CLAUDE_BIN to check it)" (`desk/doctor.py:26`): reads as if the user must set a variable; say "found" and stop, or ask `--version` with a short timeout.
- Owner: server (doctor text).

### 9. Low (docs): small mismatches a stranger hits
- `docs/guide.md:220`: "opened the page some other way than http://127.0.0.1:8765" is wrong when `PORT` is set; README line 99 says `<port>`, use that.
- README line 83: "`<that name>-summaries.json`" reads as `.stats-cache.json-summaries.json`; the file is `.stats-cache-summaries.json`.
- README Settings table lacks `DESK_STATE_DIR` (`desk/config.py:16`), the way out for a read-only folder (item 3).
- README "Run" says nothing about what a first run with no sessions looks like (item 1).
- The zip ships `docs/qa-round4.md` (an internal QA report) and `docs/api.md`, `docs/data-model.md`; harmless, but not for friends (`tools/make_zip.py` list).
- Owner: docs.

### 10. Low: a garden tag for an untitled session ends in a dangling " ·" at 390 px
- What: a session with an empty first prompt is named "project · branch" (as the guide says); at 390 px in a crowd the short tag reads `qa-work-aHuu2J ·`.
- Where: `web/src/garden_layout.js:124` `shortTitle` keeps the separator when it drops the branch word.
- Reproduce: `node tools/flows6.mjs --only titles --quick`, row "empty", `tag`.
- Fix: trim a trailing ` ·` (and `-`, `:`) after shortening.
- Owner: garden.

### 11. Info: "updated · reload" pill takes up to about 80 s
- Measured 72 s from a page-file change to the pill (`flows6 --only pill`). By design: the page asks health every 60 s (`HEALTH_EVERY`, checked every 15 s at `web/src/main.js:128`) and the server re-reads `webVersion` at most every 5 s. Click reloads and the pill is gone (pass). Only worth a line in the guide ("within a minute or so").

### 12. Low: server RSS still climbs within one server life on a busy day; cause not proven
- What: day soak, 20 min, three server lives (two restarts): RSS 77 to 85 to 81 MB, 84 to 89 then down to 57-64 MB, 90 to 97 MB then 122 MB at the last sample. The floor rises within a life (about +1 MB a minute in the third), and memory is returned at times (second life dropped 32 MB). Round 5 reported 77 to 87 MB in 5 minutes; the same shape. Python memory cannot be snapshotted from the DevTools side.
- Where (suspects, by reading): whole-transcript parses for the sidebar of the 33 MB transcript (`desk/sessions.py:122`), the parse-state cache in `desk/transcripts.py` (bounded by count, not bytes), and the summaries map.
- Reproduce: `node tools/soak.mjs --mode day --minutes 20`; per-life series from the saved JSON (`ss` grouped by `pid`).
- Fix: first measure: add `tracemalloc` top-10 to `/api/health?debug=mem` (dev only) or a `--trace-mem` flag, run the same soak, and compare snapshots at 1 and 6 minutes of one life; then bound the parse cache by bytes.
- Owner: server.

### 13. Low: server descriptors grow with every new session file (kernel watches), about 2 per new session
- What: open fds 205 at start (120 invented sessions plus fixtures), +11 to +19 per 6.5-minute life while one session appears a minute; 231 at the end. Not a leak (it follows files, and the cap is `MAX_FDS = 400` in `desk/watch.py:10`), but a user with a few hundred sessions sits at the cap from the start and is on the 1 s timed scan for everything past it.
- Fix: watch only recent and live transcripts plus the folders (the rest is the `FULL` scan's job); show `watches` and `watchCap` in health so the cap is visible.
- Owner: server.

## Soak: compressed day, 20 min (real server, invented data, `--heap`)

Driver as in round 4: two transcript lines a second across 10 live sessions, a 30 MB transcript growing to 33.6 MB, 143 status flips, 19 sessions appeared and 19 finished, 58 sidebar opens (29 terminals), Stats 19 times, 29 searches, two server restarts. 81 samples every 15 s, heap after forced GC. Floor = lowest value in the first quarter > in the last quarter.

| metric | first | last | floor q1 > q4 | slope/h | round 4 (15 min) | round 5 note |
|---|---|---|---|---|---|---|
| page heap MB (after GC) | 2.09 | 4.82 | 2.09 > 4.62 | +4.8 | 2.10 > 4.73, floor 2.10 > 4.27 | |
| page DOM nodes | 680 | 1177 | 680 > 1086 | +871 | 679 > 2484, floor 679 > 1396 | |
| page event listeners | 82 | 99 | 76 > 70 | -20 | 52 > 58 | |
| page rAF callbacks / s | 14.0 | 22.8 | 11.3 > 11.1 | +3.7 | 69.5 > 67.4 | about 10 expected |
| page layouts / s | 20.6 | 51 | 17.1 > 17.3 | +13 | not measured | |
| page CPU s / wall s | 0.02 | 0.05 | 0.02 > 0.02 | 0 | 0.03 | |
| page open requests | 1 | 3 | 1 > 3 | +7.7 | 1 > 32 | fixed; 2 `term/open` left open at the end |
| page console errors (total) | 0 | 40 | | | 0 > 22 | network only: 409 at the terminal cap, 403 after restarts, refused while restarting |
| page live-region announcements | 0 | 82 | | | 0 > 63 | `#hits` 73 (typed searches), `#toast` 9 |
| page `/api/sessions` fetches | 1 | 1198 | | | not measured | one a second, one per pushed change |
| server RSS MB | 77.3 | 107.1 | 77.3 > 93.8 | +57 | 79.4 > 67.6 (31-89) | 77 > 87 in 5 min; item 12 |
| server CPU s / wall s | 0.02 | 0.03 | 0.01 > 0.02 | +0.02 | 0.22 (median 0.23) | 0.02; still fixed |
| server open fds | 205 | 231 | 205 > 226 | +69 | 6 > 8 (no kernel watches then) | item 13 |
| server threads | 4 | 5 | 4 > 5 | | 3 > 5 | |
| server TCP established | 2 | 1 | 1 > 1 | | 1 > 2 | |
| termhost RSS MB | 23.7 | 19.0 | 18.9 > 19.0 | -14 | 23.3 > 17.1 | |
| termhost open fds | 8 | 12 | 8 > 12 | | 8 > 12 | follows live terminals |

Page heap snapshot, start > end (self size, after GC): JIT `code` +2.12 MB (13,975 > 29,302 objects), `ExternalStringData` +593 KB, `NetworkResourcesData::ResourceData` +456 KB (1,576 more: one per request, held by the DevTools Network domain the tool enables, so a tool artefact), `JSArrayBufferData` +156 KB (62 buffers, terminal streams), strings +142 KB. So of the +2.7 MB, about 2.6 MB is compiled code and DevTools buffers; app objects grow by well under 0.5 MB in 20 minutes. DOM nodes swing 1,150-2,560 with the open sidebar and terminal; the floor rise (680 > 1086) matches the 19 extra sessions in the lists.

## Demo crowd, 5 min (`?crowd=14`, garden only, `--heap`; overlapped the last 5 minutes of the day soak)

| metric | first | last | floor q1 > q4 | round 4 |
|---|---|---|---|---|
| page heap MB (after GC) | 2.11 | 2.57 | 2.11 > 2.56 | 1.98 > 2.23 |
| page DOM nodes | 647 | 637 | 635 > 637 | 641 > 632 |
| page event listeners | 120 | 124 | 120 > 124 | 59 > 59 |
| page rAF callbacks / s | 56.7 | 34.1 | 34.6 > 16.9 | 93 > 80 |
| page layouts / s | 14.7 | 3.7 | 1.7 > 1.9 | not measured |
| page CPU s / wall s | 0.03 | 0.03 | 0.02 > 0.03 | 0.04 > 0.05 |
| running CSS animations | 45 | 44 | 44 > 44 | 45 > 44 |

Heap growth +0.45 MB: JIT `code` +409 KB; `DOMRectReadOnly` +620 with `LayoutShift` +143 and `LayoutShiftAttribution` +310 (338 attributions x 2 rects = 676 rects): Chrome's layout-shift buffer, capped at 150 entries, so bounded. Not a leak; it does show the garden causes layout shifts (characters placed by `left`/`top`), about 1.8 layouts a second in a still crowd.

## Idle, 3 min visible then 3 min hidden (dark, 1280 px, 4 waiting and 2 working, nothing changing; `--heap`)

| | page CPU s / wall s | rAF callbacks / s | layouts / s | `/api/sessions` fetches | server CPU s / wall s | server RSS MB | DOM nodes |
|---|---|---|---|---|---|---|---|
| visible | 0.02 | 10.0-10.2 | 0.9-2.0 | 6 in 3 min (30 s safety poll) | 0.00 | 33.7 flat | 481 > 498 |
| hidden (second tab in front) | 0 | 0 | 0 | 0 | 0.00 | 33.7 flat | 498 > 498 |
| round 4 visible | 0.0195 | 60.1 | 1.4 | | 0.0017 | | 480 > 497 |
| round 4 hidden | 0.0011 | 0 | 0.03 | | 0.0023 | | 497 > 549 |

Hidden: 6 data changes while hidden, 0 requests; on show exactly 1 `/api/sessions` fetch within 5 s and the garden caught up (working rows 2 > 1 as the session turned waiting). Server fds 34 flat, threads 3.
Heap (visible phase) +0.36 MB: JIT `code` +350 KB and the layout-shift buffer (`LayoutShift` 150, the cap; 1,128 `DOMRectReadOnly` from 564 attributions). A still garden makes about 0.8 layout shifts a second.

### 14. Low: a still garden costs the same CPU as in round 4 and keeps shifting layout
- What: visible and idle, rAF is down to 10 a second (round 4 item 7 fixed), but page CPU is still 0.02 s per wall second and the page does about 1 layout and 0.8 layout shifts a second with nothing changing.
- Where: characters and tags positioned with `left`/`top` in `web/src/actors.js` (the boxes read at `:277-281` force layout each pass), plus the 10 Hz canvas loop in `web/src/backdrop.js`.
- Reproduce: `node tools/soak.mjs --mode idle --heap`, rows "page layouts / s" and the `LayoutShift` heap rows.
- Fix: move characters with `transform: translate()` and read rects only when the crowd changes; then re-measure CPU.
- Owner: garden.

### 15. Low: xterm throws after End terminal and close ("Cannot read properties of undefined (reading 'dimensions')")
- What: in 63 open/End/close cycles at least 10 uncaught exceptions from `Viewport._innerRefresh` in `web/vendor/xterm.js`, run from an animation frame xterm scheduled before `dispose()`. No visible effect, but they are the only script exceptions found this round.
- Where: `web/src/terminal.js:140` `killTerm` disposes while a viewport refresh is pending (the ResizeObserver at `:70` calls `fit.fit()` as the sidebar closes).
- Reproduce: `node tools/soak.mjs --mode term --cycles 60`, `extra.errs`.
- Fix: in `killTerm`, disconnect the observer, then dispose on the next frame: `const t = xt.term; requestAnimationFrame(() => requestAnimationFrame(() => t.dispose()));`.
- Owner: terminal page code.

## Terminal cycles, 60 (`--mode term --cycles 60 --heap`)

| after cycles | 0 | 20 | 40 | 60 |
|---|---|---|---|---|
| DOM nodes | 456 | 456 | 473 | 473 |
| heap MB | 3.12 | 3.53 | 3.57 | 3.62 |
| listeners | 54 | 54 | 54 | 54 |
| open requests | 1 | 1 | 1 | 1 |

0.28 nodes and 8.4 KB per cycle, flat after cycle 10. The heap snapshot puts the growth in JIT code (+461 KB) and DevTools network records (+104 KB); no `Terminal`, textarea or detached DOM classes grow. Round 4 measured 7 nodes and 25 KB per cycle; round 5's fix holds. Item 15 is the only finding.

## Flows (`tools/flows6.mjs`, new) and the round 4 flows again

Missing before this round (not in `tools/flows.mjs`, `tools/smoke.mjs`, `tools/smoke_real.mjs`): the update pill, Legend from Stats, F6 at 390 px, exit texts across pages for all three ends, reply box when open elsewhere, diverged, restart with Stats open and a search typed, odd titles, midnight, 0/1/500 sessions.

| flow | result | numbers |
|---|---|---|
| update pill: hidden at start, appears after a page file changes, click reloads, gone | pass | 72 s to appear (item 11), 1 reload |
| Legend link in Stats (visible, `legend.html`, new tab, `noopener`) | pass | |
| Legend page at 1280 and 390 px, dark and light: one h1, no heading jumps, no blank canvas, no overflow, no console error | pass | 14 sections, 61 headings, 25 canvases |
| F6 / Shift+F6 / Ctrl+Shift+Left in the Terminal tab at 390 px, F6 back in | pass | to `Terminal` tab, to `Send home`, back to the terminal; overflow 0 |
| exit texts in two pages: End terminal | pass | "Terminal ended. Open the Terminal tab again to start it." |
| CLI exit code 3 | pass | both pages "CLI ended (code 3). ..." |
| terminal host killed (SIGKILL) | pass | both pages "Terminal host stopped. ..." |
| quick reply while open in the desktop app | pass | box off: "Open in desktop app. Reply there, or in the Terminal tab, so both copies stay the same." |
| diverged (desktop branch off an early row, CLI continues) | pass | `consistency: diverged`, row badge "diverged"; the sidebar shows the left-out branch in the transcript, the `#sync` line stays hidden |
| restart with Stats open and a search typed | pass | offline at once, live after 2.5 s, search text and filter kept, Stats still open, no script error |
| titles: pasted block, slash command, empty, right-to-left, emoji, 300 characters (1280 and 390 px) | pass, one nit | titles 53, 7 ("/review"), "(session)" shown as project · branch, 29, 18, 60 characters; no overflow; item 10 |
| 0 sessions | pass | quiet note, "All quiet", both empty texts, no errors (but item 1 when the folder is missing) |
| 1 session | pass | 1 character, "1 needs you" |
| 500 sessions | pass | `/api/sessions` 117 ms (509 rows), live 3.5 s after navigation, 24 characters + 5 miners, sign "400 need you +376" |
| midnight rollover (page clock moved to 23:59:40 Israel time) | not proven | clock crossed to 00:01; the Today card read "0 tokens today" before and after because invented sessions carry about 35 tokens each; the tool needs sessions with real token counts to show the drop |
| hidden tab | see idle soak | |
| round 4 flows again (`flows.mjs --only reply,two,search --quick`) | 18 of 18 pass | reply 0.3 s to the stub; End terminal text now right in the other page; 2,000-character query: overflow 0 |

## Accessibility (`tools/a11y.mjs`, extended)

| context (1280 and 390 px, dark and light) | interactive | unnamed | Tab stops | no ring | trap | unreachable | contrast < min |
|---|---|---|---|---|---|---|---|
| main page | 19 | 0 | 19-20 | 0 | | 0 | 0 |
| sidebar Transcript | 9 | 0 | 6 | 0 | | 0 | 0 |
| sidebar Terminal | 5 | 0 | 9 | 0 | no (F6 leaves) | 0 | 0 |
| Stats panel | 9 | 0 | 9 | 0 | | 0 | 0 |
| Legend page (new) | 8 | 0 | 8 | 0 | | 0 | 0 |

- The "3 garden characters not reachable by Tab" of later runs is a tool artefact, now fixed in the tool. The old check matched Tab stops to the inventory by text, and a character's name contains its wait ("waiting under a minute" becomes "waiting 2 min") and changes between the inventory and the walk. Matched by element identity, all 3 are reached in every context (column "unreachable" 0, "unreach. by text" 3, printed as "only a text match misses (label changed during the walk)"). The walk now also waits until the garden's labels stop changing.
- Legend page: one h1, 61 headings with no level jumps, all controls named, focus visible, contrast passes in both themes; reduced motion: 0 rAF callbacks in 4 s, 0 running animations.
- Reduced motion on the main page, with the sidebar open and when switched on live with the Terminal tab open: 0 rAF callbacks, 0 running animations (round 4 item 8 stays fixed).
- Announcements: 0 when a session starts waiting (item 4). With nothing changing: 0.
- Live regions: `#hits` (polite), `#toast` (status).

## Healthy

- Spaces and non-ASCII in the folder path (`My Tools/séance-דסק/session-desk`): start, doctor, Terminal tab, Stats all work.
- Python 3.9.6 (`/usr/bin/python3`) and 3.14.6: server, doctor, sessions and stats answer.
- `start` twice refuses with the running URL; `status` finds the server without `PORT`; `stop` and `stop-terminals` report what they did; Ctrl+C prints "Session Desk stopped."
- Server CPU on the busy day 0.01-0.03 s per wall second (round 4: 0.22).
- No script exceptions in any run; console errors are network-only and expected (409 at the terminal cap, 403 after a restart).
- Open requests at the end of the day 3 (round 4: 32).
- Terminal exit texts right in both pages for all three ends; F6 way out at 390 px.
- Escaping, hostile titles, right-to-left and emoji titles, 500 sessions.

## Round 4 defects now

| # | defect | state | proof |
|---|---|---|---|
| 1 | Terminal tab keyboard trap | fixed | `a11y.mjs`: trap empty in 4 Terminal contexts, "F6 to Terminal"; `flows6 --only f6` at 390 px |
| 2 | End terminal reported as "Terminal host stopped" | fixed | `flows6 --only exits` and `flows.mjs --only two`: "Terminal ended." in the other page |
| 3 | long search query breaks the page width | fixed | `flows.mjs --only search`: overflow 0 |
| 4 | memory and unread POSTs per terminal cycle | fixed | `soak --mode term --cycles 60`: 0.28 nodes and 8.4 KB per cycle, open requests 1; day soak open requests 3 (was 32) |
| 5 | server CPU on a busy day | fixed | day soak 0.01-0.03 s/s (was 0.22) |
| 6 | hidden tab re-renders on every change | fixed | idle soak hidden: 0 requests, 0 layouts, nodes 498 flat over 6 changes; 1 fetch on show |
| 7 | garden loop wakes 60 times a second | fixed (wake-ups); CPU unchanged | idle soak: 10 rAF/s (was 60), page CPU 0.02 s/s (was 0.0195); item 14 |
| 8 | reduced motion leaves the cursor blinking | fixed | `a11y.mjs`: 0 animations after switching reduced motion on with the Terminal tab open |
| 9 | `.ln .g` contrast 4.48:1 | fixed | `a11y.mjs`: 0 contrast failures in every Transcript context |
| 10 | listed session that cannot be opened | fixed in round 5, not re-tested this round | |

## Not run or not covered

- The real CLI (stub only, by rule) and the default port 8765 (forbidden here; every run used a free port, so "Open http://127.0.0.1:8765" was read, not clicked).
- Linux; a screen reader's speech; canvas text contrast.
- Midnight rollover on real token numbers (see flows).
- Python memory profile of item 12 (needs a tracemalloc hook in the server).
- Quick reply with the CLI missing (the invented session was working, so the box was off).
