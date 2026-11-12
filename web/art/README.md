# Character art

Every character-side sprite is a plain text file here. Edit one in any text editor, then:

    python3 tools/art_build.py      # bundles web/art/*.txt into web/src/art.generated.js (the page reads that)
    node tools/art_lint.mjs         # checks the files
    node tools/art_sheet.mjs art.png  # every sprite in one PNG; or python3 tools/dev_static.py, then /gallery.html

`node --test web/tests/` fails while art.generated.js is stale, and on any pixel change (refresh on purpose:
`UPDATE_PIXELS=1 node --test web/tests/pixels.test.js`). The main server does not serve .html, so use dev_static.py.

## Format

    # comment (whole lines only)
    size 16x8                   every frame is exactly 16 wide, 8 tall (optional)
    fit 16x5                    every frame is 16 wide and at most 5 tall (optional)

    [palette]                   letter, colour, optional @role, note
    o  #d97757  @body  body
    k  #231815         eyes

    [colours]                   named colour sets: one per line, role=colour
    teal  body=#55b3a0 shade=#368674

    [frame stand]               a named frame: one text row per pixel row
    ..oooooooooood..
    ..ookooooookod..

- `.` is a transparent pixel; every other character is a palette letter (one character, not `#`, `[` or `.`).
- A file without a `[palette]` section paints with `palette.txt`. A file with one uses only its own.
- A `@role` letter takes its colour from the colour set being drawn (body colour, fish colour, ore colour);
  the colour on its palette line is the default. Every colour set must give every role its frames use.
- Order matters where noted: hats and body colours are handed out to sessions by position, so add at the end.

## Files
`palette.txt` shared letters · `body.txt` body frames and the 8 body colours · `legs.txt` walk legs ·
`hats.txt` hats (bottom-aligned in a 16x5 slot above the body) · `miner.txt` pickaxe drawn over the character ·
`rock.txt` ore boulder · `fish.txt` fish and its 4 colours · `rod.txt` rod colours, float, reel and "!".
`props.txt` stump for a long wait, pull request pennant, the lens, paper and crate subagent minis hold, and the rain umbrella (canopy in the body colour).
Which session state picks a pose, tool or prop is in `web/src/activity.js`; `TOOLS` and `PROPS` in `web/src/sprites.js` name the frames.
Which frames make each app sheet (pose order, miner frames) is in `POSES` and `MINER` in `web/src/sprites.js`.
