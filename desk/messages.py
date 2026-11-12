"""Every user-facing sentence about setup in one table: one core sentence per state, and the lead-in each place puts before it."""

CORE = {  # state -> the one sentence for it; health `setup.hint` is exactly this, and the page prints it after its own lead-in
    "dataMissing": "No Claude Code data found: run `claude` once, then reload.",
    "dataUnreadable": "The Claude Code data folder cannot be read: check its permissions, then reload.",
    "noSessions": "No Claude Code sessions yet: run `claude` in a project folder, then reload.",
    "readOnly": "This folder is read-only: start with DESK_STATE_DIR=<a folder you can write>.",
    "cliMissing": "The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.",
    "cliBroken": "The `claude` command cannot be run: reinstall Claude Code or set DESK_CLAUDE_BIN.",
}
RELOAD = "then reload."  # the page's ending; a terminal has nothing to reload
TERMINAL_END = {  # doctor's ending instead of RELOAD: what to run next in a terminal
    "dataMissing": "then run `python3 server.py doctor` again.",
    "dataUnreadable": "then run `python3 server.py doctor` again.",
    "noSessions": "then open the page (`python3 server.py status` prints its address).",
}
TERMS_OFF = "Terminals and quick replies are off: "  # the page's own lead-in for a CLI that cannot run
LEAD = {  # place -> {state: lead-in}; a state a place never meets is left out
    "health": {k: "" for k in CORE},
    "startLine": dict({k: "" for k in CORE}, readOnly="Page terminals are off and caches last for this run only: "),
    "start": dict({k: "" for k in CORE}, readOnly="Session Desk cannot run in the background here (`python3 server.py` in the foreground runs with page terminals off): "),
    "restart": dict({k: "" for k in CORE}, readOnly="Session Desk cannot run in the background here (`python3 server.py` in the foreground runs with page terminals off): "),
    "status": {k: "" for k in CORE},
    "doctor": {k: "" for k in CORE},
    "doctorCheck": {"dataMissing": "{home} does not exist (set DESK_CLAUDE_DIR if your data lives elsewhere): ",
                    "dataUnreadable": "{home} cannot be read (`ls -ld {home}` shows its permissions): ", "noSessions": "{home}: ",
                    "readOnly": "{dir}: ", "cliMissing": TERMS_OFF, "cliBroken": "Terminals and quick replies are off ({cli}): "},
    "termOpen": {"readOnly": "Page terminals are off: ", "cliMissing": TERMS_OFF, "cliBroken": TERMS_OFF},
    "reply": {"cliMissing": "Quick replies are off: ", "cliBroken": "Quick replies are off: "},
}
TERMINAL_PLACES = ("doctor", "doctorCheck")  # places that use the terminal ending


def sentence(place, state):
    """The core sentence as a place words it: the page's for every place but doctor, which says what to run instead of reloading."""
    core = CORE[state]
    if place in TERMINAL_PLACES and state in TERMINAL_END:
        return core[:-len(RELOAD)] + TERMINAL_END[state]
    return core


def say(place, state, **fill):
    """The whole line a place prints for a state: its lead-in (with {home}, {dir} or {cli} filled) and the sentence."""
    return LEAD[place][state].format(**fill) + sentence(place, state)


def stem(state):
    """The part of a state's sentence every place says word for word."""
    core = CORE[state]
    return core[:-len(RELOAD)].rstrip(", ") if core.endswith(RELOAD) else core


def table():
    """(state, place, line) for every place that speaks about a state, placeholders left in; the docs quote these."""
    return [(state, place, LEAD[place][state] + sentence(place, state)) for state in CORE for place in LEAD if state in LEAD[place]]


def state_of(hint):
    """The state whose core sentence a hint is, or None."""
    return next((k for k, v in CORE.items() if v == hint), None)
