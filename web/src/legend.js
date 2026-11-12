// @ts-check
// Legend page: every garden signal drawn by the app's own sprite, backdrop and list code beside its meaning and rule; ROWS is the one table the truth test checks.
import { ART, BODIES, HN, MUTE, PROPS, ROD, COL, TOOLS, miniSheet, minerSheet, poseSheet, propSheet, rockSheet } from './sprites.js';
import { FRESH_MIN, NAP_MIN, SIT_MIN, STALE_MIN } from './activity.js';
import { COMET_PRS, GAP, IDLE_MIN, MAX_BLOOMS, MAX_BOATS, MAX_EGGS, MAX_NOTES, ORE_STEPS, WEEK } from './world_data.js';
import { leafFall, migration, moonFull, moonPhase, puddleLeft, rainbow, smokeCount, STARS, VANE_REST, windLean } from './world_time.js';
import { BY_FIRE, CROWD, FIRE, fireFace, fireLit, MAX_STAND, MINE_SPOTS, mineMoreText, SHORT, shortTitle, SPOTS, TINY } from './garden_layout.js';
import { bareLabel, chipsHtml, FISH, isSnow, isWet, LABEL, nameOf, pageTitle, setupHint, setupNotes, waitingNews, wxName } from './logic.js';
import { cliMissingText, ENDED, exitText, modeText } from './feed.js';
import { FOLD_MIN, groupWords } from './transcript_view.js';
import { ORES } from './gallery.js';
import { esc } from './util.js';

/** @typedef {{ text: string, parts: string[], values: unknown[] }} Rule */
/** @typedef {{ id: string, group: string, name: string, meaning: string, rule: Rule, uses: string[], draw: Record<string, any>, shows?: Record<string, string[]> }} Row */

/** Plain words for a number: 250 thousand, 1 million, 3.5; whole numbers stay as they are. @param {number} n */
export const say = n => n >= 1e6 && n % 1e5 === 0 ? n / 1e6 + ' million' : n >= 1e4 && n % 1e3 === 0 ? n / 1e3 + ' thousand' : String(n);
/** Rule text: the static parts hold no digits, every number arrives as a value taken from the code. @param {TemplateStringsArray} s @param {...unknown} v @returns {Rule} */
export const rule = (s, ...v) => ({ text: s.reduce((a, p, i) => a + p + (i < v.length ? (typeof v[i] === 'number' ? say(/** @type {number} */ (v[i])) : String(v[i])) : ''), ''), parts: [...s], values: v });
/** Words joined as "a, b and c". @param {Array<string | number>} a */
const and = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

/**
 * Rules the code keeps in a module without exporting them: each is checked against the source by the truth test, so a change there fails until the legend follows.
 * @type {Record<string, { file: string, re: RegExp, value: number, read?: 'len' }>}
 */
export const QUOTED = {
  FEW: { file: 'web/src/lists.js', re: /const FEW = (\d+);/, value: 12 },
  CAP: { file: 'web/src/lists.js', re: /const CAP = (\d+);/, value: 30 },
  MAX_MINIS: { file: 'web/src/actors.js', re: /subs\.slice\(0, (\d+)\)\.map/, value: 4 },
  MINERS: { file: 'web/src/actors.js', re: /const MSLOTS = (\[[^;]+\]);/, value: 5, read: 'len' },
  HOUSES: { file: 'web/src/actors.js', re: /(\[\[\d+, \d+\](?:, \[\d+, \d+\])*\])\.forEach\(\(\[w, h\], i\) => \{\n\s+let z/, value: 3, read: 'len' },
  COMET_CLOUD: { file: 'web/src/backdrop.js', re: /cometOn\(b\.world\.prs, sa0, wx\.cloud < (\d+)/, value: 70 },
  MAX_TERMS: { file: 'desk/terms.py', re: /^MAX_TERMS = (\d+)$/m, value: 6 },
};
const Q = /** @type {Record<string, number>} */ (Object.fromEntries(Object.entries(QUOTED).map(([k, v]) => [k, v.value])));

// Thresholds read back from the code's own functions rather than copied.
/** First input in [a, b] (step 1) where f gives something other than f(a), each change in order. @param {(x: number) => unknown} f @param {number} a @param {number} b */
export const edges = (f, a, b) => { const out = []; let was = f(a); for (let x = a + 1; x <= b; x++) { const v = f(x); if (v !== was) { out.push(x); was = v; } } return out; };
const SMOKE = edges(t => smokeCount(t), -30, 50);  // °C where one chimney fewer smokes
const WIND = edges(s => windLean(s, 90), 0, 120);  // km/h across the screen for one, then two steps of lean
const RAINBOW = edges(m => rainbow(m, 1, false, 0) > 0, 0, 600)[0];  // minutes a rainbow can last after rain
const PUDDLE = edges(m => puddleLeft(m, false, false) > 0, 0, 600)[0];  // minutes puddles take to dry
const DAY = 864e5, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Calendar days of a common year where f(month, day) holds, as "d Mon" of the first and last. @param {(m: number, d: number) => boolean} f */
function span(f) {
  const days = []; for (let t = Date.UTC(2001, 0, 1); t < Date.UTC(2002, 0, 1); t += DAY) { const d = new Date(t); if (f(d.getUTCMonth() + 1, d.getUTCDate())) days.push(d); }
  const fm = (/** @type {Date} */ d) => d.getUTCDate() + ' ' + MON[d.getUTCMonth()];
  return days.length ? [fm(days[0]), fm(days[days.length - 1])] : ['', ''];
}
const LEAVES = span((m, d) => leafFall(m, d) > 0), AUTUMN = span((m, d) => migration(m, d) > 0), SPRING = span((m, d) => migration(m, d) < 0);
const FIRE_AT = ['dawn', 'day', 'dusk', 'night'].filter(p => fireLit(p, false));
const WET = [...new Set([...Array(100).keys()].filter(c => isWet(c) || isSnow(c)).map(c => wxName(c).toLowerCase()))];  // names of every falling weather code
const LOOKS = HN.length * BODIES.length;
const FULL_DAYS = (() => { let n = 0; for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2026, 0, 30); t += 36e5) if (moonFull(moonPhase(new Date(t))) > 0) n++; return n / 48; })();  // days either side of full moon that count as a full-moon night
/** Noon of the day within the next lunar cycle closest to full moon. */
export const nextFull = () => { let best = new Date(), v = -1; for (let i = 0; i < 31; i++) { const d = new Date(Date.now() + i * 864e5); const f = moonFull(moonPhase(d)); if (f > v) { v = f; best = d; } } return best; };

export const GROUPS = [['chars', 'Characters'], ['miners', 'Miners'], ['day', 'Scenery from your day'], ['sky', 'Sky and weather'], ['town', 'Town'], ['lists', 'Lists and sidebar']];

/** Every signal: group, name, one-sentence meaning, the exact rule, the code it follows (module.export) and how to draw it. @type {Row[]} */
export const ROWS = [
  { id: 'waiting', group: 'chars', name: 'A character', meaning: 'A session waits for your answer.', uses: ['garden_layout.MAX_STAND', 'activity.waitLabel', 'activity.waitedMin'],
    rule: rule`One per waiting session, up to ${MAX_STAND}, newest first. Hover or focus it for the title, your latest request, its last reply and how long it has waited. Click to open it.`,
    draw: { kind: 'agent', hat: HN[0], c: 0, tag: 'Fix login redirect', say: true } },
  { id: 'ask', group: 'chars', name: '"?" bubble', meaning: 'It has a question or finished its turn.', uses: [],
    rule: rule`Every waiting character carries one, still. It shrinks a little once the character sits down and becomes small and dim under a blanket, so the newest waits stand out.`, draw: { kind: 'agent', hat: HN[1], c: 1 } },
  { id: 'fresh', group: 'chars', name: 'Yellow "?" and a ring', meaning: 'It just started waiting.', uses: ['activity.FRESH_MIN', 'activity.freshOf'],
    rule: rule`For the first ${FRESH_MIN} minutes of a wait the bubble is yellow. A session that starts waiting now gets one soft ring at its feet as it arrives; the ring plays once.`,
    draw: { kind: 'agent', hat: HN[9], c: 6, fresh: true } },
  { id: 'err', group: 'chars', name: 'Red "!" bubble', meaning: 'Its last step failed.', uses: ['activity.troubled'],
    rule: rule`Shown instead of "?" while it waits and its newest tool result was an error. The only red signal in the garden; it stays bright even on a day-old wait.`, draw: { kind: 'agent', hat: HN[2], c: 2, err: true } },
  { id: 'looks', group: 'chars', name: 'Hats and colours', meaning: 'Who is who: each session keeps its own look.', uses: [],
    rule: rule`${HN.length} hats and ${BODIES.length} body colours make ${LOOKS} looks. No two active sessions wear the same one; the list row and sidebar use it too. Kept in this browser only.`,
    draw: { kind: 'looks' }, shows: { hats: HN, bodies: BODIES.map(b => b[2]) } },
  { id: 'pennant', group: 'chars', name: 'Pennant', meaning: 'It opened a pull request.', uses: ['activity.hasPr'],
    rule: rule`A small still pennant in its own body colour, held when the server counts a pull request for it or when its last words name one.`, draw: { kind: 'agent', hat: HN[3], c: 3, flag: true }, shows: { frames: ['flag-a'] } },
  { id: 'sit', group: 'chars', name: 'Sitting on a stump', meaning: 'It has waited a while.', uses: ['activity.SIT_MIN', 'activity.restOf'],
    rule: rule`After ${SIT_MIN} minutes of waiting.`, draw: { kind: 'agent', hat: HN[4], c: 4, rest: 'sit' }, shows: { rest: ['sit'], frames: ['stump'] } },
  { id: 'nap', group: 'chars', name: 'Napping', meaning: 'It has waited a long time.', uses: ['activity.NAP_MIN', 'activity.restOf'],
    rule: rule`After ${NAP_MIN} minutes of waiting its eyes shut.`, draw: { kind: 'agent', hat: HN[5], c: 5, rest: 'nap' }, shows: { rest: ['nap'] } },
  { id: 'blanket', group: 'chars', name: 'Under a blanket', meaning: 'It has waited a day or more.', uses: ['activity.STALE_MIN', 'activity.staleOf'],
    rule: rule`After ${STALE_MIN / 60} hours of waiting it naps under a grey-blue blanket and recedes: its body colour moves ${Math.round(MUTE * 100)} percent of the way to a slate grey, keeping its hue so it is still recognisably its own, the hat keeps its colour, it stops bobbing, and its bubble and tag dim (shown here at full strength so the sample stays readable; the garden dims it).`,
    draw: { kind: 'agent', hat: HN[8], c: 3, rest: 'nap', blanket: true, stale: true, tag: 'Tidy README' }, shows: { frames: ['blanket'], rest: ['nap'] } },
  { id: 'umbrella', group: 'chars', name: 'Umbrella', meaning: 'It is raining or snowing in the city.', uses: [],
    rule: rule`Waiting characters hold one in their body colour while the weather is ${and(WET)}. Anglers and miners do not.`,
    draw: { kind: 'agent', hat: HN[6], c: 6, umb: true }, shows: { frames: ['umbrella'] } },
  { id: 'fishing', group: 'chars', name: 'Fishing', meaning: 'The session is about Airflow.', uses: ['logic.isAirflow'],
    rule: rule`A title or text about Airflow, DAGs, backfills, the scheduler or task instances takes one of the ${FISH.length} pond spots and fishes. A catch plays now and then.`,
    draw: { kind: 'fish', hat: HN[7], c: 7 } },
  { id: 'team', group: 'chars', name: 'Team patch', meaning: 'These sessions work on the same project.', uses: ['garden_layout.matesOf', 'garden_layout.pull', 'garden_layout.PULL'],
    rule: rule`Hover or focus a character: a faint light shows under its project-mates. Newcomers stand near their project, nearer still on the same branch.`,
    draw: { kind: 'scene', job: 'team' } },
  { id: 'tags', group: 'chars', name: 'Name tags and leader lines', meaning: 'The title of each waiting session.', uses: ['garden_layout.CROWD', 'garden_layout.SHORT', 'garden_layout.shortTitle', 'garden_layout.placeTags', 'garden_layout.candidates', 'garden_layout.planSpots', 'garden_layout.bestPlan', 'garden_layout.matesNear', 'garden_layout.TINY', 'garden_layout.TAG_RANK', 'garden_layout.tagOrder'],
    rule: rule`Up to ${CROWD} characters show two-line tags. In a bigger crowd tags shrink to ${SHORT} characters of the most telling words. A tag with no room below moves beside the body or above the bubble with a thin leader line, then as a last resort is cut to ${TINY} px with an ellipsis, or hides until hover. Right-to-left titles read right to left. When the crowd shrinks, characters walk calmly, one at a time, to spots where more tags stay readable. When the meadow is full, tags are placed in wait order, fresh first and day-old last, so a tag that hides until hover belongs to the least urgent wait.`,
    draw: { kind: 'tags' } },
  { id: 'sign', group: 'chars', name: '"+N" on the sign', meaning: 'More sessions need you than the garden shows.', uses: ['garden_layout.MAX_STAND'],
    rule: rule`The sign counts every session that needs you. Past ${MAX_STAND} characters, or with no free spot, the rest count as +N.`, draw: { kind: 'sign' } },
  { id: 'quietnote', group: 'chars', name: 'The quiet note', meaning: 'Nobody waits, or the setup needs a fix.', uses: ['logic.setupHint'],
    rule: rule`With nobody waiting the garden says "Nobody needs you. Enjoy the garden." When the app cannot find its data or the CLI it says what is wrong instead, for example: "${setupHint({ setup: { dataDir: 'missing' } }).replace(/`/g, '')}"`, draw: { kind: 'none' } },
  { id: 'leave', group: 'chars', name: '"♥" and "…" while leaving', meaning: 'A character walks away.', uses: [],
    rule: rule`"♥" after you answered it, "…" when its session started working or no longer waits. It walks to the mine when it starts working.`, draw: { kind: 'bye' } },

  { id: 'pick', group: 'miners', name: 'Pickaxe', meaning: 'The session is working.', uses: ['garden_layout.MINE_SPOTS'],
    rule: rule`Up to ${MINE_SPOTS} working sessions dig at the mine (who gets a spot: see the mine's "+N"). A character walks there when its session starts work and back when it needs you.`,
    draw: { kind: 'miner', hat: HN[0], c: 1, tool: 'pick' }, shows: { tools: ['pick'] } },
  { id: 'pan', group: 'miners', name: 'Gold pan', meaning: 'It runs tests or checks.', uses: ['activity.toolOf'],
    rule: rule`Tests, lint or type checks, by its newest tool or by what it last said.`, draw: { kind: 'miner', hat: HN[2], c: 3, tool: 'pan' }, shows: { tools: ['pan'] } },
  { id: 'hammer', group: 'miners', name: 'Mallet', meaning: 'It builds or edits files.', uses: ['activity.toolOf'],
    rule: rule`File edits, builds, installs, bundling and deploys.`, draw: { kind: 'miner', hat: HN[4], c: 5, tool: 'hammer' }, shows: { tools: ['hammer'] } },
  { id: 'lantern', group: 'miners', name: 'Mine lantern', meaning: 'At least one session is working.', uses: ['world_data.lanternLit'],
    rule: rule`The lantern by the mine mouth burns, and glows after dark, while any session works; it goes dark when none does. Left: nothing at work; right: a session at work.`, draw: { kind: 'scene', job: 'lantern' } },
  { id: 'minemore', group: 'miners', name: 'Mine "+N"', meaning: 'More sessions work than the mine has room for.', uses: ['garden_layout.MINE_SPOTS', 'garden_layout.pickMiners', 'garden_layout.mineMoreText', 'logic.workingOverflow'],
    rule: rule`The mine draws at most ${MINE_SPOTS} miners. A drawn miner keeps its spot while it works; free spots go first to sessions with running subagents, then to the most recently active. The plaque under the door counts the rest; hover it for "${mineMoreText(MINE_SPOTS + 3, MINE_SPOTS)}".`, draw: { kind: 'scene', job: 'mine', over: 'minemore' } },
  { id: 'notes', group: 'miners', name: 'Notes on the mine door', meaning: 'Sessions out of step: a terminal behind, open in two places, or diverged copies.', uses: ['world_data.MAX_NOTES', 'world_data.syncNotes', 'world_art.pinNotes'],
    rule: rule`One paper note per such session on the mine's right door post, at most ${MAX_NOTES}.`, draw: { kind: 'scene', job: 'notes' } },
  { id: 'rock', group: 'miners', name: 'Ore boulder', meaning: 'The rock a miner works on.', uses: [],
    rule: rule`Gold or ice-blue ore, fixed for each session.`, draw: { kind: 'rocks' }, shows: { frames: ['rock'] } },
  { id: 'minis', group: 'miners', name: 'Minis', meaning: 'Subagents the session is running.', uses: [],
    rule: rule`Each running subagent stands beside its session as a half-size character, up to ${Q.MAX_MINIS}; more show as +N. Hover one for its task.`,
    draw: { kind: 'minis' } },
  { id: 'props', group: 'miners', name: 'What a mini holds', meaning: 'What the subagent does.', uses: ['activity.propOf'],
    rule: rule`A lens when it looks for something (search, read, review, check), paper when it writes (draft, document, summarise, plan), a crate for anything else.`,
    draw: { kind: 'props' }, shows: { props: PROPS } },

  { id: 'ore', group: 'day', name: 'Ore on the cart', meaning: 'How many tokens you used today.', uses: ['world_data.ORE_STEPS', 'world_data.oreStep', 'world_data.dayTotals', 'world_data.worldNow', 'world_art.oreHeap'],
    rule: rule`One step each at ${and(ORE_STEPS.map(say))} tokens. Clears at midnight.`, draw: { kind: 'scene', job: 'ore' } },
  { id: 'blooms', group: 'day', name: 'Sunflowers by the fence', meaning: 'Pull requests opened today.', uses: ['world_data.MAX_BLOOMS', 'world_data.blooms', 'world_art.sunflowers'],
    rule: rule`One per pull request, at most ${MAX_BLOOMS}. Heads follow the sun and droop at night. Clears at midnight.`, draw: { kind: 'scene', job: 'blooms' } },
  { id: 'boats', group: 'day', name: 'Paper boats', meaning: 'Automated runs today.', uses: ['world_data.MAX_BOATS', 'world_data.boats', 'world_art.paintBoats'],
    rule: rule`One per run started by a hook or script, at most ${MAX_BOATS} on the stream at once.`, draw: { kind: 'scene', job: 'boats' } },
  { id: 'comet', group: 'day', name: 'Comet', meaning: 'A big day: many pull requests.', uses: ['world_data.COMET_PRS', 'world_data.cometOn', 'world_art.comet'],
    rule: rule`On a night after ${COMET_PRS} or more pull requests, when cloud cover is under ${Q.COMET_CLOUD} percent and nothing falls.`, draw: { kind: 'scene', job: 'comet' } },
  { id: 'week', group: 'day', name: 'Week constellation', meaning: 'Which of the last days had a pull request.', uses: ['world_data.WEEK', 'world_data.weekPrs'],
    rule: rule`Each of the last ${WEEK} days with a pull request lights one star of a ${WEEK}-star dipper, oldest day at the handle end, today at the pointer; days without one are faint dots. Nothing until one day has a pull request. Shows whenever stars are out, away from the moon.`,
    draw: { kind: 'scene', job: 'week' } },
  { id: 'nest', group: 'day', name: 'Nest on the cliff', meaning: 'How many days in a row you have worked with a session.', uses: ['world_data.MAX_EGGS', 'world_data.streakDays', 'world_data.setStreak', 'world_data.eggs', 'world_art.nest'],
    rule: rule`One egg per day of the day streak the Stats panel shows, counted back from today (from yesterday while today has none yet), up to ${MAX_EGGS} eggs. Until the statistics answer it counts days on which a listed session was last active. A missed day empties it; no streak, no nest. It never moves.`,
    draw: { kind: 'scene', job: 'nest' } },
  { id: 'star', group: 'day', name: 'Shooting star', meaning: 'A session just finished its turn.', uses: ['world_data.GAP', 'world_data.finished', 'world_data.momentKind'],
    rule: rule`At night under a clear sky. At most one every ${GAP / 1000} seconds; none when the system asks for reduced motion.`, draw: { kind: 'scene', job: 'star' }, shows: { moments: ['star'] } },
  { id: 'bird', group: 'day', name: 'A bird leaves the big tree', meaning: 'A session just finished its turn.', uses: ['world_data.momentKind'],
    rule: rule`By day without rain, snow or fog. Same limit of one every ${GAP / 1000} seconds.`, draw: { kind: 'scene', job: 'bird' }, shows: { moments: ['bird'] } },

  { id: 'sun', group: 'sky', name: 'Sun', meaning: 'The real time of day in the city.', uses: ['world_time.sunTimes'],
    rule: rule`Rises and sets at the city's real sunrise and sunset. Dawn and dusk tint the sky.`, draw: { kind: 'scene', job: 'sun' } },
  { id: 'moon', group: 'sky', name: 'Moon', meaning: "Tonight's real moon phase.", uses: ['world_time.moonPhase', 'world_time.moonLit', 'world_time.moonPx'],
    rule: rule`Crosses the night sky in its true phase and lights the pond.`, draw: { kind: 'scene', job: 'moon' } },
  { id: 'fullmoon', group: 'sky', name: 'Full-moon night', meaning: 'The moon is full or nearly full.', uses: ['world_time.moonFull'],
    rule: rule`Within ${FULL_DAYS} days of full moon, while the moon is up, the land is a little brighter and the moon has a wider faint halo. Left: an ordinary night; right: a full-moon night.`,
    draw: { kind: 'scene', job: 'fullmoon' } },
  { id: 'stars', group: 'sky', name: 'Stars', meaning: 'The real night sky over the city.', uses: ['world_time.STARS', 'world_time.skyStars', 'world_time.altAz', 'world_time.lst'],
    rule: rule`${STARS.length} bright stars sit where they really are, looking south; fainter ones are scattered. Clouds thin them out.`, draw: { kind: 'scene', job: 'stars' } },
  { id: 'rain', group: 'sky', name: 'Rain, snow and puddles', meaning: 'The weather in the city now.', uses: ['world_time.puddleLeft', 'world_time.rainEnded'],
    rule: rule`Rain or snow falls when it does there. Puddles stay while it rains and dry over ${PUDDLE} minutes after it stops.`, draw: { kind: 'scene', job: 'rain' } },
  { id: 'rainbow', group: 'sky', name: 'Rainbow', meaning: 'It rained a short while ago.', uses: ['world_time.rainbow', 'scene_extras.drawRainbow'],
    rule: rule`Can show for up to ${RAINBOW} minutes after rain, fading, when the sun is up and the sky is not overcast.`, draw: { kind: 'scene', job: 'rainbow' } },
  { id: 'leaves', group: 'sky', name: 'Falling leaves', meaning: 'Autumn.', uses: ['world_time.leafFall', 'scene_extras.season', 'scene_extras.fallenLeaves', 'scene_extras.spawnExtras', 'scene_extras.paintExtras'],
    rule: rule`From ${LEAVES[0]} to ${LEAVES[1]} leaves drift from the big tree and gather at its foot, most in the middle of that time.`, draw: { kind: 'scene', job: 'leaves' } },
  { id: 'flock', group: 'sky', name: 'Migrating flocks', meaning: 'Birds on their way, in season.', uses: ['world_time.migration', 'scene_extras.spawnExtras'],
    rule: rule`Now and then in daylight and dry weather: ${AUTUMN[0]} to ${AUTUMN[1]} flying right, ${SPRING[0]} to ${SPRING[1]} flying left.`, draw: { kind: 'scene', job: 'flock' } },
  { id: 'smoke', group: 'sky', name: 'Chimney smoke', meaning: 'How cold it is outside.', uses: ['world_time.smokeCount'],
    rule: rule`All three chimneys smoke under ${SMOKE[0]} °C, two under ${SMOKE[1]} °C, one under ${SMOKE[2]} °C, none when warmer.`, draw: { kind: 'scene', job: 'smoke' } },
  { id: 'wind', group: 'sky', name: 'Wind', meaning: 'Wind across the city.', uses: ['world_time.windLean', 'world_time.smokeDrift'],
    rule: rule`Smoke and rain lean with it: one step from ${WIND[0]} km/h across the screen, two from ${WIND[1]} km/h. Snow falls straight.`, draw: { kind: 'scene', job: 'wind' } },
  { id: 'vane', group: 'sky', name: 'Weather vane', meaning: 'Where the wind comes from.', uses: ['world_time.vanePose', 'world_time.VANE_REST', 'world_art.weatherVane'],
    rule: rule`On the red roof, its gold head points into the real wind as you look south: east is on the left, a head toward you is wind from the south, a short tail is wind from the north. It is still between weather updates and shows the sea breeze from the west (${VANE_REST}°) until the first answer.`,
    draw: { kind: 'scene', job: 'vane' } },
  { id: 'fire', group: 'sky', name: 'Camp fire', meaning: 'Evening has come.', uses: ['garden_layout.fireLit', 'garden_layout.FIRE', 'garden_layout.BY_FIRE', 'garden_layout.fireFace'],
    rule: rule`Burns at ${and(FIRE_AT)} in dry weather. Characters on the ${BY_FIRE.length} spots beside it sit and face it.`,
    draw: { kind: 'scene', job: 'fire' }, shows: { frames: ['fire-a', 'fire-b'] } },

  { id: 'home', group: 'town', name: 'Sent home', meaning: 'You put the session aside for now.', uses: [],
    rule: rule`"Send home" in its sidebar walks it into a house. It comes back when it next waits for you, or at once with "Wake up".`, draw: { kind: 'scene', job: 'town' } },
  { id: 'cat', group: 'town', name: 'Cat on the fence', meaning: 'The garden is truly idle.', uses: ['world_data.catNaps', 'world_data.IDLE_MIN', 'world_art.catNap'],
    rule: rule`A cat sleeps on the town fence while no session works and every waiting session has waited ${IDLE_MIN} minutes or more. It is gone as soon as a session starts working or a new wait begins. It never moves.`, draw: { kind: 'scene', job: 'cat' } },
  { id: 'snore', group: 'town', name: 'Chimney "z"', meaning: 'Sessions asleep in town.', uses: [],
    rule: rule`One "z" per sleeping session, up to ${Q.HOUSES} houses. Windows glow after dark.`, draw: { kind: 'scene', job: 'town', over: 'z' } },

  { id: 'chip-err', group: 'lists', name: 'Red dot', meaning: 'Its newest tool result failed.', uses: ['logic.badges', 'logic.chipsHtml'], rule: rule`After the title in Working and Resting.`, draw: { kind: 'chips', s: { lastError: true } }, shows: { badges: ['err'] } },
  { id: 'chip-pr', group: 'lists', name: '"PR" badge', meaning: 'It opened pull requests.', uses: ['logic.badges'], rule: rule`"PR" for one, "PR" and the count for more.`, draw: { kind: 'chips', s: { prOpened: 2 } }, shows: { badges: ['pr'] } },
  { id: 'chip-auto', group: 'lists', name: '"auto" badge', meaning: 'A hook or script started it, not you.', uses: ['logic.isAuto'], rule: rule`Quick reply is off for these; use the Terminal tab.`, draw: { kind: 'chips', s: { automated: true } }, shows: { badges: ['auto'] } },
  { id: 'chip-also', group: 'lists', name: '"open twice" badge', meaning: 'Also open in the desktop app or another terminal.', uses: [], rule: rule`Type in one place per session.`, draw: { kind: 'chips', s: { also: ['desktop app'] } }, shows: { badges: ['also'] } },
  { id: 'chip-behind', group: 'lists', name: '"behind" badge', meaning: 'Newer messages were written elsewhere.', uses: [], rule: rule`Open it and press Reload terminal.`, draw: { kind: 'chips', s: { behind: true } }, shows: { badges: ['behind'] } },
  { id: 'chip-diverged', group: 'lists', name: '"diverged" badge', meaning: 'Its copies differ.', uses: ['logic.diverged'], rule: rule`Another program wrote a branch that the page terminal leaves out.`, draw: { kind: 'chips', s: { consistency: 'diverged' } }, shows: { badges: ['diverged'] } },
  { id: 'fold', group: 'lists', name: '"N automated runs"', meaning: 'Runs started by hooks or scripts, folded away.', uses: ['logic.tally'],
    rule: rule`One line at the end of ${LABEL.resting}. Click to open; it stays open in this browser. Search always finds them.`, draw: { kind: 'fold', text: '▸ 7 automated runs' } },
  { id: 'more', group: 'lists', name: '"Show N more"', meaning: 'Older sessions in a long list.', uses: ['logic.shownRows', 'logic.workingCount'],
    rule: rule`${LABEL.running} shows the newest ${Q.CAP}, ${LABEL.resting} the newest ${Q.FEW}; this line unfolds the rest in place, newest first, and the list stays open while the page is open. The ${LABEL.running} heading counts every working session, the number the mine's miners come from. Search always looks through all.`, draw: { kind: 'fold', text: '▾ Show 23 more' } },
  { id: 'bare', group: 'lists', name: 'Project and branch as the name', meaning: 'The session has no real title yet.', uses: ['logic.bareTitle', 'logic.nameOf', 'logic.bareLabel'],
    rule: rule`An empty title, "(session)" or the id prefix the resume picker shows is replaced by project and branch, with the id prefix below; the garden tag and hover use the same name.`,
    draw: { kind: 'bare', s: { id: '3f2a9c1e-0000', title: '(session)', project: 'billing-api', branch: 'fix/ws-leak' } } },
  { id: 'quiet', group: 'lists', name: 'Tool calls without a result line', meaning: 'The Transcript tab prints what the CLI prints.', uses: ['transcript_view.quietResult', 'transcript_view.silentTool'],
    rule: rule`A successful call whose result the CLI does not print shows no result line, shell commands included; click the line, or press Enter on it, to read the result in place, and again to hide it. Lines you open stay open while the sidebar is. A call the CLI prints nothing for is left out; a failed call always shows its error.`, draw: { kind: 'none' } },
  { id: 'groups', group: 'lists', name: 'Grouped calls', meaning: 'The CLI\'s one-line summary of reads, searches and shell commands.', uses: ['transcript_view.groupKind', 'transcript_view.groupWords', 'transcript_view.groupEnd', 'transcript_view.groupHtml'],
    rule: rule`Consecutive reads, searches, shell commands and connector calls read as one line in the CLI's words, such as "${groupWords(['bash', 'search', 'search'])}". Click it, or press Enter on it, to see each call with its result. A failed call shows its error under the line. Runs of ${FOLD_MIN} or more lines of calls fold into "N tool calls".`, draw: { kind: 'fold', text: groupWords(['read', 'read']) + ' ▸' } },
  { id: 'details', group: 'lists', name: '"Details" switch', meaning: 'Every tool call and its result at once, like ctrl+o in the CLI.', uses: [],
    rule: rule`In the Transcript tab's header. On, nothing is grouped and every call shows its result; off is the CLI's default view. Off at first; this browser remembers it.`, draw: { kind: 'fold', text: 'Details' } },
  { id: 'ends', group: 'lists', name: 'Terminal end texts', meaning: 'Why the Terminal tab stopped.', uses: ['feed.exitText', 'feed.ENDED'],
    rule: rule`"Terminal ended." when the terminal was closed or stopped (exit codes ${and(ENDED)}); "Terminal host stopped." when the terminal host is gone; "CLI ended (code N)." when the CLI itself exited. Opening the Terminal tab again starts a new one.`,
    draw: { kind: 'ends' }, shows: { ends: [exitText(-1), ...ENDED.map(exitText), exitText(0)] } },
  { id: 'pills', group: 'lists', name: 'Status pills', meaning: 'Whether the page hears the server.', uses: [],
    rule: rule`"live": changes arrive at once. "live · polling": the change feed dropped, it asks every few seconds. "offline · retrying": the server is not answering; the page keeps trying. "demo · example data": opened from another address. "updated · reload": the app changed on disk; click to reload.`,
    draw: { kind: 'pills' }, shows: { modes: [modeText(true, true), modeText(false, true), modeText(false, false), modeText(true, null)] } },
  { id: 'nocli', group: 'lists', name: 'CLI missing', meaning: 'The app cannot run the claude command.', uses: ['feed.cliMissingText', 'logic.setupNotes'],
    rule: rule`The Terminal tab says "${cliMissingText('').replace(/`/g, '')}" When sessions are listed, a line under the search box says "${setupNotes({ setup: { cli: 'missing' } }, 1).cliOff.replace(/`/g, '')}"`, draw: { kind: 'none' } },
  { id: 'title', group: 'lists', name: 'Tab title and announcements', meaning: 'Sessions waiting for you, outside the garden.', uses: ['logic.pageTitle', 'logic.waitingNews'],
    rule: rule`The browser tab reads "${pageTitle(1).replace(/\d+/, 'N')}" while N sessions need you. When a session starts waiting, screen readers hear "${waitingNews(new Set(), [/** @type {any} */ ({ id: 'x', status: 'waiting', title: 'Fix login redirect' })]).text}" once.`, draw: { kind: 'none' } },
  { id: 'terms', group: 'lists', name: 'Terminal tab', meaning: 'The real CLI for this session.', uses: [],
    rule: rule`Up to ${Q.MAX_TERMS} page terminals run at once. Closing the sidebar keeps them running. Every key goes to the CLI except the few that move focus out (see Keys).`, draw: { kind: 'none' } },
];

/** Every keyboard shortcut of the page; src names the code that handles it, checked by the truth test. */
export const KEYS = [
  { codes: ['/'], keys: ['/'], where: 'Page', does: 'Jump to search.', src: { file: 'web/src/logic.js', re: /k\.key === '\/'\) return 'search'/ } },
  { codes: ['j', 'k'], keys: ['j', 'k'], where: 'Page', does: 'Move down or up the list rows.', src: { file: 'web/src/logic.js', re: /k\.key === 'j'/ } },
  { codes: ['ArrowDown', 'ArrowUp'], keys: ['↓', '↑'], where: 'On a row', does: 'Move down or up.', src: { file: 'web/src/logic.js', re: /c\.onRow && k\.key === 'ArrowDown'/ } },
  { codes: ['ArrowDown'], keys: ['↓'], where: 'Search box', does: 'Go to the first row.', src: { file: 'web/src/logic.js', re: /k\.key === 'ArrowDown' \? 'down'/ } },
  { codes: ['Escape'], keys: ['Esc'], where: 'Empty search box', does: 'Leave the box.', src: { file: 'web/src/logic.js', re: /k\.key === 'Escape' && c\.empty \? 'blur'/ } },
  { codes: ['Enter'], keys: ['Enter'], where: 'Row or character', does: 'Open the session.', src: { file: 'web/src/lists.js', re: /<button|class="row/ } },
  { codes: ['F6', 'ArrowLeft'], keys: ['F6'], alt: ['Ctrl', 'Shift', '←'], where: 'Terminal tab', does: 'Move focus out of the terminal to the sidebar tabs.', term: [{ key: 'F6' }, { key: 'ArrowLeft', ctrl: true, shift: true }], to: 'tabs', src: { file: 'web/src/terminal.js', re: /termLeave\(\{ key:e\.key/ } },
  { codes: ['F6'], keys: ['Shift', 'F6'], where: 'Terminal tab', does: 'Move focus to the sidebar footer.', term: [{ key: 'F6', shift: true }], to: 'foot', src: { file: 'web/src/terminal.js', re: /termLeave\(\{ key:e\.key/ } },
  { codes: ['F6', 'Enter'], keys: ['F6'], alt: ['Enter'], where: 'Sidebar, or the Terminal tab button', does: 'Go back into the terminal.', src: { file: 'web/src/drawer.js', re: /e\.key === 'F6' && !e\.shiftKey[^\n]*focusTerm\(\)/ } },
  { codes: [], keys: ['any other key'], where: 'Terminal tab', does: 'Goes to the CLI: approvals, Esc, Ctrl+C, slash commands.', term: [{ key: 'Escape' }, { key: 'c', ctrl: true }, { key: 'Tab' }], to: '', src: { file: 'web/src/logic.js', re: /export function termLeave/ } },
  { codes: ['Escape'], keys: ['Esc'], where: 'Sidebar', does: 'Close it (in the Terminal tab Esc goes to the CLI).', src: { file: 'web/src/main.js', re: /e\.key === 'Escape' && !e\.defaultPrevented && st\.open && st\.view !== 'term'/ } },
  { codes: ['j', 'k'], keys: ['j', 'k'], where: 'Transcript', does: 'Step through prompts and replies.', src: { file: 'web/src/drawer.js', re: /e\.key !== 'j' && e\.key !== 'k'/ } },
  { codes: ['Enter', ' '], keys: ['Enter'], alt: ['Space'], where: 'Tool or grouped line in the Transcript', does: 'Show or hide its hidden result.', src: { file: 'web/src/transcript_view.js', re: /<details class="xp"/ } },
  { codes: ['c'], keys: ['c'], where: 'Transcript line', does: 'Copy the focused reply.', src: { file: 'web/src/drawer.js', re: /e\.key === 'c' && ln/ } },
  { codes: ['/'], keys: ['/'], where: 'Sidebar, Transcript tab (not while typing)', does: 'Open Find: searches the whole session, hidden results and parts not drawn yet included.', src: { file: 'web/src/drawer.js', re: /e\.key === '\/' && !e\.ctrlKey[^\n]*openFind\(\)/ } },
  { codes: ['Enter'], keys: ['Enter'], alt: ['Shift', 'Enter'], where: 'Find box', does: 'Next match (newer); Shift+Enter the previous one. Both wrap around and open the line or group that hides the match.', src: { file: 'web/src/drawer.js', re: /e\.key === 'Enter' && !e\.isComposing\) \{ e\.preventDefault\(\); stepFind/ } },
  { codes: ['Escape'], keys: ['Esc'], where: 'Find box', does: 'Close Find: marks go, lines it opened close again, focus returns.', src: { file: 'web/src/drawer.js', re: /e\.key === 'Escape'\) \{ e\.preventDefault\(\); closeFind\(\)/ } },
  { codes: ['Escape'], keys: ['Esc'], where: 'Reply box with text', does: 'Leave the box; the text stays. A second Esc closes the sidebar, and the text is still there when it opens again.', src: { file: 'web/src/drawer.js', re: /e\.key === 'Escape' && r\.value/ } },
  { codes: ['Enter'], keys: ['Enter'], where: 'Reply box', does: 'Send.', src: { file: 'web/src/drawer.js', re: /e\.key !== 'Enter' \|\| e\.shiftKey/ } },
  { codes: ['Enter'], keys: ['Shift', 'Enter'], where: 'Reply box', does: 'New line.', src: { file: 'web/src/drawer.js', re: /Shift\+Enter adds a line/ } },
  { codes: ['Tab'], keys: ['Tab'], where: 'Sidebar and Stats', does: 'Stays inside while open.', src: { file: 'web/src/drawer.js', re: /e\.key !== 'Tab'/ } },
  { codes: ['ArrowLeft', 'ArrowRight', 'Home', 'End'], keys: ['←', '→', 'Home', 'End'], where: 'Stats chart', does: 'Pick a day or hour.', src: { file: 'web/src/stats.js', re: /ArrowRight:1, ArrowLeft:-1, Home:-Infinity, End:Infinity/ } },
  { codes: ['Escape'], keys: ['Esc'], where: 'Stats', does: 'Close the panel.', src: { file: 'web/src/stats.js', re: /e\.key === 'Escape'\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); usClose\(\)/ } },
];

/** Exports of the rule modules that draw nothing a person sees on their own, with the reason; every other export must be cited by a row. */
export const NOT_SHOWN = {
  'world_data.world': 'demo preview override', 'world_data.parseWorld': 'demo preview switches',
  'world_time.ilDay': 'date helper', 'world_time.ilInstant': 'date helper',
  'scene_extras.sky': 'preview date and rain memory', 'scene_extras.sceneInstant': 'date helper',
  'garden_layout.MORE': 'spot grid', 'garden_layout.SPOTS': 'spot grid', 'garden_layout.GAP': 'spacing between bodies', 'garden_layout.tagSafe': 'placement maths',
  'world_time.fireflyTime': 'window constant, covers the whole night', 'world_time.FIREFLY_MIN': 'window constant, covers the whole night',
  'world_time.FAST_MS': 'repaint pacing, not a signal', 'world_time.SLOW_MS': 'repaint pacing, not a signal', 'world_time.repaintMs': 'repaint pacing, not a signal',
  'garden_layout.modelItem': 'placement maths', 'garden_layout.crowdHidden': 'placement maths', 'garden_layout.pickSpot': 'placement maths', 'garden_layout.hits': 'box overlap helper',
};

// ---------- page ----------

/** @param {string} tag @param {Record<string, any>} [props] @param {Array<Node | string>} [kids] */
const h = (tag, props = {}, kids = []) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
/** Markup of one garden character with the app's classes, as actors.js builds it. @param {Record<string, any>} o */
function agentHtml(o) {
  const cls = ['agent', o.err && 'err', o.rest && 'sit', o.rest === 'nap' && 'nap', o.fresh && 'fresh', o.stale && 'stale', o.mate && 'mate', o.tagMode, o.cls].filter(Boolean).join(' ');
  const seat = o.rest ? `<i class="seat" style="background-image:url(${propSheet(['stump'])})"></i>` : '';
  const flag = o.flag ? `<b class="flag" style="background-image:url(${propSheet(['flag-a'], o.c)})"></b>` : '';
  const wrap = o.blanket ? `<b class="blanket" style="background-image:url(${propSheet(['blanket'])})"></b>` : '';
  const umb = o.umb ? `<b class="umb" style="background-image:url(${propSheet(['umbrella'], o.c)})"></b>` : '';
  const tag = o.tag ? `<span class="tag"><span class="tn">${esc(o.tag)}</span><span class="ts">${esc(shortTitle(o.tag))}</span></span>` : '';
  const say = o.say ? `<span class="say"><b>${esc(o.tag)}</b><u>You: Check the callback URL after sign-in</u>Done. The redirect keeps the page you came from.<i class="wt">waiting 4 min</i></span>` : '';
  const minis = o.minis ? `<span class="minis r">${o.minis.map((/** @type {string} */ p) => `<i class="mini" style="background-image:url(${miniSheet(p, o.c)})"></i>`).join('')}${o.more ? `<b>+${o.more}</b>` : ''}</span>` : '';
  return `<span class="${cls}" style="left:${o.x ?? 50}%;top:${o.y ?? 100}%">${o.bubble === '' ? '' : `<span class="bubble" aria-hidden="true">${o.bubble || (o.err ? '!' : '?')}</span>`}<span class="gnd"></span>${seat}<span class="fig"><i class="pix" style="background-image:url(${poseSheet(o.hat, o.c, o.rest || '', o.face || '', !!o.stale)})">${flag}${umb}${wrap}</i></span>${tag}${say}${minis}</span>`;
}
/** Markup of a miner with its tool and ore boulder. @param {Record<string, any>} o */
const minerHtml = o => `<span class="agent miner${o.tool === 'pick' ? '' : ' ' + o.tool}" style="left:${o.x ?? 35}%;top:100%;--oc:${o.ore}"><span class="gnd"></span><span class="fig"><i class="rock" style="background-image:url(${rockSheet(o.ore)})"></i><span class="sprite" style="background-image:url(${minerSheet(o.hat, o.c, o.tool)})"></span></span></span>`;
/** A stage well holding garden markup. @param {string} html @param {string} [cls] */
const stage = (html, cls = '') => { const g = h('div', { className: 'lg-ground' }), d = h('div', { className: 'lg-well lg-stage ' + cls }, [g]); g.innerHTML = html; return d; };
/** Small background-image box of one sprite frame at the well's pixel size. @param {string} src @param {number} w @param {number} hh @param {number} [n] frames in the sheet */
const pix = (src, w, hh, n = 1) => h('i', { className: 'lg-pix', style: `--w:${w};--h:${hh};background-image:url(${src});background-size:${n * 100}% 100%` });

/** Drawing for one row; scene crops are filled in later by the backdrop pass. @param {Row} r @param {Map<string, HTMLElement>} wait */
function figure(r, wait) {
  const d = r.draw;
  if (d.kind === 'agent') return stage(agentHtml(d), d.tag ? 'tall' : '');
  if (d.kind === 'looks') {
    const w = h('div', { className: 'lg-well lg-grid' });
    w.append(h('div', { className: 'lg-line' }, HN.map(n => pix(poseSheet(n, 0), 16, 15, 10))), h('div', { className: 'lg-line' }, BODIES.map((_, c) => pix(poseSheet('none', c), 16, 15, 10))));
    return w;
  }
  if (d.kind === 'fish') {
    const w = stage(agentHtml({ ...d, x: 30 })), parts = h('span', { className: 'lg-rod' }, ['float', 'reel', 'bang'].map(k => rodPix(/** @type {'float' | 'reel' | 'bang'} */ (k))));
    w.append(parts); return w;
  }
  if (d.kind === 'tags') return stage(agentHtml({ hat: HN[1], c: 4, x: 20, tag: 'Speed up nightly rollup' }) + agentHtml({ hat: HN[3], c: 7, x: 58, y: 72, tag: 'ABC-1234 retry webhook delivery on 5xx', tagMode: 'tag1 tagr' }), 'wide tall');
  if (d.kind === 'sign') return stage(`<div class="sign"><b class="num">${MAX_STAND + 2}</b> need you <span class="more">+2</span></div>`, 'wide short');
  if (d.kind === 'bye') return stage(agentHtml({ hat: HN[5], c: 1, x: 28, bubble: '♥', cls: 'bye glad' }) + agentHtml({ hat: HN[6], c: 4, x: 72, bubble: '…', cls: 'bye' }), 'wide');
  if (d.kind === 'miner') return stage(minerHtml({ ...d, ore: ORES[0][1] }), 'mine');
  if (d.kind === 'rocks') { const w = h('div', { className: 'lg-well' }); w.append(...ORES.map(([, o]) => pix(rockSheet(o), 10, 8, 2))); return w; }
  if (d.kind === 'minis') return stage(agentHtml({ hat: HN[0], c: 0, x: 30, minis: ['lens', 'paper', 'crate', 'lens'].slice(0, Q.MAX_MINIS), more: 2, bubble: '' }), 'wide');
  if (d.kind === 'props') { const w = h('div', { className: 'lg-well' }); w.append(...PROPS.map((p, i) => h('span', { className: 'lg-cap' }, [pix(miniSheet(p, i + 2), 16, 15, 2), p]))); return w; }
  if (d.kind === 'chips') { const w = h('div', { className: 'lg-well lg-ui' }); w.innerHTML = `<span class="lg-title">Fix login redirect</span><span class="chips">${chipsHtml(/** @type {any} */ ({ id: 'x', title: '', ...d.s }))}</span>`; return w; }
  if (d.kind === 'fold') { const w = h('div', { className: 'lg-well lg-ui' }); w.append(h('span', { className: 'fold', textContent: d.text })); return w; }
  if (d.kind === 'pills') {
    const w = h('div', { className: 'lg-well lg-ui lg-pills' });
    w.append(...(r.shows?.modes || []).map(t => h('span', { className: 'tagline', textContent: t })), h('span', { className: 'tagline', textContent: 'demo · example data' }), h('span', { className: 'tagline upd', textContent: 'updated · reload' }));
    return w;
  }
  if (d.kind === 'none') return null;
  if (d.kind === 'bare') { const w = h('div', { className: 'lg-well lg-ui lg-col' }); w.append(h('span', { className: 'lg-title', textContent: nameOf(/** @type {any} */ (d.s)) }), h('span', { className: 'mono lg-sub', textContent: bareLabel(/** @type {any} */ (d.s)) })); return w; }
  if (d.kind === 'ends') { const w = h('div', { className: 'lg-well lg-ui lg-col' }); w.append(...(r.shows?.ends || []).filter((t, i, a) => a.indexOf(t) === i).map(t => h('span', { className: 'mono lg-sub', textContent: t }))); return w; }
  if (d.kind === 'scene') { const w = h('div', { className: 'lg-well lg-scene' }); wait.set(r.id, w); return w; }
  return h('div', { className: 'lg-well lg-empty' });
}
/** One rod part (float, reel or "!") from rod.txt in the shared palette. @param {'float' | 'reel' | 'bang'} k */
function rodPix(k) {
  const g = ROD[k], c = document.createElement('canvas'); c.width = g[0].length; c.height = g.length; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  g.forEach((row, y) => [...row].forEach((ch, i) => { if (ch !== '.') { x.fillStyle = COL[ch]; x.fillRect(i, y, 1, 1); } }));
  return pix(c.toDataURL(), g[0].length, g.length);
}

/** Scene crops from the app's real backdrop, built in a hidden garden with each job's sky, weather and day; returns job id to [canvas, overlay] lists. */
async function scenes() {
  const [B, E, W, T, S] = await Promise.all([import('./backdrop.js'), import('./scene_extras.js'), import('./world_data.js'), import('./world_time.js'), import('./state.js')]);
  const g = h('section', { id: 'garden', className: 'lg-hidden' }, [h('canvas', { id: 'bg' }), h('div', { id: 'rain', hidden: true }), h('div', { id: 'wx' })]);
  document.body.append(g);
  const bg = /** @type {HTMLCanvasElement} */ (g.querySelector('#bg')), b = B.bgs, out = new Map(), over = new Map(), was = S.state.st.clock;
  /** Sky, weather and day for one picture, then the app draws it. @param {Record<string, any>} o */
  const set = o => {
    const date = o.date || null, sun = T.sunTimes(T.ilDay(date ?? new Date()).iso), night = Math.round((sun.ss + (1440 - (sun.ss - sun.sr)) / 2) % 1440);
    Object.assign(B.wx, { code: o.code ?? 0, cloud: o.cloud ?? 15, temp: o.temp ?? null, ok: false }); Object.assign(B.wind, o.wind || { speed: null, dir: null });
    Object.assign(W.world, { vane: o.vane ?? null, streak: o.streak ?? null, tokens: o.tokens ?? null, prs: o.prs ?? null, runs: o.runs ?? null, week: o.week ?? null, lantern: o.lantern ?? true, cat: o.cat ?? false, notes: o.notes ?? null });
    E.sky.date = date; E.sky.rainAt = o.rainAgo == null ? 0 : Date.now() - o.rainAgo * 60000;
    S.state.st.clock = o.at === 'night' ? night : o.at === 'morning' ? sun.sr + 120 : Math.round((sun.sr + sun.ss) / 2);
    b.ev = []; B.drawGarden();
  };
  /** Copy of a box of the painted garden, in scene pixels. @param {number} x @param {number} y @param {number} w @param {number} hh */
  const crop = (x, y, w, hh) => { x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y)); w = Math.min(Math.round(w), bg.width - x); hh = Math.min(Math.round(hh), bg.height - y);
    const c = h('canvas', { className: 'lg-crop' }); c.width = w; c.height = hh; c.style.setProperty('--w', String(w)); c.style.setProperty('--h', String(hh));
    /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(bg, x, y, w, hh, 0, 0, w, hh); return c; };
  /** @param {string} id @param {...HTMLElement} els */
  const put = (id, ...els) => out.set(id, [...(out.get(id) || []), ...els]);
  try {
    const Wd = () => b.W, hz = () => b.hz;
    for (const t of ORE_STEPS) { set({ tokens: t }); put('ore', crop(Wd() * .825, hz() - 9, Wd() * .065, 26)); }
    set({}); { const x0 = Wd() * .28, y0 = b.H * .5; put('team', crop(x0, y0, Wd() * .2, b.H * .26));
      over.set('team', [[Wd() * .06, b.H * .23, HN[8], 2], [Wd() * .15, b.H * .21, HN[9], 6]].map(([x, y, hat, c]) => [x, y, agentHtml({ hat, c, x: 0, y: 0, mate: true })])); }
    for (const lantern of [false, true]) { set({ at: 'night', lantern }); put('lantern', crop(b.lamp[0] - 14, b.lamp[1] - 20, 44, 34)); }
    set({ notes: MAX_NOTES }); { const vx = b.cave[0], m0 = b.lamp[1] - 6; put('notes', crop(vx - 18, m0 - 8, 40, 34)); }
    set({}); { const vx = b.cave[0], m0 = b.lamp[1] - 6, y0 = m0 - 14, py = b.cave[1] + 8 - y0, t = mineMoreText(MINE_SPOTS + 3, MINE_SPOTS); put('mine', crop(vx - 40, y0, 80, py + 14));
      over.set('minemore', [[40, py, `<span class="minemore" role="img" title="${esc(t)}" aria-label="${esc(t)}"><span class="more">+3</span></span>`]]); }
    for (const dir of [90, 270, 180]) { set({ wind: { speed: 20, dir } }); const v = b.vaneBox; put('vane', crop(v[0] - 4, v[1] - 3, v[2] + 8, v[3] + 6)); }
    for (const streak of [1, MAX_EGGS]) { set({ streak }); const v = b.nestBox; put('nest', crop(v[0] - 4, v[1] - 3, v[2] + 8, v[3] + 6)); }
    set({ cat: true }); put('cat', crop(Wd() * .24, hz() - 8, Wd() * .11, 20));
    set({ prs: MAX_BLOOMS }); put('blooms', crop(Wd() * .08, hz() - 6, Wd() * .26, 22));
    set({ runs: MAX_BOATS }); B.bgPaint(0); { const xs = b.stream.map((/** @type {number[]} */ p) => p[0]), ys = b.stream.map((/** @type {number[]} */ p) => p[1]); put('boats', crop(Math.min(...xs) - 6, Math.min(...ys) - 4, Math.max(...xs) - Math.min(...xs) + 12, Math.max(...ys) - Math.min(...ys) + 8)); }
    set({ prs: COMET_PRS, at: 'night' }); put('comet', crop(Wd() * .42, 0, Wd() * .4, hz() * .7));
    set({ at: 'night' }); put('moon', crop((b.moon?.x ?? Wd() / 2) - 22, Math.max(0, (b.moon?.y ?? 20) - 14), 44, 30)); put('stars', crop(Wd() * .05, 0, Wd() * .5, hz() * .75));
    set({ at: 'night', week: [...Array(WEEK)].map((_, i) => i % 3 !== 1) }); { const xs = b.week.map((/** @type {number[]} */ p) => p[0]), ys = b.week.map((/** @type {number[]} */ p) => p[1]); if (xs.length) put('week', crop(Math.min(...xs) - 8, Math.min(...ys) - 6, Math.max(...xs) - Math.min(...xs) + 16, Math.max(...ys) - Math.min(...ys) + 12)); }
    { const full = nextFull(); for (const date of [new Date(full.getTime() - 7 * 864e5), full]) { set({ at: 'night', date, cloud: 0 }); put('fullmoon', crop((b.moon?.x ?? Wd() / 2) - 40, Math.max(0, (b.moon?.y ?? 20) - 16), 80, b.H * .45)); } }
    set({}); put('sun', crop((b.sun?.x ?? Wd() / 2) - 24, Math.max(0, (b.sun?.y ?? 20) - 16), 48, 32));
    set({ code: 61, cloud: 95, rainAgo: 0 }); { const c = crop(Wd() * .3, b.H * .55, Wd() * .3, 56), r = /** @type {HTMLElement} */ (g.querySelector('#rain')), o = h('i', { className: 'lg-rain' }); o.style.backgroundImage = r.style.backgroundImage; put('rain', h('span', { className: 'lg-layer' }, [c, o])); }
    set({ code: 2, cloud: 40, rainAgo: 8, at: 'morning' }); put('rainbow', crop(Wd() * .3, 0, Wd() * .55, hz() + 4));
    const fall = T.ilDay(new Date()).iso.slice(0, 4) + '-11-10', fd = new Date(fall + 'T10:00:00Z');
    set({ date: fd }); { const tr = b.tree; for (let k = 0; k < 6; k++) E.spawnExtras(b, () => true, -k * 1.5); B.bgPaint(.5); put('leaves', crop(tr.x0 - 4, hz() - 18, tr.x1 - tr.x0 + 16, 44));
      const f = b.ev.find((/** @type {any} */ e) => e.k === 'flock'); if (f) { B.bgPaint(f.t0 + (Wd() * .45 - f.x) / (f.dir * f.v)); put('flock', crop(Wd() * .45 - 50, f.y - 14, 70, 28)); } }
    set({ temp: 8 }); B.bgPaint(1); const ch = b.chims, cx0 = Math.min(...ch.map((/** @type {number[]} */ p) => p[0])) - 8, cx1 = Math.max(...ch.map((/** @type {number[]} */ p) => p[0])) + 34, cy = ch[0][1];
    put('smoke', crop(cx0, cy - 30, cx1 - cx0, 40));
    set({ temp: 8, wind: { speed: 40, dir: 90 } }); B.bgPaint(1); put('wind', crop(cx0, cy - 30, cx1 - cx0, 40));
    set({ temp: 30, at: 'night' }); put('town', crop(cx0, cy - 6, cx1 - cx0, hz() + 8 - cy + 6)); over.set('z', ch.map((/** @type {number[]} */ p) => [p[0] - cx0, p[1] - (cy - 6), '<i class="snore lg-z">z</i>']));
    { const x0 = Wd() * .03, y0 = b.H * .42, fire = `<i class="fire"><b style="background-image:url(${propSheet(['fire-a', 'fire-b'])})"></b></i>`; put('fire', crop(x0, y0, Wd() * .22, b.H * .24));
      over.set('fire', [[FIRE.x * Wd() - x0, FIRE.y * b.H - y0, fire], ...BY_FIRE.map((i, n) => [SPOTS[i][0] * Wd() - x0, SPOTS[i][1] * b.H - y0, agentHtml({ hat: HN[n + 2], c: n + 5, x: 0, y: 0, rest: 'sit', face: fireFace(i), bubble: '' })])]); }
    if (!S.reduced) {
      set({ at: 'night', cloud: 0 }); B.bgMoment('star'); { const e = b.ev.find((/** @type {any} */ q) => q.k === 'shoot'); if (e) { B.bgPaint(e.t0 + e.dur * .45); put('star', crop(e.x - 34, e.y - 10, 68, 34)); } }
      set({}); B.bgMoment('bird'); { const e = b.ev.find((/** @type {any} */ q) => q.k === 'lift'); if (e) { B.bgPaint(e.t0 + 2.2); put('bird', crop(e.x0 - 30, 0, 110, 40)); } }
    }
  } finally {
    S.state.st.clock = was; cancelAnimationFrame(b.raf); b.raf = 0; b.skyC = null; g.remove();
  }
  return { out, over };
}

/** Builds the page: sticky bar with group links and the zoom switch, one section per group, then the keys. @param {HTMLElement} root */
export async function mount(root) {
  /** @type {Map<string, HTMLElement>} */
  const wait = new Map();
  const zoomed = (() => { try { return localStorage.getItem('legendZoom') === '1'; } catch (e) { return false; } })();
  const zoom = h('button', { type: 'button', className: 'lg-zoom', textContent: '3× zoom' }); zoom.setAttribute('aria-pressed', String(zoomed));
  document.body.classList.toggle('lg-big', zoomed);
  zoom.addEventListener('click', () => { const on = !document.body.classList.contains('lg-big'); document.body.classList.toggle('lg-big', on); zoom.setAttribute('aria-pressed', String(on)); try { localStorage.setItem('legendZoom', on ? '1' : '0'); } catch (e) {} });
  const nav = h('nav', { className: 'lg-nav', ariaLabel: 'Sections' }, [...[...GROUPS, ['keys', 'Keys']].map(([id, t]) => h('a', { href: '#' + id, textContent: t })), zoom]);
  const secs = GROUPS.map(([gid, title]) => h('section', { id: gid, className: 'lg-sec' }, [h('h2', { textContent: title }),
    ...ROWS.filter(r => r.group === gid).map(r => h('article', { className: 'lg-row', id: 'sig-' + r.id }, [...[figure(r, wait)].filter(e => e !== null).map(w => Object.assign(w, { role: 'img', ariaLabel: r.name + ', as the garden draws it' })),
      h('div', { className: 'lg-text' }, [h('h3', { textContent: r.name }), h('p', { className: 'lg-mean', textContent: r.meaning }), h('p', { className: 'lg-rule', textContent: r.rule.text })])]))]));
  const keys = h('section', { id: 'keys', className: 'lg-sec' }, [h('h2', { textContent: 'Keys' }), h('table', { className: 'lg-keys' }, [
    h('thead', {}, [h('tr', {}, ['Key', 'Where', 'What it does'].map(t => h('th', { scope: 'col', textContent: t })))]),
    h('tbody', {}, KEYS.map(k => h('tr', {}, [h('td', {}, [k.keys, ...(k.alt ? [k.alt] : [])].flatMap((ks, j) => [...(j ? [' or '] : []), ...ks.flatMap((x, i) => [...(i ? [' '] : []), x === 'any other key' ? x : h('kbd', { textContent: x })])])), h('td', { textContent: k.where }), h('td', { textContent: k.does })])))])]);
  root.replaceChildren(nav, ...secs, keys);
  let crops = new Map(), over = new Map();
  try { ({ out: crops, over } = await scenes()); } catch (e) { console.warn('legend: scenery not drawn', e); }
  for (const [id, w] of wait) {
    const r = ROWS.find(x => x.id === id), job = r?.draw.job, els = /** @type {HTMLElement[]} */ (crops.get(job) || []), pts = over.get(r?.draw.over || job) || [];
    if (!els.length) { w.classList.add('lg-empty'); w.textContent = job === 'star' || job === 'bird' ? 'Not shown while reduced motion is on.' : 'Not drawn here.'; continue; }
    for (const e of els) {
      const copy = /** @type {HTMLElement} */ (e.cloneNode(true)), src = e.tagName === 'CANVAS' ? [e] : [...e.querySelectorAll('canvas')];
      (copy.tagName === 'CANVAS' ? [copy] : [...copy.querySelectorAll('canvas')]).forEach((c, i) => /** @type {CanvasRenderingContext2D} */ (/** @type {HTMLCanvasElement} */ (c).getContext('2d')).drawImage(/** @type {HTMLCanvasElement} */ (src[i]), 0, 0));
      const lay = copy.classList.contains('lg-layer') ? copy : h('span', { className: 'lg-layer' }, [copy]);
      for (const [x, y, html] of pts) { const at = h('span', { className: 'lg-at' }); at.style.setProperty('--x', String(Math.round(x))); at.style.setProperty('--y', String(Math.round(y))); at.innerHTML = html; lay.append(at); }
      w.append(lay);
    }
  }
}
