"""Writes the synthetic data folder in tests/fixtures/home (invented sessions only); run it again after changing a case."""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "home")
CASES = os.path.join(HERE, "cases")  # one session per parity rule, kept apart so the main fixture's counts stay fixed
S1, S2, S3, S4, S5, S6 = (f"{d * 8}-{d * 4}-4{d * 3}-8{d * 3}-{d * 12}" for d in "123456")
DESKTOP = "c" + "laude-desktop"  # entrypoint of the desktop app
T1, T2, T3 = (f"7{d * 7}-7777-4777-8777-777777777777" for d in "abc")


def user(uuid, parent, ts, content, **extra):
    """A user record."""
    return dict({"parentUuid": parent, "isSidechain": False, "type": "user", "message": {"role": "user", "content": content}, "uuid": uuid,
                 "timestamp": ts, "userType": "external", "entrypoint": "cli", "cwd": "/work/alpha", "sessionId": "x", "gitBranch": "main"}, **extra)


def assistant(uuid, parent, ts, mid, content, usage, **extra):
    """An assistant record."""
    return dict({"parentUuid": parent, "isSidechain": False, "type": "assistant", "uuid": uuid, "timestamp": ts, "userType": "external",
                 "entrypoint": "cli", "cwd": "/work/alpha", "sessionId": "x", "gitBranch": "main",
                 "message": {"id": mid, "type": "message", "role": "assistant", "model": "model-x", "content": content, "usage": usage}}, **extra)


def text(s):
    """A text block."""
    return {"type": "text", "text": s}


def tool(tid, name, inp):
    """A tool call block."""
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def result(tid, content, error=False):
    """A tool result block."""
    return {"type": "tool_result", "tool_use_id": tid, "content": content, "is_error": error}


def usage(i, o, cw=0, cr=0):
    """A usage block."""
    return {"input_tokens": i, "output_tokens": o, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr}


def write(project, sid, recs, out=OUT):
    """Write one transcript as JSON lines."""
    os.makedirs(os.path.join(out, "projects", project), exist_ok=True)
    with open(os.path.join(out, "projects", project, sid + ".jsonl"), "w") as fh:
        for r in recs:
            if isinstance(r, str):
                fh.write(r + "\n")  # a raw line, for broken-record cases
                continue
            if r.get("sessionId") == "x":
                r = dict(r, sessionId=sid)  # rows carry their own session id, as the CLI writes them
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")


def main():
    """Rebuild the whole fixture folder."""
    shutil.rmtree(OUT, ignore_errors=True)
    ts = "2026-01-05T10:00:%02d.000Z"
    # S1: own title, split message counted once, sidechain skipped, tool results, an unknown record type.
    write("-work-alpha", S1, [
        {"type": "custom-title", "customTitle": "Fix the login flow", "sessionId": S1},
        user("s1-u1", None, ts % 0, "Please fix the login redirect loop"),
        assistant("s1-a1", "s1-u1", ts % 1, "msg_1", [text("Looking at the redirect.")], usage(10, 5, 100, 1000)),
        assistant("s1-a2", "s1-a1", ts % 2, "msg_1", [tool("tu_1", "Edit", {"file_path": "/work/alpha/login.py", "old_string": "a", "new_string": "b"})], usage(10, 5, 100, 1000)),
        user("s1-u2", "s1-a2", ts % 3, [result("tu_1", "line1\nline2\nline3\nline4\nline5\nline6")]),
        assistant("s1-side", "s1-u2", ts % 4, "msg_side", [text("side work")], usage(999, 999, 999), isSidechain=True),
        assistant("s1-a3", "s1-u2", ts % 5, "msg_2", [tool("tu_2", "Bash", {"command": "pytest -q"})], usage(20, 7)),
        user("s1-u3", "s1-a3", ts % 6, [result("tu_2", [text("1 failed")], True)]),
        assistant("s1-a4", "s1-u3", ts % 7, "msg_3", [text("Fixed the loop; tests pass now.")], usage(3, 4)),
        {"type": "some-future-record", "detail": {"anything": [1, 2]}},
    ])
    # S2: automatic name, carried-over summary first, and a rewind: the old branch must not show.
    write("-work-alpha", S2, [
        {"type": "custom-title", "customTitle": "side chat", "sessionId": S2},
        user("s2-c0", None, ts % 10, "This session is being continued from a previous conversation. Summary: earlier work", isCompactSummary=True),
        assistant("s2-b1", "s2-c0", ts % 11, "m21", [text("Understood.")], usage(1, 1)),
        user("s2-b2", "s2-b1", ts % 12, "Add dark mode to the settings page"),
        assistant("s2-b3", "s2-b2", ts % 13, "m22", [text("Which colours?")], usage(1, 1)),
        user("s2-b4", "s2-b3", ts % 14, "Old branch request"),
        assistant("s2-b5", "s2-b4", ts % 15, "m23", [text("Old branch answer")], usage(1, 1)),
        user("s2-b6", "s2-b3", ts % 16, "Use the slate palette"),
        assistant("s2-b7", "s2-b6", ts % 17, "m24", [text("Done with slate.")], usage(1, 1)),
    ])
    # S3..S6: active sessions that share titles; S3 also runs subagents.
    for sid, title, ask in ((S3, "Refactor billing", "Split invoices module"), (S4, "Refactor billing", "Rename billing tables"),
                            (S5, "Ship release", "Tag version one"), (S6, "Ship release", "Tag version one")):
        write("-work-beta", sid, [
            {"type": "custom-title", "customTitle": title, "sessionId": sid},
            user(sid + "-u", None, ts % 20, ask, cwd="/work/beta"),
            assistant(sid + "-a", sid + "-u", ts % 21, sid + "-m", [text("On it.")], usage(1, 1), cwd="/work/beta"),
        ])
    sub = os.path.join(OUT, "projects", "-work-beta", S3, "subagents")
    os.makedirs(sub)
    # Compact JSON as the CLI writes it; agent-a2 is written with spaces on purpose, as a robustness case.
    for name, meta in (("agent-a1", {"agentType": "Explore", "description": "Explore billing code"}),
                       ("agent-a2", {"agentType": "Explore", "description": "Finished helper", "finished": True}),
                       ("agent-a3", {"agentType": "Explore", "description": "Stale helper"})):
        sep = (", ", ": ") if name == "agent-a2" else (",", ":")
        with open(os.path.join(sub, name + ".meta.json"), "w") as fh:
            json.dump(meta, fh, separators=sep)
        with open(os.path.join(sub, name + ".jsonl"), "w") as fh:
            fh.write(json.dumps(assistant(name, None, ts % 22, name + "-m", [text("sub work")], usage(5, 5), isSidechain=True), separators=sep) + "\n")
    # T1..T3: usage statistics around 2026-06-15 12:00 Israel time; prompt words must never reach the stats output.
    day = "2026-06-15T08:00:%02d.000Z"
    write("-work-zoo", T1, [
        user("t1-u1", None, day % 0, "zebrafruit alpha request", cwd="/work/zoo"),
        assistant("t1-a1", "t1-u1", day % 10, "s_m1", [text("Opening a PR."), tool("tp1", "Bash", {"command": "gh pr create --title quokka"})], usage(100, 10, 5, 50), cwd="/work/zoo"),
        assistant("t1-a1b", "t1-a1", day % 11, "s_m1", [text("Opening a PR.")], usage(100, 20, 5, 50), cwd="/work/zoo"),
        user("t1-r1", "t1-a1b", day % 20, [result("tp1", "https://github.com/acme/widgets/pull/7")], cwd="/work/zoo"),
        assistant("t1-a2", "t1-r1", day % 30, "s_m2", [tool("tc1", "Bash", {"command": "git commit -m quokka"})], usage(10, 1), cwd="/work/zoo"),
        user("t1-r2", "t1-a2", day % 40, [result("tc1", "[main abc] quokka")], cwd="/work/zoo"),
        assistant("t1-a3", "t1-r2", day % 50, "s_m3", [text("All done.")], usage(1, 2), cwd="/work/zoo"),
    ])
    write("-work-zoo", T2, [
        user("t2-u1", None, "2026-06-05T08:00:00.000Z", "mangosteen question", cwd="/work/zoo"),
        assistant("t2-a1", "t2-u1", "2026-06-05T08:00:20.000Z", "s_m4", [text("An answer.")], usage(7, 3), cwd="/work/zoo"),
    ])
    write("-work-zoo", T3, [
        user("t3-u1", None, "2026-04-01T08:00:00.000Z", "papaya plan", cwd="/work/zoo"),
        user("t3-u2", "t3-u1", "2026-04-01T08:00:05.000Z", [text("[Request interrupted by user]")], cwd="/work/zoo"),
    ])

    cases()


def case_id(n):
    """Session id of parity case n."""
    return f"c{n:07x}-0000-4000-8000-{n:012x}"


def cases():
    """One small session per display rule; tests/test_parity.py names the expected outcome of each."""
    shutil.rmtree(CASES, ignore_errors=True)
    ts = "2026-02-01T10:%02d:%02d.000Z"
    t = iter(ts % (i // 60, i % 60) for i in range(3600))
    w = lambda n, recs: write("-work-cases", case_id(n), recs, CASES)  # noqa: E731
    u = lambda uid, parent, content, **kw: user(uid, parent, next(t), content, **kw)  # noqa: E731
    a = lambda uid, parent, mid, content, **kw: assistant(uid, parent, next(t), mid, content, usage(1, 1), **kw)  # noqa: E731
    # 1 branching: two programs wrote branches off one reply; the CLI follows the newest checkpoint, not the last line.
    w(1, [u("u1", None, "Branch base request"), a("a1", "u1", "m1", [text("Base answer")]),
          u("x1", "a1", "Terminal branch request"), a("x2", "x1", "m2", [text("Terminal branch answer")]),
          {"type": "last-prompt", "lastPrompt": "Terminal branch request", "leafUuid": "x2", "sessionId": "x"},
          u("y1", "a1", "Desktop branch request", entrypoint="claude-desktop"), a("y2", "y1", "m3", [text("Desktop branch answer")], entrypoint="claude-desktop")])
    # 2 grown branch with an interrupted turn and a prompt queued while the session worked.
    w(2, [u("u1", None, "First request"), a("a1", "u1", "m1", [text("First answer")]),
          {"type": "last-prompt", "lastPrompt": "First request", "leafUuid": "a1", "sessionId": "x"},
          u("u2", "a1", "Stopped request"), u("i1", "u2", [text("[Request interrupted by user]")]),
          u("u3", "i1", "Second request"), a("a3", "u3", "m3", [text("Second answer")]),
          dict({k: v for k, v in user("q1", "a3", next(t), "").items() if k != "message"}, type="attachment",
               attachment={"type": "queued_command", "prompt": "Queued request", "commandMode": "prompt", "origin": {"kind": "human"}}),
          a("a4", "q1", "m4", [text("Answer to the queued request")])])
    # 3 compaction: rows before the newest boundary are gone except the preserved tail; the summary is not a turn.
    w(3, [u("u1", None, "Old request"), a("a1", "u1", "m1", [text("Old answer")]),
          u("u2", "a1", "Kept request"), a("a2", "u2", "m2", [text("Kept answer")]),
          {"parentUuid": None, "logicalParentUuid": "a2", "isSidechain": False, "type": "system", "subtype": "compact_boundary", "uuid": "b1",
           "timestamp": next(t), "sessionId": "x", "compactMetadata": {"trigger": "manual", "preservedMessages": {"anchorUuid": "s1", "uuids": ["u2", "a2"]}}},
          u("s1", "b1", "This session is being continued from a previous conversation. Summary.", isCompactSummary=True, isVisibleInTranscriptOnly=True),
          u("u3", "s1", "New request"), a("a3", "u3", "m3", [text("New answer")])])
    # 4 parallel tool calls: one message split over two lines, each tool result hangs off its own piece.
    w(4, [u("u1", None, "Run both checks"), a("a1", "u1", "m1", [tool("t1", "Bash", {"command": "echo one"})]),
          a("a2", "a1", "m1", [tool("t2", "Bash", {"command": "echo two"})]),
          u("r1", "a1", [result("t1", "one")]), u("r2", "a2", [result("t2", "two")]),
          a("a3", "r2", "m2", [text("Both ran.")])])
    # 5 records injected by hooks or the system: meta text and task notifications are not turns; unknown tags show raw.
    w(5, [u("m0", None, "Injected skill text", isMeta=True), u("u1", "m0", "Real first request"), a("a1", "u1", "m1", [text("Answer")]),
          u("n1", "a1", "<task-notification>agent finished</task-notification>", origin={"kind": "task-notification"}),
          u("u2", "n1", [text("<system-reminder>note</system-reminder>"), text("Follow-up request")], origin={"kind": "human"}),
          a("a2", "u2", "m2", [text("Follow-up answer")])])
    # 6 renamed twice: the last custom title wins over the automatic one.
    w(6, [{"type": "ai-title", "aiTitle": "Automatic title", "sessionId": "x"}, {"type": "custom-title", "customTitle": "First name", "sessionId": "x"},
          u("u1", None, "Rename me"), a("a1", "u1", "m1", [text("Ok")]), {"type": "custom-title", "customTitle": "Second name", "sessionId": "x"}])
    # 7 only an automatic title.
    w(7, [{"type": "ai-title", "aiTitle": "Automatic only", "sessionId": "x"}, u("u1", None, "Untitled request"), a("a1", "u1", "m1", [text("Ok")])])
    # 8 sidechain row in the main file and a split message: the first is skipped, the second counted once.
    w(8, [u("u1", None, "Count tokens"), assistant("a1", "u1", next(t), "m1", [text("Part one")], usage(10, 5)),
          assistant("a2", "a1", next(t), "m1", [text("Part two")], usage(10, 5)),
          assistant("sc", "a2", next(t), "side", [text("Side work")], usage(999, 999), isSidechain=True)])
    # 9 forked session: rows copied from the parent keep the parent's id and do not count as this session's tokens.
    w(9, [dict(user("p1", None, next(t), "Parent request"), sessionId=case_id(99)),
          dict(assistant("p2", "p1", next(t), "pm", [text("Parent answer")], usage(500, 500)), sessionId=case_id(99)),
          u("f1", "p2", "Fork request"), assistant("f2", "f1", next(t), "fm", [text("Fork answer")], usage(3, 4))])
    # 10 missing parent: the row joins the newest row written at most 5 seconds before it.
    w(10, [u("u1", None, "Before the gap"), a("a1", "u1", "m1", [text("Answer before")]),
           u("u2", "lost-row", "After the gap"), a("a2", "u2", "m2", [text("Answer after")])])
    # 11 continued under a new id: the old session leaves the list while the new one exists.
    w(11, [u("u1", None, "Old session request"), a("a1", "u1", "m1", [text("Old answer")]),
           {"type": "continued-in", "timestamp": next(t), "sessionId": "x", "continuedInSessionId": case_id(12)}])
    w(12, [u("u1", None, "Continued session request"), a("a1", "u1", "m1", [text("Continued answer")])])
    hd = dict(entrypoint="sdk-cli")
    # 13 headless: every row was written by the headless CLI.
    w(13, [u("u1", None, "Hook started request", **hd), a("a1", "u1", "m1", [text("Hook answer")], **hd)])
    # 14 interactive, with a quick reply added later by the headless CLI.
    w(14, [u("u1", None, "Typed request"), a("a1", "u1", "m1", [text("Typed answer")]),
           u("u2", "a1", "Quick reply", **hd), a("a2", "u2", "m2", [text("Quick answer")], **hd)])
    # 15 newest tool call and result of the shown branch; a later branch the CLI does not show used another tool.
    w(15, [u("u1", None, "Look around"), a("a1", "u1", "m1", [tool("t1", "Read", {"file_path": "/work/cases/a.txt"})]),
           u("r1", "a1", [result("t1", "contents")]), a("a2", "r1", "m2", [tool("t2", "Grep", {"pattern": "needle"})]),
           u("r2", "a2", [result("t2", "no such file", error=True)]), a("a3", "r2", "m3", [text("The search failed.")]),
           {"type": "last-prompt", "lastPrompt": "Look around", "leafUuid": "a3", "sessionId": "x"},
           u("v1", "a1", "Other branch", entrypoint=DESKTOP),
           a("v2", "v1", "m4", [tool("t3", "Write", {"file_path": "/work/cases/b.txt"})], entrypoint=DESKTOP),
           u("v3", "v2", [result("t3", "written")], entrypoint=DESKTOP)])
    # 16 pull requests: one by command, one by connector; a failed, an already-existing and a repeated link are not counted again.
    url = "https://github.com/acme/widgets/pull/7"
    gh = "gh pr " + "create"
    w(16, [u("u1", None, "Open the pull requests"),
           a("a1", "u1", "m1", [tool("p1", "Bash", {"command": "git push && " + gh + " --fill"})]), u("r1", "a1", [result("p1", "Created " + url)]),
           a("a2", "r1", "m2", [tool("p2", "Bash", {"command": gh + " --fill"})]), u("r2", "a2", [result("p2", "boom", error=True)]),
           a("a3", "r2", "m3", [tool("p3", "Bash", {"command": gh + " -t x"})]), u("r3", "a3", [result("p3", "a pull request already exists: " + url)]),
           a("a4", "r3", "m4", [tool("p4", "mcp__forge__create_pull_request", {"title": "x"})]), u("r4", "a4", [result("p4", "ok")]),
           a("a5", "r4", "m5", [tool("p5", "Bash", {"command": gh + " --fill"})]), u("r5", "a5", [result("p5", url)]),
           a("a6", "r5", "m6", [tool("p6", "Bash", {"command": "echo " + gh})]), u("r6", "a6", [result("p6", url.replace("7", "8"))]),
           a("a7", "r6", "m7", [text("Opened.")])])
    # 17 anomalies the parser tolerates: a broken line, an unknown record type, a duplicate uuid, a timestamp going backwards.
    w(17, [u("u1", None, "Tolerate odd lines"), '{"type":"user","uuid":"broken', {"type": "a-new-kind", "sessionId": "x"},
           a("a1", "u1", "m1", [text("First copy")]), assistant("a1", "u1", "2026-02-01T10:00:00.000Z", "m1", [text("Second copy")], usage(1, 1)),
           u("u2", "a1", "Later request"), a("a2", "u2", "m2", [text("Later answer")])])
    # 18 markers and output the CLI prints: interrupt, ! command output, local command output, an image beside a prompt, an image-only prompt.
    pic = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}
    w(18, [u("u1", None, "Start here"), a("a1", "u1", "m1", [text("Started")]),
           u("u2", "a1", "Long request"), u("i1", "u2", [text("[Request interrupted by user]")]),
           u("b1", "i1", "<bash-input>ls</bash-input>"), u("b2", "b1", "<bash-stdout>one\ntwo</bash-stdout><bash-stderr>warn</bash-stderr>"),
           u("c1", "b2", "<command-name>/cost</command-name><command-args></command-args>"),
           u("c2", "c1", "<local-command-stdout>Total cost: 0</local-command-stdout>"),
           u("p1", "c2", [text("Look at this"), pic, pic]), a("a2", "p1", "m2", [text("Two pictures")]),
           u("p2", "a2", [pic]), a("a3", "p2", "m3", [text("One picture")])])
    def compacted(n, tag):
        """Rows of a session compacted with a preserved tail; returns the records and the summary row id."""
        return [u("o1", None, tag + " old request"), a("o2", "o1", "m1", [text(tag + " old answer")]),
                u("k1", "o2", tag + " kept request"), a("k2", "k1", "m2", [text(tag + " kept answer")]),
                {"parentUuid": None, "isSidechain": False, "type": "system", "subtype": "compact_boundary", "uuid": "b1", "timestamp": next(t), "sessionId": "x",
                 "compactMetadata": {"trigger": "manual", "preservedMessages": {"anchorUuid": "s1", "uuids": ["k1", "k2"]}}},
                u("s1", "b1", "Summary.", isCompactSummary=True)]
    # 19 compaction, then branches and no checkpoint: the tip above the last row is shown, even when it is older.
    w(19, compacted(19, "Tips") + [u("x1", "s1", "Branch one request"), a("x2", "x1", "m3", [text("Branch one answer")]),
                                   u("y1", "s1", "Branch two request"), a("y2", "y1", "m4", [text("Branch two answer")])])
    # 20 compaction, checkpoint in the middle of one branch (not a tip): the tip above the last row is shown.
    w(20, compacted(20, "Mid") + [u("x1", "s1", "Branch one request"), a("x2", "x1", "m3", [text("Branch one answer")]),
                                  {"type": "last-prompt", "leafUuid": "x1", "sessionId": "x"},
                                  u("y1", "s1", "Branch two request"), a("y2", "y1", "m4", [text("Branch two answer")])])
    # 21 missing parent: a newer parentless sidechain row is not a bridge target.
    w(21, [u("u1", None, "Before the gap"), a("a1", "u1", "m1", [text("Answer before")]),
           a("sc", None, "side", [text("Side work")], isSidechain=True),
           u("u2", "lost-row", "After the gap"), a("a2", "u2", "m2", [text("Answer after")])])
    # 22 old format: a progress line between two rows is skipped over.
    w(22, [u("u1", None, "Before progress"), {"type": "progress", "uuid": "g1", "parentUuid": "u1", "timestamp": next(t), "sessionId": "x"},
           a("a1", "g1", "m1", [text("Answer after progress")])])
    # 23 rewound to empty: an explicit checkpoint without a row.
    w(23, [u("u1", None, "Rewound request"), a("a1", "u1", "m1", [text("Rewound answer")]),
           {"type": "last-prompt", "leafUuid": None, "explicit": True, "sessionId": "x"}])
    # 24 explicit checkpoint at an earlier reply with nothing written after it: the conversation ends there.
    w(24, [u("u1", None, "Kept request"), a("a1", "u1", "m1", [text("Kept answer")]),
           u("u2", "a1", "Rewound request"), a("a2", "u2", "m2", [text("Rewound answer")]),
           {"type": "last-prompt", "leafUuid": "a1", "explicit": True, "sessionId": "x"}])
    # 25 a tool result hanging off another row is matched to its call by id.
    w(25, [u("u1", None, "Run it"), a("a1", "u1", "m1", [tool("t1", "Bash", {"command": "false"})]),
           u("r1", "u1", [result("t1", "it failed", error=True)]), a("a2", "a1", "m2", [text("It failed.")])])
    # 26 parallel tool calls with the checkpoint at the second result: all three calls and results show.
    w(26, [u("u1", None, "Run three"), a("a1", "u1", "m1", [tool("t1", "Bash", {"command": "one"})]),
           a("a2", "a1", "m1", [tool("t2", "Bash", {"command": "two"})]), a("a3", "a2", "m1", [tool("t3", "Bash", {"command": "three"})]),
           u("r1", "a1", [result("t1", "out one")]), u("r2", "a2", [result("t2", "out two")]), u("r3", "a3", [result("t3", "out three")]),
           {"type": "last-prompt", "leafUuid": "r2", "sessionId": "x"}])
    # 27 command output length and tool display names: older ! output past 4 lines is cut to 3, the newest and local output show whole.
    six = "\n".join("line %d" % i for i in range(1, 7))
    calls = [("Read", {"file_path": "/w/a.txt"}), ("Edit", {"file_path": "/w/a.txt", "old_string": "a", "new_string": "b"}),
             ("Write", {"file_path": "/w/b.txt", "content": "x"}), ("Bash", {"command": "make", "description": "Build"}),
             ("Grep", {"pattern": "needle", "path": "/w"}), ("Glob", {"pattern": "**/*.py"}),
             ("Task", {"description": "Look around", "prompt": "p", "subagent_type": "Explore"}),
             ("Agent", {"description": "Helper", "prompt": "p", "subagent_type": "general-purpose"}),
             ("WebFetch", {"url": "https://example.com/x", "prompt": "p"}), ("WebSearch", {"query": "weather"}),
             ("TodoWrite", {"todos": []}), ("mcp__srv__do_thing", {"query": "q1"}), ("Skill", {"skill": "foo"})]
    recs, prev = [u("u1", None, "Show output")], "u1"
    for i, (body, kind) in enumerate([("<bash-input>seq 6</bash-input>", 0), (f"<bash-stdout>{six}</bash-stdout><bash-stderr></bash-stderr>", 0),
                                      ("<command-name>/status</command-name><command-args></command-args>", 0),
                                      (f"<local-command-stdout>{six}</local-command-stdout>", 0),
                                      ("<bash-input>seq 6</bash-input>", 0), (f"<bash-stdout>{six}</bash-stdout><bash-stderr></bash-stderr>", 0)]):
        recs.append(u(f"o{i}", prev, body))
        prev = f"o{i}"
    for i, (name, inp) in enumerate(calls):
        recs += [a(f"c{i}", prev, f"mc{i}", [tool(f"tc{i}", name, inp)]), u(f"d{i}", f"c{i}", [result(f"tc{i}", "ok")])]
        prev = f"d{i}"
    w(27, recs + [a("end", prev, "mend", [text("Shown.")])])
    sdk = dict(entrypoint=DESKTOP, turnOrigin="sdk")
    # 28 started by a hook through the desktop app: one slash command, every prompt row marked sdk, so it is automated though not headless.
    w(28, [u("u1", None, "<command-name>/save</command-name><command-args>/work/cases/notes.md</command-args>", **sdk),
           a("a1", "u1", "m1", [text("Saved.")], entrypoint=DESKTOP), u("u2", "a1", "Typed later", entrypoint=DESKTOP, turnOrigin="human")][:2])
    # 29-41 titles as the resume picker names a session without its own title (seen on the CLI screen, docs/data-model.md).
    lp = lambda leaf, said: {"type": "last-prompt", "lastPrompt": said, "leafUuid": leaf, "sessionId": "x"}  # noqa: E731
    two = lambda first, second: [u("u1", None, first), a("a1", "u1", "m1", [text("One")]), u("u2", "a1", second), a("a2", "u2", "m2", [text("Two")])]  # noqa: E731
    # 29 the latest checkpoint's prompt names it, not the first request.
    w(29, two("Picker first request", "Picker later request") + [lp("a2", "Picker later request")])
    # 30 an empty checkpoint prompt falls back to the first request (not to an older checkpoint).
    w(30, two("Empty first request", "Empty later request") + [lp("a1", "Older checkpoint prompt"), lp("a2", "")])
    # 31 the checkpoint prompt loses its reminder block and its line breaks.
    w(31, two("Reminder first", "Reminder later") + [lp("a2", "<system-reminder>note</system-reminder>\nReminder later\nsecond line")])
    # 32 a slash command with arguments is a first request; one without arguments is passed over.
    w(32, two("<command-name>/status</command-name>\n<command-args></command-args>",
              "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>pr twelve</command-args>"))
    # 33 only slash commands without arguments: the first one names it.
    w(33, two("<command-name>/status</command-name>\n<command-args></command-args>", "<command-name>/cost</command-name>\n<command-args></command-args>"))
    # 34 a pasted block alone: the picker shows what was pasted, on one line.
    w(34, two('<pasted_content id="ab12">\nPasted body\nsecond pasted line\n</pasted_content id="ab12">', "After the paste"))
    # 35 typed words around a pasted wrapper the picker leaves raw: the app keeps the typed words.
    w(35, two("Plain first", "Later") + [lp("a2", 'Typed words <pasted_content id="p1">pasted</pasted_content id="p1">')])
    # 36 a reminder block before the typed text: the typed block is the first request.
    w(36, [u("u1", None, [text("<system-reminder>\nnote\n</system-reminder>"), text("Words after the reminder")]), a("a1", "u1", "m1", [text("Ok")])])
    # 37 a long first request is cut at a word with an ellipsis.
    w(37, [u("u1", None, "Long request " + " ".join("word%d" % i for i in range(60))), a("a1", "u1", "m1", [text("Ok")])])
    # 38 a request over several lines reads as one line.
    w(38, [u("u1", None, "Line one\nline two\n\nline three"), a("a1", "u1", "m1", [text("Ok")])])
    # 39 a checkpoint prompt that is only tags: the picker shows the session id's first 8 characters.
    w(39, two("Tags first", "Tags later") + [lp("a2", "<command-message>save</command-message>\n<command-name>/save</command-name>\n<command-args>x</command-args>")])
    # 40 no prompt at all (only a pasted block in another wrapper): the picker shows (session).
    w(40, [u("u1", None, '<pasted_content id="zz">pasted</pasted_content id="zz">'), a("a1", "u1", "m1", [text("Ok")])])
    # 41 a checkpoint prompt more than 64 KB before the end is out of the picker's reach: the first request names it.
    w(41, two("Far first request", "Far later request") + [lp("a2", "Far checkpoint prompt"),
          u("r1", "a2", [result("t9", "x" * 70000)]), a("a3", "r1", "m3", [text("Done")])])
    # 42-46 rules settled on the CLI screen with tools/screen_check.py (round 7).
    dk = dict(entrypoint=DESKTOP)
    # 42 two programs, each with its own checkpoint on its own branch; the terminal wrote rows after the desktop app's checkpoint.
    w(42, [u("u1", None, "Shared base request"), a("a1", "u1", "m1", [text("Shared base answer")]),
           u("x1", "a1", "Terminal first request"), a("x2", "x1", "m2", [text("Terminal first answer")]), lp("x2", "Terminal first request"),
           u("y1", "a1", "Desktop request", **dk), a("y2", "y1", "m3", [text("Desktop answer")], **dk), lp("y2", "Desktop request"),
           u("x3", "x2", "Terminal later request"), a("x4", "x3", "m4", [text("Terminal later answer")])])
    # 43 a prompt queued below the end row, and two local command outputs past 4 lines (also copied under a name that is not a session id).
    queued = lambda uid, parent, said: dict({k: v for k, v in user(uid, parent, next(t), "").items() if k != "message"}, type="attachment",  # noqa: E731
                                            attachment={"type": "queued_command", "prompt": said, "commandMode": "prompt", "origin": {"kind": "human"}})
    w(43, [u("u1", None, "Queue base request"),
           u("c1", "u1", "<command-message>first</command-message>\n<command-name>/first</command-name>\n<command-args></command-args>"),
           u("o1", "c1", f"<local-command-stdout>{six}</local-command-stdout>"),
           u("c2", "o1", "<command-message>second</command-message>\n<command-name>/second</command-name>\n<command-args></command-args>"),
           u("o2", "c2", f"<local-command-stdout>{six}</local-command-stdout>"),
           a("a1", "o2", "m1", [text("Queue base answer")]), lp("a1", "Queue base request"), queued("q1", "a1", "Queued below the end")])
    # 44 continued under a new id, then a typed prompt and a reply in the old session: it stays listed.
    w(44, [u("u1", None, "Before moving"), a("a1", "u1", "m1", [text("Moved answer")]),
           {"type": "continued-in", "timestamp": next(t), "sessionId": "x", "continuedInSessionId": case_id(12)},
           u("u2", "a1", "Typed after the move"), a("a2", "u2", "m2", [text("Answer after the move")])])
    # 45 tool results the CLI prints from toolUseResult: patches with only removed or only added lines, line numbers past 99, a long new file.
    big = "".join("row %d\n" % i for i in range(1, 121))
    ed = lambda old, new, patch: {"filePath": "/w/a.txt", "oldString": old, "newString": new, "originalFile": "", "structuredPatch": patch, "userModified": False, "replaceAll": False}  # noqa: E731
    rm = {"filePath": "/w/a.txt", "structuredPatch": [{"oldStart": 3, "oldLines": 2, "newStart": 3, "newLines": 0, "lines": ["-gone one", "-gone two"]}]}
    add = {"filePath": "/w/a.txt", "structuredPatch": [{"oldStart": 5, "oldLines": 0, "newStart": 5, "newLines": 2, "lines": ["+new one", "+new two"]}]}
    far = {"filePath": "/w/a.txt", "structuredPatch": [{"oldStart": 98, "oldLines": 3, "newStart": 98, "newLines": 3, "lines": [" row 98", "-row 99", "+ROW 99", " row 100"]}]}
    calls45 = [("Edit", {"file_path": "/w/a.txt", "old_string": "gone", "new_string": ""}, "updated", ed("gone", "", rm["structuredPatch"])),
               ("Edit", {"file_path": "/w/a.txt", "old_string": "x", "new_string": "x\nnew"}, "updated", ed("x", "x\nnew", add["structuredPatch"])),
               ("Edit", {"file_path": "/w/a.txt", "old_string": "row 99", "new_string": "ROW 99"}, "updated", ed("row 99", "ROW 99", far["structuredPatch"])),
               ("Write", {"file_path": "/w/big.txt", "content": big}, "created", {"type": "create", "filePath": "/w/big.txt", "content": big, "structuredPatch": [], "originalFile": None})]
    # 46 a background shell call, a fetch of 1.5 MB and an error longer than 4 lines.
    err = "Exit code 1\n" + "\n".join("problem %d" % i for i in range(1, 8))
    calls46 = [("Bash", {"command": "sleep 100", "run_in_background": True}, "Command running in background with ID: bg1",
                {"stdout": "", "stderr": "", "interrupted": False, "isImage": False, "backgroundTaskId": "bg1"}),
               ("WebFetch", {"url": "https://example.com/big", "prompt": "p"}, "page", {"bytes": 1572864, "code": 200, "codeText": "OK", "result": "page", "durationMs": 120, "url": "https://example.com/big"}),
               ("Bash", {"command": "make check"}, err, "Error: " + err)]
    for n, calls in ((45, calls45), (46, calls46)):
        recs, prev = [u("u1", None, f"Tool results case {n}")], "u1"
        for i, (name, inp, said, tur) in enumerate(calls):
            recs += [a(f"c{i}", prev, f"mc{i}", [tool(f"tc{i}", name, inp)]),
                     u(f"d{i}", f"c{i}", [result(f"tc{i}", said, error=name == "Bash" and said == err)], toolUseResult=tur)]
            prev = f"d{i}"
        w(n, recs + [a("end", prev, "mend", [text("Results shown.")])])
    # 47-60 group lines of the default view (round 10): each case is a run of calls; "say" is a short reply between calls, None a call left without result.
    rd = lambda f: ("Read", {"file_path": "/w/" + f}, "     1→alpha", 0)  # noqa: E731
    gr = lambda p: ("Grep", {"pattern": p}, "Found 1 file\n/w/a.txt", 0)  # noqa: E731
    gl = lambda p: ("Glob", {"pattern": p}, "/w/a.txt", 0)  # noqa: E731
    sh = lambda c, out="done", bad=0: ("Bash", {"command": c}, out, bad)  # noqa: E731
    mc = lambda srv, tl: ("mcp__%s__%s" % (srv, tl), {"query": "q"}, "mcp answer", 0)  # noqa: E731
    long_err = "\n".join("failure line %d" % i for i in range(1, 9))
    groups = {47: [rd("a.txt"), rd("b.txt"), rd("c.txt")], 48: [rd("a.txt")], 49: [gr("needle"), gl("**/*.md")],
              50: [rd("a.txt"), sh("make")], 51: [gr("needle"), rd("a.txt"), sh("make")],
              52: [sh("echo one"), sh("echo two"), sh("echo three"), sh("echo four")],
              53: [rd("a.txt"), "Looking further.", gr("needle"), rd("b.txt")],
              54: [rd("a.txt"), sh("false", "Exit code 1\nbroken", 1), rd("b.txt"), ("Read", {"file_path": "/w/gone.txt"}, "File does not exist.", 1)],
              55: [rd("a.txt"), (*rd("b.txt")[:2], None, 0)], 56: [mc("alpha", "look"), mc("beta", "fetch_item")], 57: [mc("alpha", "look")],
              58: [rd("a.txt"), mc("alpha", "look"), sh("make")],
              59: [("Edit", {"file_path": "/w/a.txt", "old_string": "a", "new_string": "b"}, long_err, 1),
                   ("Write", {"file_path": "/w/b.txt", "content": "x"}, long_err, 1), ("mcp__alpha__look", {"query": "q"}, long_err, 1)],
              60: [mc("alpha", "look"), ("mcp__alpha__look", {"query": "q"}, long_err, 1)],
              61: [("Edit", {"file_path": "/w/%d.txt" % k, "old_string": "a", "new_string": "b"}, "\n".join("failure line %d" % i for i in range(1, k + 1)), 1)
                   for k in (10, 11, 12, 20, 40)]}
    for n, calls in groups.items():
        recs, prev, last = [u("u1", None, f"Group case {n}")], "u1", None
        for i, call in enumerate(calls):
            if isinstance(call, str):
                recs.append(a(f"s{i}", prev, f"ms{i}", [text(call)]))
                prev = f"s{i}"
                continue
            name, inp, said, bad = call
            recs.append(a(f"c{i}", prev, f"mc{i}", [tool(f"tc{i}", name, inp)]))
            prev = last = f"c{i}"
            if said is not None:
                recs.append(u(f"d{i}", f"c{i}", [result(f"tc{i}", said, error=bool(bad))]))
                prev = last = f"d{i}"
        w(n, recs + ([] if calls[-1][2:3] == (None,) else [a("end", last, "mend", [text("Group shown.")])]))


if __name__ == "__main__":
    main()
