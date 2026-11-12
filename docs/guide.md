# Session Desk user guide

This guide walks through everything the page shows, in the same order as the Legend page.
To install, run, stop or fix the app, see the [README](../README.md): [Run](../README.md#run), [Settings](../README.md#settings), [Safety and privacy](../README.md#safety-and-privacy) and [Troubleshooting](../README.md#troubleshooting).

## The Legend page

The Legend page shows every picture the garden can draw, next to what it means and its exact rule.
Open the Stats panel and click "Legend" at its foot; it opens in a new tab.
You can also go straight to `/legend.html` on the server's address, for example http://127.0.0.1:8765/legend.html.
It is drawn by the app's own code, so it is always current.
Where this guide says "see the Legend", the exact number or time is there.

![The garden at night with "10 need you": eight waiting characters with name tags, two of them grey under blankets and one with a red "!" bubble, two anglers at the pond (one with a red "!"), a camp fire burning with nobody beside it, three miners and two small subagents by the lit mine, the moon, a shooting star and lit windows in town.](img/garden-night.png)

## Characters

A character in the meadow is a session that waits for your answer.

- **A character.** Hover or focus it for the title, your latest request, its last reply and how long it has waited. Click it to open the session. The garden holds a limited number (see the Legend); the rest count on the sign.
- **"?" bubble.** It has a question or finished its turn. The bubble shrinks a little once the character sits down, and becomes small and dim under a blanket, so the newest waits stand out.
- **Yellow "?" and a ring.** It just started waiting. The bubble stays yellow for the first few minutes, and a session that starts waiting while you watch gets one soft ring at its feet.
- **Red "!" bubble.** Its last step failed. It is the only red signal in the garden, and it stays bright even on an old wait.
- **Hats and colours.** Each session keeps its own hat and body colour, also in the lists and the sidebar, so you can tell sessions apart. No two active sessions wear the same look. Looks are kept in your browser only.
- **Pennant.** It opened a pull request. A small still pennant in the session's own colour.
- **Sitting on a stump.** It has waited a while.
- **Napping.** It has waited a long time; its eyes are shut.
- **Under a blanket.** It has waited a day or more. It naps under a grey-blue blanket and recedes: its body colour fades toward slate but keeps its hue, so you can still tell who it is. The hat keeps its colour, it stops bobbing, and its bubble and tag dim.
- **Umbrella.** It is raining or snowing in the city. Waiting characters hold one in their own colour.
- **Fishing.** The session is about Airflow (DAGs, backfills, the scheduler, task instances). It stands at the pond and fishes.
- **Team patch.** Hover or focus a character and a faint light shows under the other sessions of the same project. Sessions of one project stand near each other, nearer still on the same branch.
- **Name tags and leader lines.** Each tag shows the session's title. In a crowd, tags shorten to their most telling words, such as ticket ids and names. A tag with no room below moves beside its owner with a thin line pointing back. In a very tight crowd a tag may shrink to a few letters with an ellipsis; hover or focus the character for the full title. Right-to-left titles read right to left. When the crowd shrinks, characters walk calmly, one at a time, to spots where more tags stay readable.
- **"+N" on the sign.** More sessions need you than the garden shows.
- **The quiet note.** With nobody waiting, the garden says "Nobody needs you. Enjoy the garden." When the app cannot find its data or the CLI, the note says what is wrong instead, for example "No Claude Code data found: run claude once, then reload."
- **"♥" and "…" while leaving.** "♥" after you answered it; "…" when it started working or no longer waits. A character whose session starts working walks to the mine.

## Miners

A miner is a session that is working.

- **Pickaxe.** The session is working. A character walks to the mine when its session starts work, and back when it needs you.
- **Gold pan.** It runs tests, lint or type checks.
- **Mallet.** It edits files, builds, installs or deploys.
- **Mine lantern.** The lantern at the mine mouth burns, and glows after dark, while at least one session works. It goes dark when none does.
- **"+N" under the mine door.** More sessions work than the mine has room for. A miner keeps its spot while its session works; the plaque counts the rest, and the Working list names them all.
- **Notes on the mine door.** One paper note for each session that is out of step: its terminal is behind, two or more live programs hold it, or its copies diverged.
- **Weather vane.** The vane on the red roof points into the real wind, as if you look south (east is on the left); it changes only when the weather updates.
- **Nest on the cliff.** One egg for each day of the day streak the Stats panel shows, up to five; miss a day and it starts again.
- **Ore boulder.** The rock a miner works on: gold or ice-blue, fixed for each session.
- **Minis.** Subagents the session is running, as half-size characters beside it. Hover one for its task.
- **What a mini holds.** A lens when it looks for something, paper when it writes, a crate for anything else.

## Scenery from your day

The scenery counts what you did today. All of it clears at midnight.

- **Ore on the cart.** How many tokens you used today, in steps (see the Legend).
- **Sunflowers by the fence.** One per pull request opened today. Their heads follow the sun and droop at night.
- **Paper boats.** Runs started by a hook or script today.
- **Comet.** A night after a day with many pull requests, under a mostly clear sky.
- **Week constellation.** Each day of the past week with a pull request lights one star of a dipper, oldest day at the handle end, today at the pointer. Days without one are faint dots. Nothing shows until one day has a pull request. It shows whenever stars are out, away from the moon.
- **Shooting star.** At night, a session just finished its turn.
- **A bird leaves the big tree.** The same, by day.

The Stats panel's "Today in the garden" card shows today's own numbers: how far the ore is from its next step, how many sunflowers and boats there are, and how many pull requests the comet still needs.

## Sky and weather

The sky follows one city: Tel Aviv, unless you change it (see [How to change the city](#how-to-change-the-city)).

- **Sun.** It rises and sets at the city's real times. Dawn and dusk tint the sky.
- **Moon.** Tonight's real phase. It lights the pond.
- **Full-moon night.** Close to full moon, while the moon is up, the land is a little brighter and the moon has a wider faint halo.
- **Stars.** Bright stars sit where they really are; fainter ones are scattered. Clouds thin them out.
- **Rain, snow and puddles.** The weather there now. Puddles dry slowly after rain.
- **Rainbow.** It rained a short while ago and the sun is out.
- **Falling leaves.** Autumn. Leaves drift from the big tree and gather at its foot.
- **Migrating flocks.** Birds passing in season.
- **Chimney smoke.** The colder it is, the more chimneys smoke.
- **Wind.** Smoke and rain lean with it.
- **Camp fire.** Evening has come. It burns in dry weather, and characters beside it sit and face it.

Without internet the sky follows the clock only, and there is no weather.

## Town

- **Sent home.** You put a session aside. "Send home" is in its sidebar, and the character walks into a house. It comes back when it next waits for you, or at once with "Wake up" in its sidebar.
- **Cat on the fence.** The garden is truly idle: nothing is working and every waiting session has waited a long time (see the Legend). The cat leaves as soon as a session starts working or a new wait begins.
- **Chimney "z".** One per session asleep in town. Windows glow after dark.

## Lists and sidebar

Below the garden are two lists, Working and Resting, with a search box. Search matches the title, project, branch and text.

- **Red dot.** Its newest tool result failed.
- **"PR" badge.** It opened pull requests; the count shows when there are several.
- **"auto" badge.** A hook or script started it, not you. Quick reply is off for these; use the Terminal tab.
- **"open twice" badge.** Two or more live programs hold it, for example the page terminal and the desktop app.
- **"behind" badge.** Newer messages were written elsewhere. Open it and press Reload terminal.
- **"diverged" badge.** Its copies differ: another program wrote a branch that the page terminal leaves out.
- **"N automated runs".** Runs started by hooks or scripts fold into one line at the end of Resting. Click to open; the browser remembers. Search always finds them.
- **"Show N more".** Working and Resting show the newest sessions; this line unfolds the older ones in place.
- **Project and branch as the name.** The session has no real title yet (empty, "(session)" or its id prefix). The list shows project and branch, with the id prefix below, and the garden tag uses the same name.
- **Tab title and announcements.** The browser tab reads, for example, "(3) Session Desk" while three sessions need you. When a session starts waiting, a screen reader hears "<title> needs you" once. Automated runs are never announced.
- **"Terminals and quick replies are off" under the search box.** The `claude` command was not found or cannot run. The rest of the line says what to do.
- **Status pills** beside the title:
  - "live": changes arrive at once.
  - "live · polling": the change feed dropped; the page asks every few seconds.
  - "offline · retrying": the server is not answering. The page keeps trying.
  - "demo · example data": the page was opened as a file instead of through the server; open the address the server printed.
  - "updated · reload": the app changed on disk. Click to reload. It shows within a minute or so of the change.

### The sidebar

Click a character or a row to open the sidebar. The [README](../README.md#the-sidebar) covers the basics; here are the details.

**Terminal tab.** The real `claude --resume` for that session. A few page terminals can run at once (see the Legend). Closing the sidebar keeps a terminal running; "End terminal" stops it. After a server restart the terminal re-attaches by itself.
When the terminal stops, it says why:

- "Terminal ended. Open the Terminal tab again to start it.": the terminal was closed or stopped.
- "Terminal host stopped. Open the Terminal tab again to start a new terminal.": the terminal host is gone.
- "CLI ended (code N). Open the Terminal tab again to restart it.": the CLI itself exited.
- "Terminals and quick replies are off: The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.": the CLI could not run at all.

**Transcript tab.** The whole session as the CLI shows it.
Like the CLI, it prints no result line for a successful call whose result the CLI does not print, and leaves out calls the CLI prints nothing for.
It shows what the CLI shows by default: reads, searches and shell commands fold into one line in the CLI's words, such as "Ran 3 shell commands", and results the CLI hides stay hidden.
Click a tool line or a grouped line, or press Enter on it, to read its result in place; click again to hide it. Failed calls always show their error.
The Details switch in the tab's header shows every call and result at once, like ctrl+o in the CLI; your browser remembers it.
Find, in the tab's header (or `/`), searches every prompt, reply, tool line and result of the session, case-insensitive; several words must all appear in the same message or call. It shows "3 of 17", opens the grouped line or hidden result that holds the match, draws earlier parts when needed, and marks the words. Enter goes to the next match, Shift+Enter to the previous, and Esc closes Find and closes again what it opened.
The header's line count and "Show earlier" count the lines of the current view, so the Details switch changes them.
Esc in the reply box with text leaves the box and keeps the text; a second Esc closes the sidebar, and the text is still there when you open it again.
"Copy resume command" copies `claude --resume <id>`, so you can open the session in your own terminal; run it in the session's project folder.

## Keys

| Key | Where | What it does |
|---|---|---|
| `/` | Page | Jump to search. |
| `j` `k` | Page | Move down or up the list rows. |
| `↓` `↑` | On a row | Move down or up. |
| `↓` | Search box | Go to the first row. |
| `Esc` | Empty search box | Leave the box. |
| `Enter` | Row or character | Open the session. |
| `/` | Transcript tab | Open Find. |
| `Enter`, `Shift` `Enter` | Find box | Next or previous match. |
| `Esc` | Find box | Close Find. |
| `Esc` | Reply box with text | Leave the box; the text stays. |
| `F6` or `Ctrl` `Shift` `←` | Terminal tab | Move focus out of the terminal to the sidebar tabs. |
| `Shift` `F6` | Terminal tab | Move focus to the sidebar footer. |
| `F6`, or `Enter` on the Terminal tab button | Sidebar | Go back into the terminal. |
| Any other key | Terminal tab | Goes to the CLI: approvals, Esc, Ctrl+C, slash commands. |
| `Esc` | Sidebar | Close it. In the Terminal tab, Esc goes to the CLI. |
| `j` `k` | Transcript | Step through prompts and replies. |
| `c` | Transcript line | Copy the focused reply. |
| `Enter` | Reply box | Send. |
| `Shift` `Enter` | Reply box | New line. |
| `Tab` | Sidebar and Stats | Stays inside while open. |
| `←` `→` `Home` `End` | Stats chart | Pick a day or hour. |
| `Esc` | Stats | Close the panel. |

## How to change the city

The city is set in the code. Change all of these, then reload the page:

- `web/src/backdrop.js`, function `ilNow()`: the time zone `'Asia/Jerusalem'`.
- `web/src/backdrop.js`, function `loadWeather()`: `latitude=32.0853&longitude=34.7818` and `timezone=Asia%2FJerusalem` in the Open-Meteo address.
- `web/src/backdrop.js`, function `drawGarden()`: the label `'Tel Aviv '`.
- `web/src/world_time.js`, constants `LAT` and `LON`: the position the sun times, moon and stars use.
- `desk/stats.py`, constant `IL`: the time zone for days and hours in Stats. After changing it, restart the server with `python3 server.py restart` and delete the stats cache (`.stats-cache.json`).

## After a Claude Code update

The CLI's session files are not a public format, so an update can change them.
When the app finds records it does not understand, `/api/health` lists them under `formatWarnings`, and some titles or numbers may be missing until the app is updated. Nothing in your sessions is changed.
For people who change the code, two tools live in the source repository (not in the zip): `python3 tools/parity.py --report` prints data-quality counts for the sessions on this computer.
`python3 tools/screen_check.py` runs invented sessions through the real CLI in a scratch folder and compares its screen with what the app draws.
