# Scale test, round 7

Where Session Desk stops working well as the data folder grows. Synthetic, invented data only (`tools/scale_home.py`); the app code is the `v7-round6` tag, unchanged.

## Summary: the three cliffs a heavy user hits first

1. **More than 10,000 sessions when fewer than 60 of them are automated: every list request re-reads 10,000 transcripts.**
   At 20,000 sessions with no automated runs, `/api/sessions` takes 11 s warm (p95 16 s), cold start 14.5 s, server CPU 92 % at one change a second, 500 changes took 225 s, RSS 474 MB. With the real-data mix (63 % automated) the same 20,000 sessions answer in 90 ms.
   Cause: the list loop stops only when both classes are full (`desk/sessions.py:356`, `if not mine and not any(room.values()): break`). A user with fewer than `RECENT_AUTO` (60) finished automated sessions never fills that room, so every transcript gets a list view on every request. Up to 10,000 files the views stay in memory (cold start still reads them all: 2.6 s at 5,000); past `CACHE_MAX` 10,000 (`desk/sessions.py:18`) and the summary file's `MAX_ENTRIES` 10,000 (`desk/summaries.py:15`) the least-recently-used eviction throws out exactly the views the next pass needs, so each request parses about 10,000 files again.
   User sees: the list and garden freeze for 10 s or more after every change; the page's fallback poll piles up requests.
   Fix (data): keep the three fields the loop decides on (`automated`, `shown`, `continuedIn`) for every file in a small index with no count bound (about 100 bytes a file, 2 MB at 20,000), and read full views only for rows that are listed; or, smaller, let `CACHE_MAX` and `MAX_ENTRIES` follow the number of files on disk. Expected: 20,000 sessions warm list back to about 90 ms (the stat pass), cold start limited to the listed rows plus one index read.
2. **When folders, live-process entries and subagent paths fill the 400 kernel watches, live transcripts lose their watch: updates arrive 0.5 to 1 s late, a first change to an older session up to 10 s late.**
   Seen at 200 live sessions (live append 711 ms, cold 9.6 s) and at 400 projects with 20 live (618 ms, 9.6 s); at 5 to 60 live and 5 to 40 projects the same appends arrive in 22 to 31 ms.
   Cause: `desk/watch.py:10` `MAX_FDS = 400` and the order in `desk/events.py:153` (`dirs + regs + liveness.watch_paths() + transcripts`): 400 project folders, or 200 registry files plus their subagent paths, use the whole budget before the first transcript. Unwatched hot and live transcripts wait for the 1 s timed pass; unwatched cold ones for the full scan every `FULL` 10 s (`desk/events.py:88`, the watch set is not `complete`).
   User sees: a working character's bubble and the list update about a second behind the CLI; a session resumed in a terminal appears up to 10 s later.
   Fix (server): put live and hot transcripts before project folders and registry files in `watch_list()`, and let the cap follow the descriptor limit (`budget()` in `desk/watch.py:49`: here the soft limit is 1,048,576 and the server holds 408 descriptors, so `select()`'s 1,024 is not in play; the HTTP server uses a poll selector). Expected: live and recent latency back to about 30 ms at 200 live and 400 projects.
3. **A transcript over 64 MB is re-read in full on every change.**
   At 100 MB: the list after one append to it 386 ms (64 MB: 115 ms, 30 MB: 76 ms), opening it after an append 304 ms (64 MB: 60 ms), server RSS 228 MB after the routes (64 MB: 157 MB), CPU at one append a second elsewhere 7.3 % (64 MB: 2.7 %). At 250 MB: 909 ms and 883 ms, RSS 504 MB, CPU 14.8 %, cold start 1.1 s.
   Cause: `desk/transcripts.py:564` keeps a parse state only when `st.offset <= STATE_BYTES` (64 MB, line 324); the same bound is the total for all 16 kept states (line 566), so a 64 MB file also pushes every other live file's state out.
   User sees: a long session that keeps working costs about a third of a core while it writes (est. from 0.3 to 0.4 s per change at 100 MB), and each list refresh lags by that much.
   Fix (data): always keep the state of the newest live file whatever its size (the way `FULL_MAX` always keeps the newest sidebar transcript), and count the 64 MB bound over the others. Expected: list after an append to a 100 MB file back to about 100 ms, RSS about 1.1 x the file instead of the 2.5 x full-read peak.

Smaller ones, by design but worth a word:
- **Miners: 5** (`web/src/actors.js:182` `MSLOTS`, `.slice(0, MSLOTS.length)` at line 189). Working sessions beyond 5 are not in the garden and nothing says so: 17 working, 5 miners, sign counts only the waiting (`w3`). Fix (garden): a "+N" mark at the mine like the sign's.
- **Working list: 30 rows** (`web/src/lists.js:25` `CAP`). At 60 and 200 live: "and 20 more / and 160 more. Search to find them." Fix (page): unfold like Resting.
- **Garden: 24 characters** (`web/src/garden_layout.js:25` `MAX_STAND`): works as designed, "60 need you +36", "200 need you +176".
- **Summary cache file** grows to 10.9 MB and 64 ms per write when 10,000 views are stored (only in the cliff 1 case); 250 to 350 KB and 2 to 3 ms otherwise.
- The sidebar draws at most `WINDOW` 400 events (`web/src/drawer.js:15`): 2,104 DOM nodes and 25 to 43 ms to open at every transcript size.

No cliff up to the largest size tried: page first render (450 to 900 ms), DOM (517 to 1,388 nodes), JS heap (2.1 to 2.5 MB), page CPU (under 2 % idle, under 6 % busy), search (1 to 15 ms), Stats panel (13 to 18 ms), health (1 ms; 94 ms only in the cliff 1 case), `/api/stats` (grows linearly with bytes: 0.1 s at 10 MB to 5.7 s cold at 1.1 GB, warm 0 ms), server idle CPU (0.2 % at 20,000 sessions). The page is bounded because the server caps the list at live + 120 rows.

## Middle point

2,000 sessions, 20 live (10 waiting), 30 MB biggest, 40 projects, 50 subagents, 134 MB; 60 % of finished sessions automated. Full run (not `--quick`), with page.

| Measure | Value |
|---|---|
| cold start to first list | 287 ms (list 204 ms) |
| list rows / live / waiting | 140 / 20 / 10 |
| warm `/api/sessions` | median 13 ms, p95 14 ms, 131 KB |
| `/api/sessions?ids=` 1 / 10 | 12 / 12 ms |
| `/api/session` small / median / biggest (29.9 MB) | 1 / 1 / 24 ms cold, 0 / 0 / 1 ms warm; 0 / 1 / 460 KB |
| `/api/stats` cold / warm | 635 / 0 ms |
| `/api/health` | 1 ms |
| feed latency live / recent / cold (first change) | 31 / 31 / 511 ms |
| list after an append to the biggest | 76 ms; open it after an append 24 ms |
| server RSS start / after routes / after 500 changes | 95 / 96 / 105 MB |
| server CPU idle / one append a second | 0.3 % / 2.9 % |
| descriptors open / soft limit; watches | 408 / 1,048,576; 400 of about 2,023 wanted (est.) |
| summary cache file | 343 KB, 315 entries, write 2.8 ms |
| health / format warnings / non-200 answers | ok / none / none |
| page first usable render | 478 ms; 947 DOM nodes; heap 2.3 MB |
| page idle / busy | 10 fps, 0.7 % CPU / 11 fps, 1.1 % CPU |
| sidebar biggest / median | 29 ms (2,104 nodes) / 15 ms |
| search keystroke to result; Stats open | 9 ms; 16 ms |
| garden | 10 characters, 5 miners of 10 working, sign "10 need you" |
| list rows drawn / held | 22 / 140; "Show 48 more", "60 automated runs" folded |

The feed latency for the biggest file (about 300 ms in every row) is the 300 ms `GAP` between two events to one listener: the test appends it right after the previous event. It is not a cost of the file.

## Ladder (one dimension at a time from the middle point, `--quick`)

Two ladder points ran at the same time, beside other engineers' suites; read differences under about 20 % as noise.

### Sessions (60 % automated)

| Sessions | MB | cold start ms | warm list ms (p95) | ids=10 ms | stats cold ms | feed live/recent/cold ms | RSS end MB | busy CPU % | page render ms |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 34 | 260 | 7 (8) | 6 | 206 | 29/26/28 | 95 | 1.5 | 484 |
| 500 | 57 | 307 | 9 (13) | 8 | 314 | 31/23/495 | 97 | 1.5 | 582 |
| 2,000 | 134 | 287 | 13 (14) | 12 | 635 | 31/31/511 | 105 | 2.9 | 478 |
| 5,000 | 293 | 363 | 49 (56) | 30 | 1,610 | 27/29/516 | 107 | 4.5 | 528 |
| 20,000 | 1,146 | 375 | 90 (99) | 94 | 5,673 | 29/29/1,576 | 136 | 11.0 | 554 |

Linear, no cliff: every list request stats every transcript (`desk/sessions.py:341-349`), about 4.5 µs a file, and the partial `?ids=` answer builds the whole list first (`sessions_for`, line 421), so it is no cheaper. Fix if wanted: reuse the change feed's `_scan["files"]` keys instead of a second glob and stat pass. The busy CPU (11 % at 20,000) is that pass once per change.

### Sessions with no automated runs (cliff 1)

| Sessions | cold start ms | warm list ms (p95) | stats cold ms | RSS routes / end MB | busy CPU % | 500 changes | summary file |
|---|---|---|---|---|---|---|---|
| 5,000 | 2,687 | 32 (39) | 1,399 | 131 / 168 | 4.7 | 0.8 s | 5.3 MB, 5,000 entries, 29 ms |
| 20,000 | 14,527 | 10,920 (16,135) | 4,897 | 474 / 317 | 91.8 | 224.8 s | 10.7 MB, 10,000 entries, 64 ms |

### Live sessions (10 waiting)

| Live | warm list ms | feed live/recent/cold ms | busy CPU % | miners / working | Working rows drawn |
|---|---|---|---|---|---|
| 5 | 12 | 31/22/495 | 2.0 | 0 / 0 | 0 |
| 20 | 13 | 31/31/511 | 2.9 | 5 / 10 | 10 |
| 60 | 24 | 22/26/498 | 3.0 | 5 / 50 | 30, "and 20 more" |
| 200 | 42 | **711/514/9,582** | 4.3 | 5 / 190 | 30, "and 160 more" |

### Waiting sessions (live = waiting + 10)

| Waiting | warm list ms | feed live/recent/cold ms | garden characters | sign | page busy CPU % |
|---|---|---|---|---|---|
| 3 | 13 | 29/31/49 | 3 | 3 need you | 0.9 |
| 24 | 17 | 24/31/500 | 24 | 24 need you | 1.1 |
| 60 | 21 | 24/24/509 | 24 | 60 need you +36 | 2.0 |
| 200 | 36 | **675/518/9,598** | 24 | 200 need you +176 | 5.6 |

### Biggest transcript

| MB | cold start ms | open cold ms | list after append ms | open after append ms | RSS start / routes / end MB | busy CPU % | sidebar ms |
|---|---|---|---|---|---|---|---|
| 5 | 231 | 4 | 68 | 4 | 50 / 50 / 53 | 1.8 | 29 |
| 30 | 287 | 24 | 76 | 24 | 95 / 96 / 105 | 2.9 | 29 |
| 64 | 417 | 58 | 115 | 60 | 157 / 157 / 160 | 2.7 | 34 |
| 100 | 506 | 332 | **386** | **304** | 165 / **228** / 237 | **7.3** | 41 |
| 250 | 1,064 | 925 | **909** | **883** | 347 / **504** / 527 | **14.8** | not run |

### Projects

| Projects | warm list ms | feed live/recent/cold ms | busy CPU % |
|---|---|---|---|
| 5 | 15 | 22/27/504 | 2.2 |
| 40 | 13 | 31/31/511 | 2.9 |
| 400 | 29 | **618/529/9,557** | 3.8 |

### Corners

| Corner | cold start ms | warm list ms | feed live/recent/cold ms | RSS end MB | busy CPU % | page render ms | garden |
|---|---|---|---|---|---|---|---|
| small: 100 sessions, 5 live, 3 waiting, 5 MB, 5 projects | 241 | 5 | 22/25/30 | 49 | 0.5 | 481 | 3 characters, 2 miners |
| second-largest: 5,000 sessions, 60 live, 60 waiting, 100 MB, 40 projects | 558 | 38 | 23/31/521 | 236 | 8.5 | 588 | 24 characters, "60 need you +36" |

In the second-largest corner the 100 MB file still re-reads on each change (list after append 380 ms, open after append 319 ms).

## Correctness at size

`python3 tools/scale_check.py --sessions 5000 --live 60 --waiting 30 --big 100` (363 MB):
- `tools/parity.py --home <folder>`: 0 mismatches in every field.
- Warm restart (same state folder) answers exactly the cold list: equal, same order.
- After 1,000 random changes (appends to live and random transcripts, registry status flips by rename, 43 new sessions), the list equals a fresh server's list on a new state folder: equal, same order, 180 rows.
- Every listed session opened, plus `?ids=`, stats and health: no answer other than 200.
- `/api/health` `ok` with no format warnings in all four servers. `formatChecked.anomalies` shows 176 "two programs": the test's appends carry the `cli` entrypoint into files written as the desktop app, so this is the test's doing.
Every ladder run also checks health and non-200 answers: all `ok`, none.

Not checked for correctness: the 20,000-session folders (time).

## Machine and conditions

Apple M5 Pro, 18 cores, 48 GB memory, internal SSD (APFS), macOS 26.6; Python 3.14.6, Node 26.8.1, Chrome 157.0.8103.50. Four other engineers' test suites, servers and headless Chromes ran at the same time (load average about 4), and two ladder points ran in parallel; timings carry that noise. Soft descriptor limit seen by the server: 1,048,576.

## Skipped

- 20,000 sessions in the other dimensions and in the correctness check; 250 MB only at the middle point, quick, without the page (run last, alone).
- Why the first change to a cold transcript is seen after about 0.5 s (not 10 s) while the watches are full but transcripts still have some: not isolated. A kqueue watch on a folder does not fire on an append to a file in it (checked), so another pass picks it up; later changes to the same file arrive in about 25 ms because it then counts as hot.

## Rerun

```bash
python3 tools/scale.py --sessions 2000 --live 20 --waiting 10 --big 30 --projects 40 --page   # one point, one table; --quick shortens, --json FILE keeps the numbers, --drop deletes the folder
python3 tools/scale.py --sessions 20000 --auto 0 --quick --drop                                  # cliff 1
python3 tools/scale.py --sessions 2000 --live 200 --quick --drop                                 # cliff 2
python3 tools/scale.py --big 100 --quick --drop                                                  # cliff 3
python3 tools/scale_check.py --sessions 5000 --live 60 --waiting 30 --big 100                    # correctness
```

Folders are built under `$TMPDIR/desk-scale/<shape>` (or `SCALE_BASE`) and reused unless `--fresh`; live entries point at `/bin/sleep` processes started and killed by each run; the server runs on a free port with a temp state folder and a stub CLI. Disk: about 5.2 GB written over this round's runs, at most about 2 GB at once (est.); all deleted.
