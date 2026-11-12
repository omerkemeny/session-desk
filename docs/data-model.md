# Data model

What Session Desk reads from the CLI's data folder (`~/.claude`, or `DESK_CLAUDE_DIR`), and the rules that turn it into what the page shows.
The goal is that the sidebar transcript and the list show the same conversation `claude --resume <id>` shows.

Rules were taken from CLI 2.1.322 and checked three ways, marked on each rule. Since round 7, `python3 tools/screen_check.py` re-checks the whole case set on the real CLI in one command (below, "Screen check"):

- **seen**: a throwaway session written into a temporary `HOME` was opened with `claude --resume` in a pseudo-terminal (no login needed to view); the screen showed exactly this. Round 3 re-checked every rule below on CLI 2.1.322 this way.
- **code**: read from the CLI's own loading code (2.1.322), not shown on screen.
- **unverified**: inferred from record structure only.

The format is not a public contract. After a CLI update, run `python3 tools/parity.py`, check `formatWarnings` in `/api/health`, and re-check the rules marked *code*.

Only `desk/transcripts.py` knows these field names; `tools/parity.py` re-derives every rule on its own to check the server.

## Files

| Path | What it is |
|---|---|
| `projects/<encoded cwd>/<sessionId>.jsonl` | One session's transcript, one JSON object per line, appended as the session runs. `<encoded cwd>` is the working folder with every non-alphanumeric character replaced by `-`. |
| `projects/<encoded cwd>/<sessionId>/subagents/**/agent-*.jsonl` and `*.meta.json` | Subagent transcripts (`isSidechain: true` rows) and their description / `finished` flag. |
| `sessions/<pid>.json` | One file per running CLI or desktop process: which session it holds and its status. |

## Transcript lines

Every line has `type`. Lines with a `uuid` and `parentUuid` are **rows**; together they form a tree, not a list.

### Rows (`user`, `assistant`, `system`, `attachment`)

| Field | Type | Used for |
|---|---|---|
| `uuid` | str | Row id. A later line with the same uuid replaces the earlier one but keeps its place. |
| `parentUuid` | str or null | Tree edge. Null starts a tree: the first row, and every compaction boundary. |
| `logicalParentUuid` | str | Only on compaction boundaries: the row before the compaction. Not followed (the CLI does not either). |
| `isSidechain` | bool | Subagent work. Ignored for the conversation and for tokens. |
| `sessionId` | str | Session that wrote the row. A forked session starts with copies of its parent's rows that keep the parent's id. |
| `timestamp` | ISO str | Ordering ties, bridging a missing parent, `lastAt`. |
| `entrypoint` | str | Program that wrote the row: `cli`, `claude-desktop`, `sdk-cli`. Drives `lastBy` (the "behind" warning). |
| `cwd`, `gitBranch` | str | Project and branch shown in the list (last main row wins). |
| `isMeta` | bool | Text the CLI or a hook injected (skill bodies, caveats, hook context). Never shown, never a title. |
| `isCompactSummary` | bool | The summary written by a compaction. Not shown as a turn, never a title. |
| `origin.kind` | str | `human`, `task-notification`, `peer`. Not used for user rows (the CLI shows them by their text, see below). |
| `message.id` | str | Assistant message id. One message is split over several rows (thinking, text, each tool call); count its tokens once. |
| `message.content` | str or blocks | Blocks: `text`, `thinking`, `tool_use` (`id`, `name`, `input`), `tool_result` (`tool_use_id`, `content`, `is_error`), `image`. |
| `message.usage` | dict | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. |
| `message.model` | str | Model; `<synthetic>` marks a CLI-made row (API error text) and is ignored as a model name. |
| `message.stop_reason`, `isApiErrorMessage` | | A completed reply (used to tell whether a `continued-in` line was superseded). |
| `subtype` (system) | str | `compact_boundary` matters; `file_snapshot` rows never count as the newest row. Others (`turn_duration`, `stop_hook_summary`, `api_error`, ...) are not shown. |
| `compactMetadata.preservedMessages` | `{anchorUuid, uuids}` | Rows a compaction kept verbatim (also `preservedSegment` `{headUuid, tailUuid, anchorUuid}`). |
| `attachment.type` | str | `queued_command` matters (below). `fork_briefing` never counts as the newest row. All other attachments (hook output, reminders, file context) are not shown. |
| `attachment.prompt`, `.commandMode`, `.origin`, `.isMeta` | | A prompt typed while the session was working. |

### Other lines

| Type | Fields | Used for |
|---|---|---|
| `last-prompt` | `leafUuid` (str or null), `explicit`, `lastPrompt` | The CLI's checkpoint: which row the conversation ends at. Written after each turn by each program. `lastPrompt` (the latest prompt as typed, one line) names an untitled session in the resume picker. |
| `custom-title` | `customTitle` | Name the person gave the session. Last line wins; an empty string clears it. |
| `ai-title` | `aiTitle` | Automatic title. Last line wins. |
| `continued-in` | `continuedInSessionId` | The CLI moved this conversation to a new session id. |
| `progress` | `uuid`, `parentUuid` | Old format: rows whose parent is a progress line are re-attached to its parent. |
| `agent-name`, `mode`, `permission-mode`, `queue-operation`, `api-request*`, `file-history-*`, `cost-state`, `pr-link`, `bridge-session`, ... | | Not used. |

## The conversation `claude --resume` shows

Built by `transcripts.load()` + `transcripts.conversation()`; displayed via `transcripts.view()`.

1. **Read rows** in file order into a map by uuid. While reading, track (*code*):
   - *last row*: the last main row (not sidechain, not a `file_snapshot` system row, not a `fork_briefing` attachment);
   - *newest row*: the main row with the greatest timestamp;
   - *checkpoint*: `leafUuid` of the latest `last-prompt` line. A compaction boundary clears it. It is *explicit* when that line has `explicit: true` and no row was written after it. `leafUuid: null` with `explicit: true` means the conversation was rewound to empty.
2. **Compaction** (*seen*). If any boundary carries `compactMetadata` with preserved messages, every row written before the newest boundary is dropped, except the preserved ones, which are re-linked in order after `anchorUuid` (the summary row); rows that hung off the anchor move to the last preserved row. So the resumed conversation is: preserved tail, then everything after the compaction. The summary row is hidden; the CLI shows "Conversation compacted" in its place.
3. **Pick the end row** (*seen* for 1-3, *code* for the rest):
   1. Start from the checkpoint. If the checkpoint is not explicit and the last row descends from it, start from the last row instead (the same branch grew). **Two programs writing one session**: each writes its own branch and its own checkpoint; the newest checkpoint line in the file wins, even when the other program wrote rows after it (*seen* round 7, case 42: terminal checkpoint, desktop branch and checkpoint, then terminal rows without a checkpoint: resume shows the desktop branch).
   2. With no checkpoint at all, start from the last row (if the file has no `last-prompt` line with a `leafUuid` key, from the newest row that descends from it).
   3. Walk up from the start to the nearest `user` or `assistant` row: that is the end row.
   4. After a compaction (unless the checkpoint is explicit), the end row is chosen among the branch tips (user/assistant rows with no user/assistant row below them): the checkpoint if it is a tip, else the tip above the last row (even when another tip is newer); else the newest tip (*seen*, cases 19-20).
   5. An explicit checkpoint with nothing written after it ends the conversation there (a rewind); `leafUuid: null` with `explicit: true` shows an empty conversation (*seen*, cases 23-24).
4. **Walk up** from the end row along `parentUuid` to a null parent (the start, or the compaction boundary). A parent missing from the file is bridged to the newest earlier main row written at most 5 s before; sidechain rows are never a bridge (*seen*, cases 10, 21). A `progress` line between two rows is skipped over (*seen*, case 22).
5. **Parallel tool calls** (*seen*). One assistant message with several tool calls is written as several rows with the same `message.id`, each tool result hanging off its own piece, so the walk passes only one of them. For each message on the path, its other pieces and the tool results under them are put back, ordered by file position within that message's block; a checkpoint on one piece's result still shows every piece (case 26). A tool result that hangs off another row is matched to its call by `tool_use_id` and shown under it (*seen*, case 25; fixed in round 3).
6. **Queued prompts below the end** (*seen* round 7, case 43): non-message rows hanging below the end row (prompts queued after the last reply) are appended, oldest first.
7. **Other programs' branches**: user/assistant rows not shown, written by a different program (entrypoint) than the one that wrote the shown end, whose branch leaves the shown conversation at row R, are counted (prompts and replies) and sent as `["elsewhere", program, count]` right after R's events; the session's `consistency` is then `diverged`, else `ok`. Programs: `claude-desktop` is `desktop app`, `cli` and `sdk-cli` are `terminal`. The CLI shows nothing there; this is the app's own warning.

The newest row in the file is still what `lastAt` / `lastBy` report, so a page terminal is flagged "behind" when another program wrote a branch the resumed conversation will not show.

## What each row shows

| Row | Shown as | Check |
|---|---|---|
| assistant `text` block, not blank | a reply (`claude`), one per block | seen |
| assistant `tool_use` block | a tool call with its most telling argument, plus the CLI's own line as `display` (table below) | seen |
| assistant `thinking` block | nothing | seen |
| API error row (`<synthetic>` model) | a reply with the error text | seen |
| user `tool_result` block | the result under its tool call (paired by `tool_use_id`), as the default view prints it (table "Tool results" below) | seen (round 5) |
| user row with `isMeta` | nothing | seen |
| user row with `isCompactSummary` | nothing | seen |
| user text `<command-message>x</command-message><command-name>/x</command-name>…<command-args>a</command-args>` | prompt `/x a` | seen |
| user text `<command-name>` and `<command-args>` without `<command-message>` | prompt, raw tags (`❯ <command-name>/x</command-name><command-args></command-args>`) | seen round 7 (cases 18, 27, 28, 32, 33; fixed in the parser; 0 real files have such a row) |
| user text `<bash-input>c</bash-input>` | prompt `! c` | seen |
| user text `<bash-stdout>`, `<bash-stderr>`, `<local-command-stdout>`, `<local-command-stderr>` | output under the command (`⎿  ` then the lines): `["out", stdout + stderr, 1 when stderr is not empty]`, never a prompt; empty output is not sent. The newest `!` output and every local-command output are shown whole; an older `!` output longer than 4 lines shows 3 lines and `… +N lines (ctrl+o to expand)` (the server sends `… +N lines`). The CLI prints stdout and stderr as two `⎿` blocks | seen (case 27; round 4: an older 6-line local output with a newer one below was shown whole; round 7: two 6-line local outputs in a row, both whole, case 43) |
| user text `<task-notification>` | nothing | seen |
| user text `[Request interrupted by user…]` | the interrupt marker (`["interrupt"]`), never a prompt; the CLI prints `⎿  Interrupted · What should Claude do instead?` under the previous line | seen |
| any other user text, including other `<tags>` (`<system-reminder>`, `<pasted_content>`, `<!-- -->`) | prompt, raw, one per text block | seen |
| user row with only images | prompt `[Image]` (the CLI prints `[Image #1]` on its own line, without `❯`) | seen |
| image blocks beside a typed prompt | one `["image"]` per image, after the prompt (the CLI prints `⎿  [Image #1]` under the prompt, once per image) | seen |
| compaction boundary on the shown path | `["compact", summary]` where the CLI prints `✻ Conversation compacted (ctrl+o for the summary)`, followed by `⏺ Compact summary (ctrl+o to expand)` only when the summary row has no `isVisibleInTranscriptOnly` (`summary` 1; cases 19-20) and nothing more when it has (`summary` 0; case 3; all 48 compacted real files) | seen round 7 |
| `! c` and local slash commands | prompt `! c` (printed with `!` instead of `❯`), `/cost` (without arguments too) | seen |
| attachment `queued_command` with `commandMode` `prompt`, origin human or none, not meta | prompt | seen |
| any other attachment or system row | nothing | seen for hook output and compaction notes |

## Session summary (list and garden)

| Field | Rule |
|---|---|
| title | No wrapper tag ever (the app's own step, see "Titles as the resume picker shows them"). As the resume picker names the session (below): last `custom-title` (an empty one clears it), else last `ai-title`, else the registry `name` when its `nameSource` is absent, `user` or `peer` (the app's own step), else the prompt words. A title of `side chat`, `untitled` or ending in `-` plus two hex digits is a placeholder: the prompt words are shown instead. Own titles are cut to 80 characters, prompt words to 60 at a word boundary with `…`, on one line. |
| prompt words | The picker's prompt: the last `lastPrompt` value within the file's last 64 KB when not empty, else the first prompt; then cleaned like the picker (pasted blocks unwrapped, `<tag>…</tag>` elements removed) and, the app's one step beyond the picker, pasted wrappers the picker leaves raw are dropped when other words remain. |
| first prompt | First user row in file order (any branch, before any compaction) that is not meta, not a compaction summary and holds no tool result; per text block: pasted blocks unwrapped, lines joined; a slash command counts only with arguments (`/x a`), `! c` counts, text starting with a `<tag` or an interrupt marker is skipped; cut to 200 characters plus `…`. When no row qualifies, the first slash command without arguments. |
| topic | The last prompt of the conversation. |
| last, ask | The last reply of the conversation. |
| tokens | Per distinct `message.id` of this session's own main assistant rows (not sidechain, not copied from a parent session), the last row's `input + output + cache_creation` tokens; summed over all branches, before and after compactions (tokens spent). |
| model, cwd, branch | Last main user/assistant row in file order. |
| lastAt, lastBy | Timestamp and entrypoint of the last main user/assistant row in file order, any branch. |
| kind | `headless` when the file has rows with entrypoint `sdk-cli` and none with `cli` or the desktop app's entrypoint (only the headless CLI, `-p`, ever wrote it), else `interactive`. |
| automated | `true` when `kind` is `headless`, or when every main prompt row (user, not meta, not a compaction summary, no tool result) carries `turnOrigin: "sdk"`. A person's prompt carries `turnOrigin: "human"` (older files: no `turnOrigin`, so they are never automated by this rule). Seen in a temporary `HOME`: `claude -p` wrote `turnOrigin: "sdk"`, a prompt typed into `claude` wrote `"human"`. On the real data (473 sessions, 2026-11-11): 43 headless, 256 more automated though written with the desktop entrypoint (hook runs: one slash command), 174 interactive; of the 78 listed, 32 headless and 25 automated-interactive. The page should fold `automated`. |
| consistency | `diverged` when an `elsewhere` event is sent (step 7), else `ok`. Real data: 4 of 473 diverged. |
| lastTool | Name of the newest tool call in the shown conversation, `""` when none. |
| lastError | `true` when the newest tool result in the shown conversation has `is_error`, else `false`. |
| tokensToday, prsToday | Of the shown conversation: tokens of this session's own assistant messages (each message once, its last row, the `tokens` sum) and pull requests opened (the `prOpened` rule, each link once, at its earliest call), whose row time falls on today in `Asia/Jerusalem` (the Stats zone). Kept per day in the summary (the newest `DAYS_KEPT` = 7 days with activity), so they roll over at midnight without a file change. Edges (`tests/test_today.py`, clock injected): a turn that starts before midnight counts on the day of its reply row; daylight-saving days have 23 or 25 hours and count by the zone's calendar; after the clock jumps back, rows from "tomorrow" count only once that day comes; rows without a usable timestamp count in `tokens` but never today; the first request after midnight answers 0 with nothing changed on disk. All passed without a code change in round 6. |
| prOpened | Pull requests opened, by the Stats rule (`desk/stats.py`): a `gh pr create` shell command whose non-error result holds a pull-request link (once per link), or a connector tool named `*pull_request_create*`/`*create_pull_request*` with a non-error result; a result containing `already exists` does not count. Over every user/assistant record of the main file that has a timestamp (sidechain rows included, subagent files not), each tool id once. |
| waitingSince | Epoch ms of the newest assistant row of the shown conversation; when a live holder is `idle`/`waiting` and its `statusUpdatedAt` is newer, that time. 0 when neither is known. |
| hidden | A session whose last `continued-in` line is not followed by a completed reply or a typed prompt, and whose new session file exists, is left out of the list unless it is live (the CLI's `/resume` list hides it too, *code*). |

## Titles as the resume picker shows them

Seen on CLI 2.1.322 (`claude --resume` picker in a temporary `HOME`, invented sessions; fixture cases 29-41 were copied there too and showed the same) and read from its picker code. The picker reads only the first and last 64 KB of each file.

| Session | Picker shows | App title | Check |
|---|---|---|---|
| own title and automatic title | the own title | same | seen |
| only an automatic title | the automatic title | same | seen |
| an empty own title after one | the automatic title, else the prompt | same | seen |
| `agent-name` record only | ignored: the prompt | same | seen |
| no title, `last-prompt` lines | the last `lastPrompt` (case 29), even from a line before a newer one without the key | same | seen |
| no title, last `lastPrompt` empty | the first prompt, not an older `lastPrompt` (case 30) | same | seen |
| no title, no `last-prompt` line | the first prompt | same | seen |
| `lastPrompt` beyond the last 64 KB | the first prompt (case 41) | same | seen |
| first prompt a slash command with arguments | `/review pr twelve` (case 32) | same | seen |
| slash command without arguments first | passed over; when nothing else qualifies, the first one (`/status`, case 33) | same | seen |
| built-in slash command with arguments (`/model x`) | passed over like one without arguments (`/model`) | `/model x`: the app has no list of built-ins | seen |
| first prompt a pasted block alone (`<pasted_content id="4 hex">` on its own lines) | the pasted text on one line (case 34) | same | seen |
| pasted wrapper in another form (other id, no line break) at the start | passed over like any `<tag` | same | seen |
| typed words plus a pasted wrapper the picker leaves raw | the raw tags and text | the typed words only (case 35); the pasted text when nothing was typed | seen (app differs on purpose) |
| `<system-reminder>` block before the text, separate block | the text block (case 36) | same | seen |
| `<system-reminder>` and text in one block | the block is passed over (it starts with a tag) | same | seen |
| `<system-reminder>` or command tags inside `lastPrompt` | removed (case 31) | same | seen |
| prompt that is only tags | the session id's first 8 characters (case 39) | same | seen |
| no prompt at all | `(session)` (case 40) | same | seen |
| long prompt | cut to the terminal width with `…` | cut to 60 characters at a word with `…` (case 37) | seen |
| prompt over several lines, extra spaces | one line, single spaces (case 38) | same | seen |
| placeholder own title (`side chat`) | the placeholder | the prompt words | seen (app differs on purpose) |
| a `<tick>` prompt | `Proactive session` / `Autonomous session` | same | code |
| `summary` record (old format) | its summary | not used (no real file has one) | code |

Shared titles: when two active sessions share a title, the latest request (tags removed) is appended (`title · request`) unless the title already holds it; still equal ones are numbered `#2`, `#3`.

**No tags in titles (intended difference, round 5).** The owner wants titles that say what a session is for, so after the picker's rules the app removes every remaining wrapper element, meaning a `<tag …>` whose name holds a hyphen or underscore (`pasted_content`, `system-reminder`, `command-name`); text a person types such as `<b>` or `Vec<T>` is kept: the typed words outside elements are kept; when none remain, the text inside the elements (the first words of the pasted text); when that is empty too, the picker's fallback (the id's first 8 characters). Lone opening or closing tags and a tag cut off at the end are dropped too; `a < b` is not a tag. Applies to own titles, automatic titles, registry names, prompt words and the shared-title suffix (`transcripts.no_tags`, `tests/test_title_tags.py`; `tools/parity.py` applies the same rule as `without_tags`). Real data (2026-11-11): 2 listed waiting sessions had a pasted wrapper in their title, both from the shared-title suffix; 0 after.

## Which sessions are listed

Only transcripts whose file name is a session id (`transcripts.SID`, the ids the session routes accept) are listed; a file with any other name would list a row that cannot be opened (QA round 4, item 10). Every live session (registry holder, page terminal or quick reply), then the newest finished ones by file time: up to `RECENT` (60) a person typed into and, counted apart, up to `RECENT_AUTO` (60) `automated` ones. Sessions with nothing to show and continued ones (`hidden`) do not use a place. The class comes from the list index (below), so a full view is read only for rows that are listed; a file without a current index entry is read only when the list reaches it (files newer than the 60th of each class, or every file once while a class is not full). Files of equal time are ordered by path (before round 8: by folder listing order).

**List index (round 8).** For every transcript the list has decided on, `summaries` keeps `(key, automated, shown, continuedIn)` with no count bound, in memory and in the summary cache file (`index`, relative paths `<dir>/<file>.jsonl`, validated like the views). `sessions._order` keeps every listable file in one sorted list per class (shown files with a current entry, newest first), plus `unknown` for files whose entry is missing or stale; the list loop walks the two class lists and resolves an unknown file only when it is newer than both heads, so a class that never fills costs nothing once indexed. A full list stats every file (or takes `keys`, the change feed's `{path: (mtime_ns, size, inode, ctime_ns)}` for every transcript, used as the files' state with no stat; other file names are filtered out; 20,000 entries cost about 2.5 ms) and re-places only files whose key moved. `hold` (equal to `holders()`) skips the registry pass. `sessions_for(ids, settled=True)` re-stats only the named sessions (found again by id) and the active ones' known files and builds only their rows; every other place in the order comes from `_order`. Synthetic 20,000 sessions, none automated: index on disk 129 bytes a file (2.5 MB), `tools/scale.py --sessions 20000 --auto 0 --quick`: warm list 78 ms (was 10.7 s), 1 append a second 12 % CPU (was 85 %); a restart on the same state folder answers the first list 340 ms after start (was 15 s) at 148 MB RSS; `sessions_for(ids, settled=True)` 1.4 to 2.2 ms in-process (0.1 ms when the caller passes `hold`). The first start with no summary file still reads every file once (10.9 s, RSS 319 MB after the routes). Real data (2026-11-11): 473 files; the list holds 138 (18 live, 60 typed, 60 automated; before: 78 with 3 typed); 188 files read on a cold start.

## Live status (`sessions/<pid>.json`)

Fields used: `pid`, `sessionId`, `status` (`busy`, `idle`, `waiting`), `statusUpdatedAt`, `name`, `nameSource`, `entrypoint`, `procStart`, `parkedJobId`.

A file counts as a live holder of its session when (*code*, the CLI applies the same tests to find other holders):

- `parkedJobId` is absent;
- the pid runs (`kill(pid, 0)`);
- its `procStart` equals the running process's start time (`ps -o lstart=` in UTC). A different start time means the process ended and the pid was reused: the file is stale. Without `procStart`, or when `ps` gives no answer, the file is trusted.

Session status: `running` when any holder is `busy`; else `waiting` when any holder is live (`idle` or `waiting`); else `done`. Two holders of one session (desktop app plus a terminal): busy wins, otherwise the most recently updated one names the status. A page terminal that only sits at its first prompt does not count (the app's own rule). A quick reply in progress shows as `running`, a finished one as `waiting`.

## Tool calls as the CLI prints them

CLI 2.1.322, seen in a temporary `HOME`. The default view groups consecutive reads and searches into one line (`Read 2 files, listed 1 directory`, `Searched for 2 patterns`, `Called srv 2 times`, each with `(ctrl+o to expand)`) and prints other calls one per line; ctrl+o (detailed view) prints every call. `display` in `tool` events is the detailed-view line (`transcripts.tool_display()`), except `Fetch` which uses the default-view form.

| Tool (`name`) | Detailed view | Default view |
|---|---|---|
| `Read` | `Read(<file_path>)` | grouped: `Read N file(s)` |
| `Edit`, `MultiEdit` | `Update(<file_path>)` | same |
| `Write` | `Write(<file_path>)` | same |
| `Bash` | `Bash(<command>)` | grouped: `Ran N shell commands` (with reads and searches next to it: `Searched for 2 patterns, ran 1 shell command`); every call, with or without output, errors and background calls included (seen round 7, cases 4, 16, 25-27, 46) |
| `Grep` | `Search(pattern: "<pattern>", path: "<path>")` | grouped: `Searched for N pattern(s)` |
| `Glob` | `Search(pattern: "<pattern>")` | grouped with Grep |
| `Task`, `Agent` | `<subagent_type>(<description>)`, `Agent(<description>)` for `general-purpose` or none (`Explore(Look around)`) | same |
| `WebFetch` | `Fetch(url: "<url>", prompt: "<prompt>")` | `Fetch(<url>)` (the app sends this one) |
| `WebSearch` | `Web Search("<query>")` | same |
| `Skill` | `Skill(<skill>)` | same |
| MCP `mcp__<server>__<tool>` | `<server> - <tool> (MCP)(<key>: <JSON value>, ...)` | grouped: `Called <server> N times` |
| `TodoWrite`, `TaskCreate`, `NotebookEdit` | nothing (`display` is `""`) | nothing |

A call to a tool the resumed CLI does not have (an MCP server not configured) prints nothing; the app still sends it.

A call left without a result at the end of the conversation: the CLI prints `⎿  Interrupted · What should Claude do instead?` under it on resume (seen round 10, case 55). The server sends the `interrupt` event after it when no live program holds the session (a registry holder, a page terminal or a running quick reply); while one does, the call is still running and nothing is added.

## Tool results

Seen on CLI 2.1.322, round 5: two invented sessions with one call per tool, each result row carrying a `toolUseResult` shaped like the CLI's own (field names taken from the real data, values invented), resumed in a scratch `HOME`, default view. `screen_result()` in `desk/transcripts.py` builds the `tool` event's result text and `quiet` item from the tool's name, the result block and the row's `toolUseResult` (only when the row holds one result block).

| Tool | Screen on success | Sent as result | quiet |
|---|---|---|---|
| `Read`, `Grep`, `Glob` | no result line (grouped `Read N files`, `Searched for N patterns`) | raw text, cut to 4 lines | 1 |
| `Task`, `Agent` (completed) | no result line | raw text | 1 |
| MCP `mcp__*` | no result line (grouped `Called srv N times`; nothing at all when the server is not configured) | raw text | 1 |
| `TodoWrite` and the other `UNSHOWN_TOOLS` | nothing | raw text | 1 |
| any tool whose row has no structured `toolUseResult` (dict) | no result line | raw text | 1 |
| `Edit`, `MultiEdit` (and `Write` of type `update`) | `Added N lines, removed M lines` (`Removed N lines` or `Added N lines` alone when one side is empty, case 45), then the diff lines `<n> -old`, `<n> +new`, `<n>  context`, numbers right-aligned to the widest (` 98`, `100`, case 45) | the same lines | 0 |
| `Write` (new file) | `Wrote N lines to <path relative to the session folder>`, the first 10 lines numbered (width of the shown numbers, 2 for a 120-line file, case 45), `… +K lines` | the same lines | 0 |
| `Bash` | no result line (grouped `Ran N shell commands`), errors included; round 5's result lines were not seen again in round 7 on the same version (scratch HOME, full-screen view) | stdout then stderr, up to 4 lines whole, longer: 3 lines and `… +N lines`; empty: `(No output)`, or `Done` when `noOutputExpected` (the expanded form) | 1 |
| `WebFetch` | `Received 2KB (200 OK)`, `Received 512 bytes (404 Not Found)`, `Received 1.5MB (200 OK)` (case 46) | the same | 0 |
| `WebSearch` | `Did 1 search in 2s`, `Did 2 searches in 400ms` | the same | 0 |

The CLI draws a result line only when the row's `toolUseResult` has the tool's whole shape (an `Edit` result without `oldString`, `originalFile`, ... or a `WebFetch` one without `result`, `durationMs` drew no line, round 7); real rows always have it, so the app keeps testing for a dict.

Errors (`is_error`): the CLI prints the result block's text (not `toolUseResult`) as `Error: <text>`; text that already starts with `Error` is printed once (no second prefix); a `<tool_use_error>…</tool_use_error>` wrapper is stripped; an `Edit` error saying the file has not been read yet prints `File must be read first`. The server sends exactly that, `quiet` 0: up to 10 lines whole, longer errors the first 10 lines then `… +1 line` or `… +N lines` (`sessions.cut_error`; seen round 10, cases 59-61: 8 and 10 lines whole, 11 gives `… +1 line`, 12 `… +2 lines`, 20 `… +10 lines`, 40 `… +30 lines`). A `Read` error inside a grouped `Read N files` line showed no error line in the default view; the app still sends it.

## Known differences from the CLI

- **Titles**: placeholder titles (`side chat`, ...) are replaced by the prompt words; pasted wrappers the picker leaves raw are dropped; prompt titles are cut to 60 characters, not the terminal width (table above).
- **Built-in slash commands**: the CLI skips built-in commands (`/model x`) when it picks the first prompt. The app has no list of built-ins, so a built-in command with arguments can become the fallback title (only when no `lastPrompt` exists: 3 of 473 real files).
- **Grouped calls and results**: the page shows each call; the CLI's default view groups reads, searches and MCP calls (table above). `quiet` marks the calls whose success result the CLI does not print, so the page can hide it.
- **Titles**: never hold a wrapper tag, where the picker leaves some wrapper forms raw (above).
- **Other programs' branches**: the CLI shows nothing where another program's branch leaves the conversation; the app sends `elsewhere`.

## Not verified

Round 7 settled the rest on the screen (CLI 2.1.322, `tools/screen_check.py`, cases 42-46). Still open:

- A configured MCP server's result line: needs a running server, which an invented case cannot provide.
- The detailed-view (ctrl+o) lines: the screen check reads the default view only.

Seen in round 7 and not modelled (`screen_check.KNOWN`): the resume picker does not list a file whose name is not a session id (case 43 copied as `notes-43.jsonl`: one entry; the app hides such files too), leaves out files with sidechain rows (cases 8, 21; 0 real files) and headless sessions (case 13; the app lists them as automated on purpose), and lists a session rewound to empty (case 23; 0 real files). `continued-in` hiding is seen: case 11 is hidden while case 12 exists; case 44 (a typed prompt after the move) stays listed by both.

## Screen check

`python3 tools/screen_check.py [--case N] [--keep] [--save] [--jobs N]` copies each case of `tests/fixtures/cases` (and the sessions it continued in) into a new temporary `HOME` (rows' `cwd` set to its work folder, folder trust and onboarding pre-set in that HOME only), runs the CLI there in a pseudo-terminal of 200 x 160 cells twice (`--resume <id>`, then the bare picker), renders the output with a small terminal emulator, quits with Esc and Ctrl-C twice, and compares the conversation blocks (prompts, replies, tool lines, result lines, groups, markers) with `sessions.transcript()` and the picker's titles with the app's list. It prints the CLI version, then per case `PASS`, `FAIL` with a diff of both sides, or `KNOWN` (documented difference); exit 1 on a FAIL, 2 when the CLI cannot start. `--save` stores each conversation region and picker title list in `tests/fixtures/screens/`; `tests/test_screen_check.py` replays them against the app without the CLI. Whitespace is collapsed before comparing (diff-number widths were checked by eye, case 45). Round 7: 46 cases, conversation 46 PASS, title 42 PASS and 4 KNOWN.

## Reading and caching

- A transcript is read as bytes, line by line; a line counts once it ends with a newline. An unfinished last line is applied to a copy of the state only.
- The parse state after the last complete line (rows, parents, checkpoint, titles, pull-request bookkeeping, check counters) is kept for files written in the last `STATE_ACTIVE` seconds, at most `STATE_MAX` files and `STATE_BYTES` source bytes, least recently used dropped first. When such a file grew, only the new bytes are read; the result is identical to a full read (`tests/test_incremental.py` cuts every fixture at random places and compares).
- A read with no unfinished last line shares the kept state's rows instead of copying them (round 8); the one rule that changes rows (compaction relinking) works on its own copy, and while a reader still holds a shared result the next append grows a copy of the state (`tests/test_incremental.py` `SharedStateTest`). At 250 MB (`tools/scale.py --big 250 --quick`): open after an append 335 to 269 ms, CPU at one append a second 14.8 to 7.5 %; the list after an append stays 835 ms and RSS after the routes 505 MB, since the whole-file rules (conversation walk, per-day figures, anomaly counts) still run over every row: the index-and-tail design below is still the next step.
- A full read happens instead when the file shrank, its inode changed (replaced by rename) or its first `HEAD` bytes differ. Records that touch earlier rows (a repeated uuid, compaction, checkpoints) need no special case: every whole-file rule runs on a copy after reading.
- Summaries keep at most 2000 characters of the first request, latest request and latest reply, for at most `SUMMARY_MAX` sessions, least recently used dropped first; list views for at most `CACHE_MAX`.
- The conversation's end row with no checkpoint ever written (step 3.2) uses one pass over the parent links (`_below`) instead of an ancestor walk per row; on a 30 MB file whose rows' times run ahead of the newest appended row this was 1 s per read (QA round 4, item 5). `find()` remembers each id's path and re-checks it exists instead of a folder glob per call.
- **Summary cache file** (`desk/summaries.py`): the list view of each transcript (counts, flags, per-day numbers and the short capped texts the list sends: title 80, prompt title 61, topic 71, ask 400, last 160, project, branch, model) is kept in `<stats cache>-summaries.json` beside the stats cache (`.stats-cache*`, never packaged), keyed by the transcript's real path and its mtime (ns), size, inode and ctime (ns; an in-place rewrite that restores mtime still moves it). The file is read only when it is a regular file (never through a link, `O_NOFOLLOW`) owned by this user and not writable by group or others; any load failure (bad JSON, nesting too deep, memory) rejects it. Version `v` (2), the code mark taken when the file was attached (after a hot reload of the view code, the old views are dropped from memory and never written under the new mark), and the data folder must match, and every entry must have exactly the expected fields, types and lengths, numbers below 2^53 and times at most a day ahead, and a normalised path of the exact form `projects/<dir>/<file>.jsonl`; otherwise the file or the entry is ignored and rebuilt. A changed transcript is read again; a deleted one leaves the file at the next write. Writes go through `desk/durable.py` (one writer, synced temp file and rename, 0600), at most once per `SAVE_DELAY` (5 s) after a change, never on a request without a change. A warm start answers exactly what a cold one does (`tests/test_summaries.py`). Real data: 473 files, 234 KB file, written in 2 ms; first `/api/sessions` after a start 1.07 s cold, 0.04 s warm (server runs, 2026-11-11).

## Memory bounds

Every cache of the data side, with its bound (`tests/test_memory_bounds.py` pushes each one past it). Entries of a transcript that was deleted leave `_cache`, `_views`, `_full`, `_states` and `_found` at the next list request, and the summary cache at its next write.

| Cache | Holds | Bound in entries | Bound in bytes (est.) |
|---|---|---|---|
| `transcripts._states` | parse state of recently written transcripts (slim rows, round 9: no bodies, at most `ROW_BYTES` 1,500 bytes a row) | `STATE_MAX` 16 | `STATE_BYTES` 256 MB of source for every state but the newest file's, which is kept whatever its size (round 7); about 0.27 bytes of memory per source byte, so about 70 MB plus 0.27 times that file |
| `transcripts._checks` | format-check counters per transcript read | one per transcript on disk (deleted ones dropped by `format_report`) | about 2 KB each; unknown type names capped at `UNKNOWN_NAMES` 32 per file |
| `transcripts._found` | session id to path | `FOUND_MAX` 4096 | under 1 MB |
| `sessions._views` | list views (short capped texts and counts) | `CACHE_MAX` 10000 | about 1.5 KB each, 15 MB |
| `sessions._cache` | whole summaries | `SUMMARY_MAX` 512 | at most about 30 KB each (texts 2000 characters, 80 timeline entries of `TL_TEXT` 200), 15 MB |
| `sessions._full` | sidebar transcripts | `FULL_MAX` 4 | `FULL_CHARS` 16 M characters together; the newest is always kept |
| `sessions._folds` | list and sidebar folds of the last read (row list, events, per-day facts) | `FOLD_MAX` 8 | est. 10 bytes a shown row plus the sidebar's events (shared with `_full`) |
| per-day figures in a view | tokens and PRs per day | `DAYS_KEPT` 7 days | under 1 KB |
| `summaries._state["entries"]` | summary cache file in memory | `MAX_ENTRIES` 10000 | about 1.5 KB each, 15 MB |
| `summaries._state["index"]` | list index: key, class, shown, continuedIn per transcript | one per transcript on disk (gone ones dropped at the next full list) | 435 bytes each in memory, 129 bytes each on disk (20,000 files: 8.7 MB, 2.5 MB) |
| `sessions._order` | every listable transcript's key and its place in the class lists | one per transcript on disk | about 190 bytes each, plus the path text when it is not shared with the index (est. 150) |
| `sessions._starts` | one `ps` answer | 1 | small |

Total steady bound: about 130 MB above the server's base (about 25 MB), est. Beyond that, a full read of a transcript (a new file, or one whose state was dropped) briefly needs about 2.5 times its size; the process keeps that peak resident afterwards.

Measured (round 6, in-process replay of the server's data calls on `tools/bench_home.py` data: 300 sessions, 3 appends per step, a session appearing every 10 steps and one removed every 10, the big file appended each step, list each step, sidebar every 3 steps, health every 10):

| Step | Changes | Big file MB | RSS MB before | RSS MB after |
|---|---|---|---|---|
| 0 | 0 | 30.8 | 76.6 | 76.3 |
| 200 | 835 | 38.7 | 101.8 | 101.2 |
| 400 | 1,675 | 46.5 | 114.8 | 114.1 |
| 600 | 2,515 | 54.3 | 128.8 | 127.5 |
| 800 | 3,300 | 60.0 | 138.2 | 130.3 |

Before the fix the entry counts grew by one per session ever seen (`_cache`, `_views` 300 to 380, `_found` 83, summary entries 380); after it they stay at the number of files on disk (305, 16). RSS still follows the size of the growing big file: `tracemalloc` puts the growth in the parsed rows of its kept state (50 MB of 54 MB traced at step 200), which is the `_states` bound filling, not a leak. Before round 7, past 64 MB the state was dropped and every change read the whole file again. Since round 7 the newest file's state is kept whatever its size (`_keep`; `tests/test_incremental.py` checks a file past the bound stays incremental and equal to a full read while other files are read between appends). Synthetic 100 MB file, one append then a list, median of 10: 982 ms before, 413 ms after; peak RSS about 390 MB either way (the first full read). The rest of the 413 ms is the per-read copy of the kept state and the whole-file rules run on it.

**Slim rows (round 9).** A kept row holds no body: only the fields the rules read (type, uuid, parent, sidechain, session, cwd, branch, entrypoint, timestamp, meta and compaction flags, subtype, turn origin, origin kind, attachment type, preserved-message ids; message id, model, stop reason, usage as four numbers, content block types with tool-call ids), its list facts worked out once when the line is read (each shown item cut to `BRIEF_TEXT` 200 characters, tool hint 120, edited file; its pull-request part) and its offset and length in the file. Repeated texts (type, session, cwd, branch, entrypoint, model, message id, parent uuid) are one shared copy. The list uses only these facts (`brief_view`) and reads again the two rows of the newest prompt and reply; the sidebar reads every shown row again through one handle, in order, folding each into events (`iter_view`). A re-read checks the inode, the first `HEAD` bytes, a whole line ending in a newline and the same uuid and type; anything else raises `Stale`, the kept state is dropped and the file is read whole once (`tests/test_slim.py`: truncated, rewritten in place, replaced by rename, a line still being written, an index entry one byte short, four threads on one file). Memory: `ROW_BYTES` 1,500 bytes a row at most, 0.27 times the file's text (synthetic 6 MB file, 1,291 bytes a row on Python 3.12, `tracemalloc`). Oracle: `transcripts.SLIM = False` keeps whole rows and runs the old list path; `tests/test_slim.py` compares both for every fixture, every fixture appended in random chunks, and 3,000 random trees (branches, compactions with kept lists and segments, checkpoints, rewinds, replaced uuids, sidechains, progress lines, queued prompts, pull-request calls, long texts), 1 in 10 also appended in two parts. 250 MB (`tools/scale.py --big 250 --quick`): RSS after the routes 507 to 142 MB, list after an append 788 to 238 ms; open after an append 269 to 776 ms and cold open 802 to 1,332 ms (the sidebar now reads every shown row again).

**Folds (round 10).** The list summary and the sidebar keep what they folded over the last read (`sessions._folds`, `FOLD_MAX` 8 entries: the conversation's row list, the timeline, edited files, newest prompt and reply, last tool, per-day tokens and pull requests, file-order message facts; for the sidebar its events, call places and other programs' marks). When the new conversation starts with exactly the same row objects (an append that only added rows at the end) only the added rows are folded; anything else rebuilds whole: a checkpoint that moves the end to another branch, a compaction line or compact summary, a row replacing an earlier uuid, a re-read file, another program's branch that marks an earlier row, a newer `!` output (it changes how the older one is cut). A `continued-in` line or an orphan root folds. `tests/test_slim.py` checks each case against `SLIM = False` and folds 1,250 of 5,000 random trees appended in two parts. 250 MB (`tools/scale.py --big 250 --quick`): open after an append 566 to 115 ms; list after an append 171 to 158 ms (the conversation walk and `elsewhere` still run over every row: not yet incremental).

Next step (design, not built): incremental conversation, per-day figures and counters, so an append costs time in proportion to the append; keep for a big file only the tail state (checkpoint, titles, last rows, counters) and a uuid -> (offset, parent) index instead of parsed rows; the conversation walk follows the index and re-reads only the rows on the shown path (seek + one line each), and summaries take their counts from the counters. Invariants a test must hold: (1) every answer equals a full read after any cut of the file (the existing random-cut test, run with the index on); (2) a repeated uuid, a compaction or a checkpoint touching earlier rows gives the same result as a full read; (3) memory stays below a fixed bytes-per-row bound (index only), measured on a 250 MB file; (4) a rewrite, shrink or inode change still falls back to a full read.

## Anomalies

Counted per file by the format check and summed in `/api/health` under `formatChecked.anomalies` (counts only): `bad JSON line` (also the `unparseable lines` warning), `unknown record type` (also a note per type name), `missing parent`, `duplicate uuid`, `timestamp going backwards` (a main row older than the one before it), `two programs` (files whose rows carry more than one entrypoint). Except bad lines, they are notes: the rules above repair them.

## Checking

```bash
python3 tools/parity.py            # every session under ~/.claude, counts only
python3 tools/parity.py --id 1a2b  # one session
python3 tools/parity.py --home tests/fixtures/cases
python3 tools/parity.py --report   # data-quality counts: classes, programs, CLI versions, record types, anomalies, display rules, hidden rows
```

`--report` is the page to read after a CLI update: a new CLI version, record type or hidden-row reason shows up there first. Real data (2026-11-12, counts): 473 sessions (156 typed, 299 automated, 18 live); 415 sessions with the desktop app's entrypoint, 44 headless, 28 terminal, 2 none; newest CLI version per session 2.1.229 to 2.1.322 (171 on 2.1.309, 32 on 2.1.322); anomalies 4,018 duplicate uuid, 3,561 timestamp going backwards, 45 missing parent, 16 two programs, 0 bad lines, 0 unknown types; display rules: 344 sessions with slash commands, 76 queued prompts, 51 images, 48 compaction, 29 `!` commands, 15 branching; hidden rows: 30,631 dropped by compaction, 19,143 attachments, 6,141 thinking only, 2,798 other branch, 2,574 system notes, 566 meta, 143 task notifications, 47 compaction summaries.

It prints sessions checked, matching, mismatches per field, and per mismatch the session id prefix, field and two counts or lengths, never text. Unit tests: `tests/test_parity.py` (one synthetic session per rule in `tests/fixtures/cases`).
