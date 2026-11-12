# API contract

Every JSON route the page reads. `tests/test_contract.py` parses the tables below and fails when the server sends a field or event kind that is not listed here, or when a listed one is never sent (rows typed *optional* may be absent).
Fields may be added; none is renamed or removed. Rules behind the values: `docs/data-model.md`.

All routes are GET, on 127.0.0.1 only, and answer `{"error": "..."}` with 404 when an id or path is unknown.

## GET /api/sessions

A list: every live session, the newest finished ones a person typed into (`RECENT`) and the newest finished automated ones (`RECENT_AUTO`), one object each.

### sessions[]

| Field | Type | Meaning |
|---|---|---|
| `id` | str | Session id (the transcript's file name). |
| `title` | str | What the session is for, as `claude --resume` names it: its own title, its automatic title, else its latest prompt (the first one when none is recorded), tags removed, on one line; a placeholder title gives way to the prompt; numbered or extended with the topic when two active sessions share one. |
| `topic` | str | The latest request, first line, cut to 70 characters. |
| `project` | str | Base name of the working folder, `unknown` when none. |
| `branch` | str | Git branch of the last message. |
| `status` | str | `running`, `waiting` or `done`. |
| `statusAt` | int | Epoch ms of the live status, or of the page's own quick reply when newer; 0 when unknown. |
| `replyError` | str | Error of the page's last quick reply, empty when none. |
| `replyExit` | int | Exit code of the page's last quick reply; 0 when none ran or it succeeded. A non-zero code with an empty `replyError` means the run failed without output. |
| `term` | bool | A page terminal for this session is running. |
| `copies` | int | Live programs that hold the session open now, this page's own terminal included; 2 or more means it is open twice. |
| `also` | list of str | Other programs holding the session open: `desktop app`, `another terminal`, or an entrypoint name. |
| `subs` | list of str | Descriptions of running subagents, most recently active first (live sessions only). |
| `behind` | bool | The page terminal sits idle while another copy wrote newer messages. |
| `model` | str | Model of the last reply, empty for CLI-made rows. |
| `updated` | int | Epoch ms the transcript file last changed. |
| `tokens` | int | Tokens spent (input + output + cache writes), each message once, all branches. |
| `ask` | str | The latest reply, cut to 400 characters. |
| `last` | str | The latest reply on one line, cut to 160 characters. |
| `kind` | str | `headless` when only the headless CLI (`-p`) wrote rows, else `interactive`. |
| `automated` | bool | Nobody typed into it: `kind` is `headless`, or every prompt row was sent by a program (print mode, also when a hook started it from the desktop app). The field the page should fold. |
| `consistency` | str | `diverged` when another program wrote a branch off the shown conversation that the resumed conversation leaves out (see the `elsewhere` event), else `ok`. |
| `lastTool` | str | Name of the newest tool call shown, empty when none. |
| `lastError` | bool | The newest tool result shown is an error. |
| `prOpened` | int | Pull requests the session opened. |
| `waitingSince` | int | Epoch ms the session last stopped working; 0 when unknown. |
| `tokensToday` | int | Tokens (as `tokens`) of the shown conversation's messages written today in the Stats time zone; 0 after midnight until new ones. |
| `prsToday` | int | Pull requests (as `prOpened`) the shown conversation opened today in the Stats time zone. |

## GET /api/sessions?ids=ID,ID

Part of the list, for a page that knows which sessions changed (the `sessions` event's `ids`). At most 100 ids, each a session id, comma-separated; anything else is 400 with a plain message. Same guards as the full list.

### sessions.partial

| Field | Type | Meaning |
|---|---|---|
| `rows` | list | The full list's rows of the named sessions and of every session that is not `done`, byte for byte as `/api/sessions` sends them, in its order. |
| `gone` | list of str | Named ids the full list no longer holds (finished and pushed out, removed, or unknown). |
| `order` | list of str | Every id the full list holds, in its order. |
| `today` | str | The day (`YYYY-MM-DD`, Stats time zone) the rows' per-day figures (`tokensToday`, `prsToday`) are for. |
| `n` | int | The change-feed counter read before the rows were built: changes up to it are included. |

The page patches its list (`sessions.apply_partial` is the reference): replace or add `rows`, drop `gone`, reorder by `order`. It fetches the full list instead when `order` names an id it holds no row for (a session entered the list without changing itself), or when `today` differs from the day of its last full fetch.


## GET /api/session?id=ID

The conversation `claude --resume ID` shows.

### session

| Field | Type | Meaning |
|---|---|---|
| `events` | list | The conversation in order, one array per event (below). |
| `files` | list of [str, int] | Files the shown conversation edited and how many times, most edited first. |

### session.events

Each event is an array whose first item is its kind.

| Kind | Length | Items | Meaning |
|---|---|---|---|
| `you` | 2 | `["you", text]` | A prompt as the CLI prints it after `❯`: raw text, `/command args` (command tags without `<command-message>` stay raw, as the CLI shows them), `! command`, `[Image]` for an image-only prompt. |
| `claude` | 2 | `["claude", text]` | One reply text block. |
| `tool` | 7 | `["tool", name, hint, result, isError, display, quiet]` | A tool call: raw name, its most telling argument (300 chars), its result as the CLI's default view prints it under the call (`""` when none; a summary such as `Added 1 line, removed 1 line` or `Received 2KB (200 OK)` where the CLI prints one; an error as `Error: <text>` without the `<tool_use_error>` wrapper; other text cut to 4 lines), 1 when the result is an error, the line the CLI's detailed view prints (`Update(/a.txt)`, `""` when the CLI prints none; table in `docs/data-model.md`), and `quiet`: 1 when the call succeeded and the CLI prints no result line for it (every `Bash` call since round 7: the default view folds shell calls into `Ran N shell commands`) (the result text is then the raw output, for an expanded view), else 0. |
| `out` | 3 | `["out", text, isError]` | Output of a `!` command or a local slash command, under it: the newest `!` output and local output in full (400 lines), older `!` output cut to 3 lines plus `… +N lines` when longer than 4; 1 when stderr is not empty. |
| `compact` | 2 | `["compact", summary]` | The CLI's "Conversation compacted" line; `summary` is 1 when the CLI also prints `⏺ Compact summary` (the summary row is not marked transcript-only), else 0 (seen, round 7). |
| `interrupt` | 1 | `["interrupt"]` | The CLI's "Interrupted · What should Claude do instead?" line. |
| `image` | 1 | `["image"]` | One image attached to the prompt before it (`[Image #N]` under the prompt). |
| `elsewhere` | 3 | `["elsewhere", program, count]` | After this point another program (`desktop app` or `terminal`) wrote a branch the resumed conversation leaves out, holding `count` prompts and replies. |

## GET /legend.html, GET /gallery.html

Two fixed read-only pages from `web/`, sent as they are (`text/html`, no token, same Host, cross-site and safe-header rules as every answer); any other `.html` name is 404.

## GET /api/events

Server-sent events: `event: change` with the counter in `data` on connect and whenever the session list would change; the page then fetches `/api/sessions`.
Changes are coalesced: at most one change event per 300 ms per listener, the first after a quiet spell at once, the last of a burst never dropped. Each change event after the first follows a `sessions` event (below) in the same write.

### events.sessions

| Field | Type | Meaning |
|---|---|---|
| `n` | int | The counter of the change event that follows. |
| `ids` | list of str | Session ids whose transcript, live-process entries, subagents, page terminal or reply changed since the listener's previous change event; empty when `all`. |
| `all` | bool | The changed set is unknown or larger than 100: fetch everything. |

## GET /api/term/stream?id=ID

Server-sent events: `id: <byte offset>` with base64 output in `data`, `: ping` comments while idle, then one `exit` event whose `data` is the exit code below.
A stream that drops without an `exit` event (server restart, network) means nothing about the terminal: the page re-attaches with `Last-Event-ID`.

### term.exit

| Field | Type | Meaning |
|---|---|---|
| `0..127` | int | The CLI exited by itself with this code. |
| `128+n` | int | A signal `n` ended the CLI: 129 hang-up (End terminal, Reload terminal, `stop-terminals`), 130 interrupt, 137 kill, 143 terminate. |
| `-1` | int | Only when the terminal host or the server lost the terminal without knowing how it ended (host killed, host forgot the terminal). |

## GET /api/stats

Usage numbers, counted in a background worker; answered at once.

### stats

| Field | Type | Meaning |
|---|---|---|
| `ready` | bool | A result is available. |
| `updating` | bool | A recount is running. |
| `progress` | {done, total} | Files counted in the running recount. |
| `error` | str, optional | Last recount failure type; sent only while no result exists. |
| `today` | str, optional | Today in Israel time (`YYYY-MM-DD`); sent when ready. |
| `since` | str, optional | First day with data; sent when ready. |
| `tz` | str, optional | Time zone of the day boundaries; sent when ready. |
| `computedAt` | int, optional | Epoch ms of the count; sent when ready. |
| `periods` | object, optional | `today`, `7d`, `30d`, `all`, each a period summary (below); sent when ready. |
| `days` | list, optional | Per day `[date, sessions, prompts, tokens, outputTokens]`; sent when ready. |
| `streak` | {current, longest}, optional | Days in a row with a prompt; sent when ready. |

### stats.periods.all

| Field | Type | Meaning |
|---|---|---|
| `sessions` | int | Sessions started. |
| `memoryRuns` | int | Memory-save runs. |
| `prompts` | int | Prompts typed. |
| `answered` | int | Prompts that got a reply. |
| `planDone` | int | Task-list steps checked off. |
| `prs` | int | Pull requests opened. |
| `commits` | int | Commits made. |
| `tokens` | {input, output, cacheWrite, cacheRead} | Tokens by kind. |
| `models` | list of [str, int, int] | Top 5 models: name, messages, tokens. |
| `turn` | {median, p90, n} | Seconds per turn. |
| `active` | {median, total} | Active seconds per session. |
| `longest` | object or null | Longest session: `active`, `project`, `day`. |
| `tools` | list of [str, int] | Top 6 tools and their calls. |
| `toolCalls` | int | All tool calls. |
| `filesEdited` | int | Distinct files edited. |
| `commands` | int | Shell commands run. |
| `subagents` | int | Subagents started. |
| `hours` | list of 24 int | Prompts per hour of day. |
| `weekdays` | list of 7 int | Prompts per weekday. |
| `projects` | list of [str, int] | Top 5 projects by sessions. |
| `entry` | {desktop, terminal, other} | Sessions per program. |

## GET /api/health

Counts and names only, never text.

### health

| Field | Type | Meaning |
|---|---|---|
| `ok` | bool | No reload error, no format warning, change feed and terminal host fine. |
| `started` | int | Epoch ms the server started. |
| `pid` | int | Server process id. |
| `uptime` | int | Seconds since start. |
| `codeVersion` | int | Newest source time (ms) of the loaded code. |
| `webVersion` | int | Newest modification time (ms) of any file under `web/` the server may serve; re-checked at most every 5 s. A page whose scripts loaded before this time is out of date. |
| `reloads` | int | Hot reloads done. |
| `reloadError` | str | Last reload error, empty when none. |
| `restartNeeded` | list of str | Changed files that need a restart. |
| `terms` | int | Page terminals running. |
| `maxTerms` | int | Page terminals that may run at once (`MAX_TERMS`); opening one more is refused. |
| `termhost` | object | Terminal host state (below). |
| `events` | object | Change feed listeners (below). |
| `workers` | {events, stats} | Background workers (below). |
| `formatWarnings` | list | `{source, issue, count, field?}` per format problem. |
| `formatNotes` | list | Same shape, for tolerated oddities. |
| `formatChecked` | object | Totals of the format check (below). |
| `fds` | object | File-descriptor budget (below). |
| `setup` | object | First-run checks: data folder, sessions found, CLI, state folder and the first thing to do (below). `ok` is false unless `setup.dataDir` and `setup.stateDir` are `ok`. Re-checked at most every 5 s. |
| `memTop` | list, optional | Only with `DESK_TRACEMALLOC=1`: the ten largest allocation sites of the server, `{file, line, size, count}` (file path relative to the app or its last two parts, size in bytes); no data. Re-taken at most every 5 s. |

### health.setup

| Field | Type | Meaning |
|---|---|---|
| `dataDir` | str | `ok`, `missing` (the data folder does not exist) or `unreadable`. |
| `sessions` | int | Transcript files found (0 on a fresh machine). |
| `cli` | str | `ok`, `missing` (no CLI at `DESK_CLAUDE_BIN`, on `PATH` or at the default path) or `notExecutable`. A missing CLI turns page terminals and quick replies off but does not make `ok` false. |
| `stateDir` | str | `ok` or `readOnly` (the folder for the app's own files, or its run folder, cannot be written). |
| `hint` | str | One plain sentence saying the first thing to do; empty when all is fine. |
| `warming` | bool | True from the start until the server has built the session list once (it starts building at once; on a large data folder without a cache this takes seconds), then false for the rest of the run. |

### health.termhost

| Field | Type | Meaning |
|---|---|---|
| `mode` | str | `host` (terminals live in the terminal host) or `local`. |
| `running` | bool | The host answers (host mode) or always false (local mode). |
| `terms` | int, optional | Terminals the host or the server holds. |
| `error` | str or null, optional | Last host error (host mode). |
| `attached` | bool, optional | The server has the host's list (host mode). |
| `protocol` | int, optional | Host protocol version (host mode, when it answers). |
| `pid` | int, optional | Host process id (host mode, when it answers). |
| `uptime` | int, optional | Host seconds since start (host mode, when it answers). |
| `peerCheck` | bool, optional | The platform lets the host check a peer's user id (host mode); false means the private 0700 run folder is the only guard. |
| `codeVersion` | int or null, optional | Source time (ms) of the host's `termhost.py` when it started; null for a host from before this field (host mode, when it answers). |
| `older` | bool, optional | The host's code differs from this server's (host mode, when it answers). |
| `note` | str or null, optional | What to do about a host whose code differs, as `status` prints it (host mode, when it answers). |

### health.events

| Field | Type | Meaning |
|---|---|---|
| `clients` | int | Open `/api/events` listeners. |
| `max` | int | Listener cap. |
| `running` | bool | The shared feed thread runs. |
| `error` | str | Last feed error, empty when none. |

### health.workers.events

| Field | Type | Meaning |
|---|---|---|
| `running` | bool | The change-feed thread runs. |
| `errors` | int | Failed passes. |
| `lastError` | str or null | Type of the last failure. |
| `lastErrorAt` | int or null | Epoch ms of the last failure. |

### health.workers.stats

| Field | Type | Meaning |
|---|---|---|
| `running` | bool | A stats worker process runs. |
| `runs` | int | Finished recounts. |
| `errors` | int | Failed recounts. |
| `lastError` | str or null | Type of the last failure. |
| `lastErrorAt` | int or null | Epoch ms of the last failure. |

### health.fds

| Field | Type | Meaning |
|---|---|---|
| `open` | int | Descriptors the server holds now; -1 where the platform cannot list them. |
| `limit` | int | Soft descriptor limit (`RLIMIT_NOFILE`); -1 when unlimited or unknown. |
| `watches` | int | Descriptors held by kernel file watches; a low limit gets fewer (the timed scan covers the rest). |

### health.formatChecked

| Field | Type | Meaning |
|---|---|---|
| `transcriptFiles` | int | Transcripts read since the server started (0 right after a restart with a warm cache). |
| `filesKnown` | int | Transcripts the list knows: read this run or kept in the summary cache's list index from an earlier run (at least `transcriptFiles`). |
| `records` | int | Records parsed. |
| `filesWithoutMessages` | int | Non-empty transcripts without a user or assistant row. |
| `registryFiles` | int | Live-process registry files read. |
| `anomalies` | object | Count per tolerated anomaly (names in `docs/data-model.md`). |

## python3 server.py status --json

Not a route: one JSON line on stdout for scripts. Exit code 0 when the server answers, 1 when its process runs but does not answer, 3 when none runs. Reads only, like `status`.

### status.json

| Field | Type | Meaning |
|---|---|---|
| `v` | int | Shape of this answer (1). |
| `running` | bool | A server of this data folder is recorded and its process is alive. |
| `answering` | bool | That server answered its health check. |
| `pid` | int or null | Server process id. |
| `port` | int or null | Server port on 127.0.0.1. |
| `url` | string or null | `http://127.0.0.1:<port>`. |
| `uptime` | int or null | Seconds since the server started (null when it does not answer). |
| `codeVersion` | int or null | Newest source time of the loaded code, ms (health `codeVersion`). |
| `reloads` | int or null | Hot reloads since start. |
| `terms` | int or null | Page terminals the server knows. |
| `host` | object | Terminal host: `running` (bool), `pid`, `protocol`, `terms` (null when not running) and `note` (string when its code differs from the server's, else null). |
| `hint` | string or null | First thing to do from health `setup.hint` (the page's wording), or worked out locally when no server answers; null when all is fine. |
