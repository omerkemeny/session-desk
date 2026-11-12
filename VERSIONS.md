# Versions

Every finished version is a git tag. Nothing is pushed anywhere; all history is local.

| Tag | What it is |
|---|---|
| `v0-single-file` | The first app: one `index.html` page and one `server.py`. |
| `v1-restructure` | The same app split into a server package (`desk/`) and page modules (`web/`), with tests, a push feed for changes, and new art. |
| `v2-round1` | Real moon phase, stars, rainbow, falling leaves and migrating flocks; characters sit and nap, miners carry tools, minis hold props and a pennant marks a pull request. The lists fold tool runs and search better, the Transcript tab follows the CLI's display rules, and the stats cache is written safely. |
| `v3-round2` | The garden holds a crowd with non-overlapping name tags and a camp fire, automated runs fold away, and list rows show plain previews and badges. The Transcript tab draws interrupts, compactions and shell output, page terminals survive a server restart, and `start`, `stop`, `restart` and `status` arrive. |
| `v4-round3` | Every crowd name tag stays visible with the wait time on hover, umbrellas come out in the rain, and the scenery reflects your day (ore, sunflowers, paper boats, comet, drying puddles). The Terminal tab re-attaches after a server restart, the sidebar shows badges, Resting gets "Show N more", and the zip is tested on Python 3.9. |
| `v5-round4` | Titles match the CLI's resume picker, project-mates stand together with leader lines on their tags, a shooting star or bird marks a finished turn, and the sky follows the real sunrise, sunset and wind. Adds the "Today in the garden" card, the "updated · reload" pill, `doctor` and a summary cache that makes restarts fast. |
| `v6-round5` | A keyboard way out of the Terminal tab (F6), no work while the browser tab is hidden, a much lighter server on busy days, and file notifications for faster updates. Adds the week constellation, blankets for day-old waits, full-moon nights, regrouping when a crowd shrinks, the Legend page and the user guide. |
| `v7-round6` | A calmer garden where attention follows urgency: a yellow bubble for a fresh wait, quieter long waits, grey day-old waits and red only for failures. The page and server do less while nothing changes, memory and open files stay bounded, and quick replies report the CLI's exit code. |
| `v8-round7` | A first run says what is wrong in the terminal, the page and the garden, only one server runs per folder, and a missing CLI gets a clear message. The tab title counts who waits, screen readers hear when a session starts waiting, day-old characters keep their hue, name tags handle hard titles and right-to-left text, and the mine lantern and fence cat arrive. |
| `v9-round8` | The Transcript tab folds reads, searches and shell commands into one line as the CLI does, and a click or the Details switch shows the results. The list stays fast past 10,000 sessions, updates stay quick with hundreds of live sessions, the mine counts working sessions it has no room for, and the README and guide are rewritten with pictures. |
| `v10-round9` | Find searches a whole session from the Transcript tab, and the check suite runs in about a minute. The server keeps far less of each transcript in memory, `logs` shows the recent log lines, and a session counts as open twice only when two programs really hold it. |
| `v11-round10` | Tool lines, long errors and interrupted calls read as the CLI shows them, checked against its screen in 61 cases. Find jumps to far matches at once, big sessions cost only what was added, every setup problem has one sentence, and the garden gains a weather vane and a nest. |

Later versions add `v12-…` and on below.

## Go back to a version

This needs a git checkout of the app; an unzipped copy has no history.
First note the branch you are on, so you can come back to it. In the app's own folder it is `main`:

```bash
git branch --show-current
```

Then end the page terminals, because another version may not be able to talk to this terminal host, and switch:

```bash
python3 server.py stop-terminals
git status                    # must be clean; commit or stash first
git checkout <tag>            # for example: git checkout v6-round5
python3 server.py restart
```

`git checkout <tag>` leaves a "detached HEAD": git says so, and that is expected. You are looking at an old version, not on a branch.

`restart` exists from `v3-round2` on. For an older tag, run `python3 server.py stop` before `git checkout <tag>`, then start it in the foreground with `python3 server.py`.

To return to the newest version, run `python3 server.py stop-terminals`, then `git checkout <the branch you noted>` (for example `git checkout main`), then `python3 server.py restart`.
After an older tag's foreground server, press Ctrl+C there and run `python3 server.py start` instead of `restart`.
Your conversations are not affected: every session stays resumable.
