# QA round 9: first ten minutes with the new docs, round 8 flows, soak with a memory baseline, accessibility

Measured on `v9-round8` (branch `r9-qa`) on macOS with headless Chrome, `/usr/bin/python3` 3.9.6 for the zip runs, invented data only, a stub CLI, free ports.
Tools (no npm packages, free ports only, each prints a table and exits non-zero only when the tool itself breaks):

- `node tools/flows9.mjs [--quick] [--only transcript,title,firstrun,mine,more,notes,drift,oneserver,restart]` (new): grouped tool lines, Enter and click, Details switch and its persistence, failed call, hostile and 20,000-character results, live update with groups open; tab title and announcements; first-run states on the real server (no data folder, no CLI, read-only app folder, Python 3.8 when installed); mine "+N" with 12 working; "Show N more" with 60 working; door notes; 200 random changes then `window.desk.checkDrift()`; one server per folder; restart with groups open and a search typed. Full run about 4 minutes.
- `node tools/a11y.mjs [--quick]`: now also a session with grouped tool lines (contexts "Transcript groups open" and "Transcript Details on"), 30 more working sessions (mine plaque, Working "Show N more") and two also open in the desktop app (door notes), plus a "round 9 controls" line from the accessibility tree.
- `tools/qa_lib.mjs`: `toolSession()` writes an invented transcript with tool calls in the CLI's record shape (three groups, a failed call, hostile and very long results); `HOSTILE`, `LONG`.
- `tools/soak.mjs` was run as it is (owned by a page engineer). Server memory sites were read from `/api/health` `memTop` once a minute with `DESK_TRACEMALLOC=1` (the tool passes the environment through).

## Defects, by severity

### 1. Medium (data match): a session open in one ordinary terminal is reported "open twice" and gets a door note
- What: `also` lists every live holder that is not the page's own terminal, so a session that runs only in the user's terminal (registry `entrypoint: "cli"`, no page terminal) gets `also: ["another terminal"]`. The row badge reads "open twice", its tooltip "Also open in another terminal. Messages typed in one place do not show in the other.", and since round 8 the mine door pins a note "out of step" for it (`syncNotes`). With three or more sessions running in terminals the door always carries 3 notes. The session is open once; the CLI shows nothing unusual.
- Where: `desk/sessions.py:100-103` `elsewhere()` (rule unchanged since `910598b`); shown by `web/src/logic.js:179-181` `badges` and `web/src/world_data.js:24` `syncNotes`.
- Reproduce: `node tools/flows9.mjs --only notes`, row "open in one terminal only: not "open twice" (also empty)": measured `also61: ["another terminal"]` for a session with one registry entry; 3 notes for 3 sessions of which only 2 are open in two programs. In the `a11y.mjs` data (32 working sessions, each with one registry entry, two also in the desktop app) all 30 listed Working rows say "open twice".
- Fix: count a holder as "elsewhere" only when the page holds the session too (`terms.own_pid(sid)` set) or when there are two or more holders; e.g. `others = [...]; return sorted(...) if (terms.own_pid(sid) or len(others) > 1) else []`.
- Owner: server (data); the Legend row "notes on the mine door" and the guide line 96 then hold as written.

### 2. Medium: `doctor` fails the port check while this folder's own server runs on another port
- What: with this folder's server running on port 51225 (`PORT=0`), `doctor` printed `FAIL  port  8765 is used by another program…` and "1 check(s) failed: the app cannot work until the FAIL lines are fixed", exit 1, although the app worked. README lines 46-47 promise exit 1 only when a FAIL line stops the app.
- Where: `desk/doctor.py:78-94` tests `config.PORT` without asking `ctl` whether this folder's server is running.
- Fix: when the run record names a live server for this folder, print `ok  port  server running at http://127.0.0.1:N`; otherwise a busy default port is `warn`, not FAIL.
- Owner: server.

### 3. Low: a page click on a sidebar tab while no session is open throws (`drawDrawer(undefined)`)
- What: `main.js` takes `s = state.S.find(x => x.id === st.open)` and calls `drawDrawer(s)` for `[data-view]`, `reterm`, `endterm` buttons without checking `s`. Clicking a tab button of a sidebar that is not (yet) open for a listed session throws `TypeError: Cannot read properties of undefined (reading 'status')` (`logic.js:33` via `drawer.js:108`) or `(reading 'full')` (`drawer.js:30` via `patchLog`). The hidden sidebar keeps its old buttons in the DOM, so a script or a fast click during `openDrawer`'s fetch reaches them.
- Measured: 1 exception in 60 terminal cycles (`soak --mode term --cycles 60`, the click right after a row click); 4 in the first `a11y.mjs` run, where the tool clicked the Transcript tab of a closed sidebar.
- Where: `web/src/main.js:61-67`.
- Fix: `if (!s && (d.view || d.act === 'reterm' || d.act === 'endterm' || d.answer)) return;` after line 61; and clear the sidebar's markup on close.
- Owner: sidebar page code.

### 4. Low (accessibility): group lines and open folds carry the "▾" glyph in their accessible name
- What: an open group line is announced "Ran 3 shell commands ▾" (accessibility tree name), an open fold "… ▾ hide". The glyph comes from CSS generated content.
- Where: `web/styles/drawer.css:101` `.xp[open] > summary > .txt::after { content: " ▾" }` and `:92` `.fold[open] > summary .txt::after { content: "  ▾ hide" }`.
- Reproduce: `node tools/flows9.mjs --only transcript`, row "group line: disclosure role, expanded state, name is the group words only (no glyph)".
- Fix: CSS alternative text, `content: " ▾" / ""` (and `"  ▾ hide" / ""`); the expanded state is already announced by the disclosure role.
- Owner: sidebar page code.

### 5. Low: a read-only app folder shows no notice on the page when sessions are listed
- What: foreground server on a read-only folder: health `setup.stateDir: "readOnly"` with the hint "This folder is read-only: start with DESK_STATE_DIR=…", but the page shows nothing (no quiet note, no line under the search box); the user learns it only from the Terminal tab's 409 text. README line 51 says "the page shows the same sentence".
- Where: `web/src/logic.js:294-297` `setupNotes` builds `cliOff` only from `s.cli`.
- Reproduce: `node tools/flows9.mjs --only firstrun`, row "page notice with sessions listed": `{"quiet":"","setup":"","none":"No agent is working right now."}`.
- Fix: `cliOff` also when `s.stateDir !== 'ok'`: "Terminals are off: <hint>".
- Owner: lists page code (+ docs if kept as is).

### 6. Low: `PORT` is not checked
- `PORT=abc` gives "Session Desk stopped: ValueError: invalid literal for int() …" (server, `start` and `doctor` alike); `PORT=99999` gives "OverflowError: bind(): port must be 0-65535.".
- Where: `desk/config.py:13`. Fix: validate and print "PORT must be a number from 0 to 65535 (got 'abc')."
- Owner: server.

### 7. Low (accessibility): a Legend tag in the light theme is 3.52:1
- `span.tn "Tidy README"` (the day-old example, `web/src/legend.js:86`) is rgb(132,138,130) on white, 12 px: 3.52:1 < 4.5:1, at 1280 and 390 px, light theme only. Dark theme passes. The dimming is the point of the row, but it is text.
- Fix: a darker muted grey for `.tn` in the light theme (for example rgb(108,114,106), about 4.9:1), or draw it larger.
- Owner: garden/legend.

### 8. Low: server memory follows the newest live transcript's parse state (baseline for the data change this round)
- With `DESK_TRACEMALLOC=1`, the largest site by far is `json/decoder.py:361` (objects decoded from transcripts): 38.0 MB in 135,765 blocks at the start of the day soak (big transcript 30.8 MB), 40.9 MB after 6.5 minutes, 46.4 MB in 233,248 blocks at the end (33.5 MB). It grows about 0.5 MB a minute while the transcript grows about 0.13 MB a minute, and a server restart does not shrink it (42.9 MB 8 s after the second restart): the whole newest transcript is held parsed, at about 1.4 times its file size. Next sites are under 0.7 MB each (`socket.py:340`, `desk/sessions.py:198`, `desk/transcripts.py:455`, `:443`, `:366`).
- Server RSS per life (20 min, tracemalloc on): 96 > 105 MB, 100 > 116 MB (peak 143), 106 > 153 MB. Without tracemalloc (6 min): 85 > 87, 35 > 88, 34 > 89 MB, so a fresh life reaches about 88 MB within 2 minutes on this data. Round 6: 77 > 107 MB.
- tracemalloc costs: server CPU 0.06-0.09 s per wall second (median per life) with it, 0.010-0.012 without.
- Owner: data (bound the kept parse state by bytes; measure again with the same command).

### 9. Low (docs and pictures): see "Docs findings" below. Owner: docs.

### 10. Info
- Three different read-only sentences (`desk/firstrun.py:12`, `desk/ctl.py:23`, `desk/app.py:104`) and two "claude not found" sentences (`desk/firstrun.py:13`, `desk/termhost.py:45`); the README quotes one of each.
- `formatChecked` covers only files read since the server started: right after a restart `transcriptFiles` is 0 (`desk/transcripts.py:1300`).
- Opening `web/index.html` as a file shows the "demo · example data" pill and "Loading sessions…" forever (module scripts are blocked on `file://`).
- `status` on a fresh unzip prints "code version 2026-01-01 00:00:00" (the zip's fixed timestamps).
- `docs/data-model.md` ships in the zip, is linked from nowhere, and points to `tools/parity.py` and `tools/screen_check.py`, which are not in the zip.
- Door notes are drawn on the `aria-hidden` canvas and have no text alternative; the same fact is on the row badge and the character's tooltip, so nothing is lost (once item 1 is fixed).

## Docs findings (the zip's README.md and docs/guide.md, then VERSIONS.md)

| Where | The doc says | What happens | Suggested |
|---|---|---|---|
| README.md:51 | "the page shows the same sentence" | True for no data folder, unreadable folder, missing CLI. With no sessions the terminal says "No Claude Code sessions yet: …" but the page shows only "No agent is working right now." / "No finished session here."; read-only folder: no page notice (item 5). | "…and the page shows it too (with no sessions yet, the lists are simply empty)". |
| README.md:46-47 | doctor exits 1 only when a FAIL line stops the app | FAIL and exit 1 for the port while this folder's server runs on another port; read-only folder gives two FAIL lines although the foreground server runs | item 2 |
| README.md:162 | the Terminal tab and the line under the search box "say the same" | Terminal tab and `/api/term/open`: "The `claude` command was not found. Install Claude Code, or set DESK_CLAUDE_BIN to its path." (409); under the search box: "Terminals and quick replies are off: The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN. Run `python3 server.py doctor` …" | one string, or quote both |
| README.md:163 | `This folder is read-only: start with DESK_STATE_DIR=…` | That exact sentence appears only in health `setup.hint` and doctor. Foreground prints "This folder is read-only (<dir>), so page terminals are off and caches last for this run only; start with DESK_STATE_DIR=<a folder you can write> to keep them."; `start` prints "Session Desk cannot write in <dir>: start with DESK_STATE_DIR=…, or run `python3 server.py` in the foreground (page terminals are off there)." | quote what each prints |
| README.md:173, guide.md:108 | "demo · example data": opened from another address, shows invented sessions | `http://[::1]:PORT/` is refused (server binds 127.0.0.1), another Host gets 403 `{"error": "local only"}`; only `file://…/web/index.html` shows the pill, and then "Loading sessions…" forever, no invented sessions | "You opened web/index.html as a file; open the address the server printed." |
| README.md:178 | `formatWarnings` in http://127.0.0.1:8765/api/health | fixed port; an unknown record type lands in `formatNotes`, not `formatWarnings` | "`formatWarnings` and `formatNotes` in `/api/health` on the server's address" |
| README.md:34 | `restart`: stop and start again on the same port | on a foreground server it ends the foreground process ("Session Desk stopped.") and starts the new one in the background; not said | add "(the new server runs in the background)" |
| README.md:146 | `DESK_WATCH=0` turns off notifications | nothing in health says so; only `fds.watches` stays 0 | add `watch: false` to health, or say how to see it |
| README.md:7 (garden-day.png) | "six characters wait … with name tags and "?" bubbles, one fishes" | 5 tagged characters plus 1 untagged angler make the "6 need you"; two minis by the mine unmentioned; the picture shows the "demo · example data" pill | "five characters … and one fishes at the pond" |
| README.md:82 (stats.png) | six cards above "Today in the garden" with tokens, PRs, runs, who waits | cards match; the Today card also has the comet column; the panel heading reads "Usage", the button "Stats" | mention the comet; name the panel as the page does |
| README.md:97, guide.md:125 vs README.md:101 (transcript.png) | reads, searches and shell commands fold into one line | the picture shows Read, Read, Grep, Bash as four separate lines (demo data has no quiet flag, so nothing groups), and no Details switch | regenerate the picture from demo data whose tool events carry the 7th item |
| guide.md:14 (garden-night.png) | "characters sitting beside" the camp fire | nobody sits at the fire; two tags overlap ("Add CSV export to invoices page" into "Add retry to webhook sender"), one "?" bubble covers a tag's end | fix the alt text or the shot's clock |
| VERSIONS.md:18 | "Later versions add `v9-…`, `v10-…` below." | v9 is already listed | "Later versions add `v10-…` below." |
| VERSIONS.md:27, :33 | `git checkout <tag>`, then `git checkout main` | works in a clone only because git creates `main` from `origin/main`; a fresh clone's default branch is the source's HEAD (here `r9-qa`); `<tag>` leaves a detached HEAD (harmless, unsaid) | "`git checkout main` (the newest version)" plus one line on the detached HEAD |

Every troubleshooting row that could be caused here matches its quoted text except 162, 163 and 173 above: no data folder, no sessions (terminal), unreadable folder, second server ("Session Desk already runs for this data folder: pid N, http://127.0.0.1:P  (open it, or stop it with `python3 server.py stop`)"), `start` twice, port in use (exact), Python 3.8 (exact, `/usr/local/bin/python3.8`), `Session Desk stopped: …` (via `PORT=abc`), `server did not start (exit 1)`, "updated · reload" (72 s), `bad token, reload the page` (exact). Not caused: offline/polling pills, protocol mismatch, host newer, "Terminal host stopped" (covered by `flows6 --only exits` in round 6).
Every settings row worked as written (`PORT=0`, `DESK_CLAUDE_DIR` with the `<code>` names, `DESK_CLAUDE_BIN` and the `~/.local/bin/claude` fallback picked up live, `DESK_STATE_DIR`, `DESK_TERMHOST=0`, `DESK_TERMHOST_IDLE=5` (host gone 8-28 s later), `DESK_DEBUG=1`, `DESK_TRACEMALLOC=1`); `DESK_WATCH=0` only indirectly; `XDG_RUNTIME_DIR` and `CLAUDECODE` not tried.
The VERSIONS.md walk on a scratch clone worked end to end: `stop-terminals` ("1 terminals ended"), clean `git status`, `git checkout v6-round5`, `restart` on the same port with a terminal opening, back with `git checkout main` and `restart`.

## Flows (`tools/flows9.mjs`, full run: 3 failed, 45 passed; the 3 are items 1 and 4 and the read-only INFO of item 5)

| flow | result | numbers |
|---|---|---|
| group lines in the CLI's words | pass | "Ran 3 shell commands", "Read 2 files", "Ran 2 shell commands", "Read 1 file, ran 1 shell command" |
| groups closed at first, reachable by Tab; click opens with every result; Enter opens, focus stays | pass | tabIndex 0 on all 4; 3 results shown |
| failed call and its error visible under its closed group | pass | "Bash(make bad) ⎿ Error: Exit code 1 boom…"; shown once when the group is open |
| group line role and state | FAIL (item 4) | `DisclosureTriangle`, expanded true, name "Ran 3 shell commands ▾" |
| hostile result (img onerror, script, fixed-position element) | pass | 0 elements, `window.__pwn` unset, shown as text |
| 20,000-character line | pass | transcript, sidebar and page horizontal overflow 0; widest line 24 px inside the box |
| live update with groups open and focus on a group line | pass | redrawn in 0.2 s; open states and focus kept |
| Details switch | pass | aria-pressed false > true, 0 groups, 9 of 9 results shown, stored, still on after reload, off brings 4 groups back; focus stays on the switch |
| tab title | pass | "(1)" > "(2)" > "(5)" > "Session Desk" > "(1)", each within 0.1 s of the change |
| announcements | pass | 0 on load; 1 for one new wait ("Title invented 21 needs you"); 1 for three at once ("3 sessions need you"); 0 when all start working; 1 when one waits again |
| first run: no data folder | pass | health `ok: false`, hint; quiet note and Working column say "No Claude Code data found: run claude once, then reload."; 0 announcements over 35 s of polls |
| first run: data, no CLI | pass | line under the search box; Terminal tab "The `claude` command was not found…"; 0 announcements over 32 s |
| first run: read-only app folder | pass, page notice missing (item 5) | health `stateDir: "readOnly"`; Terminal tab says page terminals are off |
| Python 3.8 (`/usr/local/bin/python3.8`) | pass | "Session Desk needs Python 3.9 or newer; this is 3.8", exit 1, one line |
| mine "+N" with 12 working | pass | 5 miners + "+7" = "Working 12"; label "12 working, 7 not drawn: the mine has room for 5", role img; after 6 stop: 5 + "+1" = 6 |
| "Show N more" with 60 working | pass | 30 rows, "▾ Show 30 more", aria-expanded false; click: 60 rows, expanded, focus on row 31; Enter folds back |
| door notes | FAIL (item 1) | rule agrees (notes = min(3, sessions with `also`)), but a one-terminal session counts |
| partial list against the full list, 200 random changes (78 lines, 51 flips, 25 new, 19 gone, 27 renames) | pass | forced `checkDrift()`: drift 0, raced 0; page 74 rows = fresh `/api/sessions` 74 rows, `listDrift` empty; no drift warning |
| one server per folder | pass | second start, `PORT=0` or the same port: "Session Desk already runs for this data folder: pid N, http://127.0.0.1:P …", exit 1 |
| restart with groups open, focus on a group and a search typed | pass | offline at once, live after 2.5 s; groups 1 and 3 still open, focus still on "Read 2 files", search and its hits line kept, no errors |

## Soak

### Compressed day, 20 min (`DESK_TRACEMALLOC=1 node tools/soak.mjs --mode day --minutes 20`)
Driver as in round 6: 56 sidebar opens (28 terminals), 139 status flips, 18 sessions appeared and 18 finished, 19 Stats, 28 searches, two restarts; 30.8 MB transcript growing to 33.5 MB. 81 samples every 15 s.

| metric | first | last | lowest q1 > q4 | slope/h | round 6 (first > last, floor) |
|---|---|---|---|---|---|
| page heap MB (after GC) | 2.30 | 7.03 | 2.30 > 4.75 | +4.8 | 2.09 > 4.82, floor 2.09 > 4.62 |
| page DOM nodes | 742 | 1160 | 742 > 1155 | +1562 | 680 > 1177, floor 680 > 1086 |
| page event listeners | 83 | 77 | 71 > 77 | -1 | 82 > 99 |
| page rAF callbacks / s | 19.5 | 16.8 | 10.9 > 11.0 | +3.4 | 14.0 > 22.8, floor 11.3 > 11.1 |
| page layouts / s | 12.6 | 9.4 | 5.2 > 5.7 | +1.8 | 20.6 > 51, floor 17.1 > 17.3 |
| page CPU s / wall s | 0.02 | 0.02 | 0.01 > 0.01 | 0 | 0.02 > 0.05 |
| page running CSS animations | 23 | 17 | 7 > 7 | | not measured |
| page open requests | 1 | 3 | 1 > 3 | | 1 > 3 (2 `term/open` + events) |
| page console errors (total) | 0 | 38 | | | 0 > 40; network only (409 at the terminal cap, 403 after restarts, refused while restarting) |
| page live-region announcements | 0 | 128 | | | 0 > 82; `#hits` 74, `#say` 45 (new: one per new wait), `#toast` 9 |
| page `/api/sessions` fetches | 1 | 1172 | | | 1 > 1198 |
| server RSS MB | 96.4 | 152.8 | 87.9 > 116.5 | +130 | 77.3 > 107.1 (tracemalloc off); item 8 |
| server CPU s / wall s | 0.02 | 0.16 | 0.02 > 0.05 | | 0.02 > 0.03; with tracemalloc on, see item 8 |
| server open fds | 207 | 231 | 207 > 223 | | 205 > 231 |
| server threads | 4 | 5 | 4 > 4 | | 4 > 5 |
| server TCP established | 1 | 1 | 1 > 1 | | 2 > 1 |
| termhost RSS MB | 23.6 | 17.2 | 18.6 > 16.4 | -8 | 23.7 > 19.0 |
| termhost open fds | 8 | 12 | 8 > 11 | | 8 > 12 |

Short day without tracemalloc (6 min, same driver): server RSS per life 85 > 87, 35 > 88, 34 > 89 MB; server CPU 0.010-0.012 s/s median, at most 0.015; page heap 2.3 > 4.7; fds 207 > 219.
Server memory sites (`memTop`, once a minute, three lives): see item 8; full series in the scratch `memtop.log` of this run.

### Idle, 3 min visible then 3 min hidden (`--mode idle`)

| | page CPU s / wall s | rAF / s | layouts / s | `/api/sessions` fetches | server CPU | server RSS MB | DOM nodes |
|---|---|---|---|---|---|---|---|
| visible | 0.01 | 10.0 | 0 > 0.13 | 6 in 3 min | 0.00 | 35.2 flat | 519 flat |
| hidden | 0 | 0 | 0 | 0 | 0.00 | 35.2 > 21.9 | 519 flat |
| round 6 visible | 0.02 | 10.0-10.2 | 0.9-2.0 | 6 | 0.00 | 33.7 | 481 > 498 |

Hidden: 6 data changes, 0 requests; on show exactly 1 fetch within 5 s and the garden caught up (working rows 2 > 1). Round 6 item 14 (idle layouts) is fixed: 0-0.13 layouts a second against about 1.

### Demo crowd, 5 min (`--mode crowd`, `?crowd=14`)

| metric | first | last | lowest q1 > q4 | round 6 |
|---|---|---|---|---|
| page heap MB | 2.23 | 2.73 | 2.23 > 2.61 | 2.11 > 2.57 |
| page DOM nodes | 682 | 669 | 666 > 669 | 647 > 637 |
| page rAF / s | 15.8 | 10.0 | 10.0 > 10.0 | 56.7 > 34.1 |
| page layouts / s | 2.9 | 0.13 | 0 > 0 | 14.7 > 3.7, floor 1.7 > 1.9 |
| page CPU s / wall s | 0.01 | 0.01 | 0.01 > 0.01 | 0.03 |
| running CSS animations | 24 | 23 | 23 > 23 | 45 > 44 |

Two announcements (`#say` 1, `#toast` 1) at 15 s come from the demo's own simulated change.

### Terminal cycles, 60 (`--mode term --cycles 60`)

| after cycles | 0 | 20 | 40 | 60 |
|---|---|---|---|---|
| DOM nodes | 490 | 490 | 490 | 490 |
| heap MB | 3.13 | 3.54 | 3.77 | 3.82 |
| listeners | 55 | 55 | 55 | 55 |
| open requests | 1 | 1 | 1 | 1 |

0 nodes and 11.8 KB per cycle (round 6: 0.28 and 8.4 KB). No xterm "dimensions" exception any more (round 6 item 15 fixed); one other exception, item 3. One cycle in 60 waited over 10 s for "cli ready".

## Accessibility (`tools/a11y.mjs`, third pass; 1280 and 390 px, dark and light)

| context | interactive | unnamed | Tab stops | no ring | trap | unreachable | contrast < min |
|---|---|---|---|---|---|---|---|
| main page (now 11 waiting, 32 working) | 52 | 0 | 52-53 | 0 | | 0 | 0 |
| sidebar Transcript | 13-17 | 0 | 7-11 | 0 | | 0 | 0 |
| sidebar Terminal | 5 | 0 | 9 | 0 | no (F6 leaves) | 0 | 0 |
| Stats panel | 9 | 0 | 9 | 0 | | 0 | 0 |
| Legend page | 8 | 0 | 8 | 0 | | 0 | 0 dark, 1 light (item 7) |

- Grouped lines: native `<details>`/`<summary>`, role disclosure, expanded state announced, Tab reaches each, Enter and Space toggle; focus stays on the line through a live update and a server restart (flows9). Name carries "▾" (item 4).
- Details switch: a button with `aria-pressed` false/true, announced as pressed; focus stays on it after the redraw.
- "Show N more": a button with `aria-expanded`; unfolding moves focus to the first new row, folding keeps it on the button.
- Mine plaque: `role="img"` with the name "32 working, 27 not drawn: the mine has room for 5" (not focusable, which is fine: the Working list names everyone).
- Door notes: on the `aria-hidden` canvas, no name; the row badge carries the fact.
- First-run notices: plain text, not live regions, so 0 announcements over 30+ s of polls (not repeated); a screen reader meets them when reading the page.
- Announcements: one within 20 s of a session starting to wait, 0 in the next 2 quiet minutes; live regions `#hits`, `#toast`, `#say`.
- Reduced motion: 0 rAF callbacks and 0 animations on the main page, with the sidebar open, when switched on live with the Terminal tab open (34 animations before), and on the Legend page.
- Legend page: 71 headings (was 61), one h1, no jumps.
- The "Transcript groups open" and "Details on" contexts of the full run did not open the sidebar (tool selector, fixed); in the `--quick` rerun the groups session has 4 group lines as the first 4 Tab stops, then the header buttons; with Details on, 7 stops and no group lines. 0 unnamed, 0 contrast failures in both.

## Healthy

- Partial list refresh: 200 random changes, drift 0, page list equal to `/api/sessions` (74 rows).
- Tab title and announcements exactly as the guide says, also for three at once.
- Idle page: CPU 0.01 s/s, 10 frame callbacks, 0-0.13 layouts a second visible; nothing at all hidden; one catch-up fetch on show.
- Server CPU on the busy day without tracemalloc: 0.010-0.012 s/s.
- Terminal cycles: 0 DOM nodes per cycle, open requests 1.
- Hostile and 20,000-character results stay inert and inside the box.
- One server per folder, Python 3.8 refused in one line, port in use in one line.
- Every settings row and 12 of 15 caused troubleshooting rows match the README word for word.

## Earlier defects now

### Round 6

| # | defect | state | proof |
|---|---|---|---|
| 1 | empty HOME shows a happy garden | fixed | health `ok: false`, `setup.dataDir: "missing"`; terminal line, quiet note and Working column "No Claude Code data found…" (flows9 firstrun, zip walk) |
| 2 | CLI missing: "CLI ended (code 127)" | fixed | 409 "The `claude` command was not found. …"; Terminal tab says it (flows9) |
| 3 | read-only folder: doctor passes, start crashes, "internal error" | fixed | doctor FAIL lines, `start` one line, foreground runs with terminals off and a plain 409 text; page notice missing (item 5) |
| 4 | nothing announced when a session starts waiting | fixed | a11y: 1 announcement in 20 s, 0 in 2 quiet minutes; flows9 title |
| 5 | Python 3.8 traceback | fixed | "Session Desk needs Python 3.9 or newer; this is 3.8" |
| 6 | port taken: traceback | fixed | "Session Desk: port N is in use by another program; …" |
| 7 | two foreground servers side by side | fixed | flows9 oneserver: refused with the first address |
| 8 | doctor advice off | fixed | "does not exist yet: run `claude` once…"; "cli found at <path>"; new port FAIL (item 2) |
| 9 | docs mismatches | mostly fixed | `DESK_STATE_DIR` listed, first run described, summaries file named right, no QA report in the zip; left: README:178 fixed port, data-model.md shipped |
| 10 | dangling " ·" in a tag | fixed | `flows6 --only titles --quick` 6/6, tag `qa-work-ouPtly` |
| 11 | "updated · reload" up to 80 s | as designed | 72.3 s; guide says "within a minute or so" |
| 12 | server RSS climbs within a life | open, measured | item 8: decoded transcript objects 38 > 46 MB; RSS about 88 MB per life without tracemalloc |
| 13 | fds grow with new session files | unchanged, bounded | 207 > 231 (health `fds.watches` 201 at start) |
| 14 | still garden costs CPU and layouts | fixed | idle visible 0.01 s/s, 0-0.13 layouts a second |
| 15 | xterm "dimensions" exception after End terminal | fixed | 0 in 60 cycles; a different exception (item 3) |

### Round 4

| # | defect | state |
|---|---|---|
| 1 | Terminal tab keyboard trap | fixed (a11y: F6 leaves in all 4 Terminal contexts) |
| 2 | End terminal reported as host stopped | fixed in round 5, not re-run |
| 3 | long search query breaks the width | fixed in round 5, not re-run (20,000-character transcript line: no overflow) |
| 4 | memory per terminal cycle | fixed (0 nodes per cycle) |
| 5 | server CPU on a busy day | fixed (0.010-0.012 s/s without tracemalloc) |
| 6 | hidden tab re-renders | fixed (idle hidden: 0 requests, 0 layouts) |
| 7 | garden loop wakes 60 times a second | fixed (10 a second) |
| 8 | reduced motion leaves the cursor blinking | fixed (0 animations after switching live) |
| 9 | `.ln .g` contrast | fixed (0 contrast failures in every Transcript context) |
| 10 | listed session that cannot be opened | fixed in round 5, not re-run |

## Not run or not covered

- The real CLI and port 8765 (by rule); Linux; a screen reader's speech; canvas text contrast.
- Troubleshooting rows for the offline and polling pills, terminal host protocol mismatch, host newer than the server, "Terminal host stopped" (zip walk); `XDG_RUNTIME_DIR` and `CLAUDECODE`.
- The Terminal tab with the CLI missing was read from the sidebar text, not from a screenshot.
- The soaks overlapped: idle, crowd, the 6-minute day, the terminal cycles and the accessibility run shared the machine; page and server CPU are per process, so the overlap mainly adds noise.
