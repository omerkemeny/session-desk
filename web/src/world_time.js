// @ts-check
// Pure date and sky maths for the garden: Israel calendar, moon phase, leaf fall, bird migration, rain timing, smoke and real star positions over Tel Aviv.

const LAT = 32.0853, LON = 34.7818; // Tel Aviv, degrees
const SYNODIC = 29.530588853; // days per lunar cycle
const D2R = Math.PI / 180;
const RAINBOW_MIN = 45; // minutes a rainbow can show after the rain stops
const PUDDLE_MIN = 120; // minutes puddles take to dry after the rain stops

/** Israel calendar date for an instant. @param {Date} d */
export function ilDay(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { iso:`${p.year}-${p.month}-${p.day}`, y:+p.year, m:+p.month, d:+p.day };
}
/** Instant for an Israel date (YYYY-MM-DD) at t minutes after local midnight. @param {string} iso @param {number} t */
export function ilInstant(iso, t) {
  const [y, m, d] = iso.split('-').map(Number), want = Date.UTC(y, m - 1, d, 0, t), guess = want - 120 * 60000;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Jerusalem', hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
  return new Date(guess + (want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)));
}
/** Sunrise and sunset over Tel Aviv for an Israel date (YYYY-MM-DD), in minutes after local midnight; standard sunrise equation (refraction and disc, -0.833°), good to about a minute. @param {string} iso */
export function sunTimes(iso) {
  const [y, m, d] = iso.split('-').map(Number), n = Math.round(Date.UTC(y, m - 1, d, 12) / 864e5 + 2440587.5 - 2451545), J = n - LON / 360;
  const M = (357.5291 + .98560028 * J) % 360 * D2R, C = 1.9148 * Math.sin(M) + .02 * Math.sin(2 * M) + .0003 * Math.sin(3 * M), lam = ((M / D2R + C + 282.9372) % 360) * D2R;
  const noon = 2451545 + J + .0053 * Math.sin(M) - .0069 * Math.sin(2 * lam), dec = Math.asin(Math.sin(lam) * Math.sin(23.4397 * D2R)), la = LAT * D2R;
  const w = Math.acos((Math.sin(-.833 * D2R) - Math.sin(la) * Math.sin(dec)) / (Math.cos(la) * Math.cos(dec))) / D2R / 360, t0 = ilInstant(iso, 0).getTime();
  /** @param {number} jd */
  const min = jd => Math.round(((jd - 2440587.5) * 864e5 - t0) / 60000);
  return { sr: min(noon - w), ss: min(noon + w) };
}
/** Moon age as a fraction of the cycle: 0 new, .25 first quarter, .5 full, .75 last quarter. @param {Date} d */
export const moonPhase = d => { const p = (d.getTime() / 864e5 + 2440587.5 - 2451550.1) / SYNODIC % 1; return p < 0 ? p + 1 : p; };
/** Lit fraction of the moon's disc for a phase. @param {number} p */
/** How full the moon is for the night sky, 1 at full and 0 from a day and a half either side. @param {number} p phase 0..1 (0.5 full) */
export const moonFull = p => Math.max(0, 1 - Math.abs(p - .5) * SYNODIC / 1.5);
export const moonLit = p => (1 - Math.cos(2 * Math.PI * p)) / 2;
/** True where pixel (i, j) of a moon of radius r is sunlit for phase p; waxing light comes from the right. @param {number} i @param {number} j @param {number} r @param {number} p */
export const moonPx = (i, j, r, p) => { const w = Math.sqrt(Math.max(0, 1 - (j / r) ** 2)), x = i / r, c = Math.cos(2 * Math.PI * p) * w; return p < .5 ? x > c : x < -c; };

/** Autumn leaf fall in 0..1 by Israel month and day: rises from early October, peaks mid November, gone by mid December. @param {number} m @param {number} d */
export function leafFall(m, d) {
  const doy = Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 864e5), a = 277, b = 349;
  return doy < a || doy > b ? 0 : Math.min(1, Math.sin(Math.PI * (doy - a) / (b - a)) * 1.6);
}
/** Bird migration over Israel: 1 (flocks fly right) in autumn, -1 (left) in spring, else 0. @param {number} m @param {number} d */
export const migration = (m, d) => (m >= 9 && m <= 10) || (m === 11 && d <= 20) ? 1 : (m >= 3 && m <= 4) || (m === 5 && d <= 15) ? -1 : 0;
/** Smoking chimneys for a temperature in °C; unknown keeps all three. @param {number | null} temp */
export const smokeCount = temp => temp == null ? 3 : temp < 16 ? 3 : temp < 21 ? 2 : temp < 26 ? 1 : 0;
/** Wind lean on screen in three coarse steps, -2..2 (positive to the right): the scene looks south, so wind from the east (direction from, degrees) pushes right; by the cross-screen part of the speed in km/h, calm under 12, strong from 30. @param {number | null} speed @param {number | null} dir */
export const windLean = (speed, dir) => { if (speed == null || dir == null) return 0; const x = speed * Math.sin(dir * D2R), a = Math.abs(x); return a < 12 ? 0 : Math.sign(x) * (a < 30 ? 1 : 2); };
export const VANE_REST = 270; // degrees the vane shows before the first weather answer: the sea breeze from the west
/** Weather vane pose for the wind direction (degrees it comes from), the arrow's head into the wind as seen looking south: x -1 head left (from the east) to 1 right, z 1 toward the viewer (from the south) to -1 away; an unknown direction shows VANE_REST. @param {number | null} dir */
export const vanePose = dir => { const d = (dir ?? VANE_REST) * D2R, q = (/** @type {number} */ v) => Math.abs(v) > .38 ? Math.sign(v) : 0; return { x: q(-Math.sin(d)), z: q(-Math.cos(d)) }; };
/** Sideways drift of chimney smoke in sprite px over its rise: the approved drift when calm (stronger in storms), else with the wind. @param {number} lean @param {boolean} storm */
export const smokeDrift = (lean, storm) => lean ? lean * (Math.abs(lean) > 1 ? 18 : 11) : storm ? 16 : 6;
/** Epoch ms when the latest rain ended, from Open-Meteo hourly times (local, each the end of its hour) and precipitation in mm, ignoring hours after now; 0 when none. @param {string[] | undefined} times @param {number[] | undefined} mm @param {number} offsetSec @param {number} now */
export function rainEnded(times, mm, offsetSec, now) {
  for (let i = (times || []).length - 1; i >= 0; i--) { const at = Date.parse(times[i] + 'Z') - offsetSec * 1000; if (at <= now && (mm?.[i] ?? 0) >= .1) return at; }
  return 0;
}
/** Rainbow strength 0..1: fades over RAINBOW_MIN minutes after rain, needs the sun up, no rain or snow and a broken sky. @param {number} minsSince @param {number} sunUp @param {boolean} falling @param {number} cloud */
export const rainbow = (minsSince, sunUp, falling, cloud) => falling || cloud > 85 || sunUp < .5 || !(minsSince >= 0 && minsSince < RAINBOW_MIN) ? 0 : 1 - minsSince / RAINBOW_MIN;
/** Puddles left 0..1: full while rain falls, drying over PUDDLE_MIN minutes after it stops; none under snow. @param {number} minsSince @param {boolean} wet @param {boolean} snow */
export const puddleLeft = (minsSince, wet, snow) => snow ? 0 : wet ? 1 : minsSince >= 0 && minsSince < PUDDLE_MIN ? 1 - minsSince / PUDDLE_MIN : 0;

// Bright stars: right ascension (h), declination (deg), magnitude.
/** @type {Array<[number, number, number]>} */
export const STARS = [
  [5.919, 7.41, .5], [5.242, -8.2, .1], [5.419, 6.35, 1.6], [5.796, -9.67, 2.1], [5.679, -1.94, 1.8], [5.604, -1.2, 1.7], [5.533, -.3, 2.2], // Orion
  [4.599, 16.51, .9], [3.791, 24.11, 2.9], [3.819, 24.05, 3.6], [3.747, 24.11, 3.7], [3.763, 24.37, 3.9], // Aldebaran, Pleiades
  [6.752, -16.72, -1.5], [6.378, -17.96, 2], [7.14, -26.39, 1.8], [6.977, -28.97, 1.5], [7.655, 5.22, .4], [7.577, 31.89, 1.6], [7.755, 28.03, 1.1], // Sirius, Procyon, Gemini
  [10.139, 11.97, 1.4], [10.333, 19.84, 2], [11.818, 14.57, 2.1], [11.235, 20.52, 2.6], [13.42, -11.16, 1], [14.261, 19.18, 0], // Leo, Spica, Arcturus
  [16.49, -26.43, 1], [16.006, -22.62, 2.3], [16.091, -19.81, 2.6], [16.836, -34.29, 2.3], [17.56, -37.1, 1.6], [17.512, -37.3, 2.7], [17.622, -43, 1.9], // Scorpius
  [18.403, -34.38, 1.8], [18.921, -26.3, 2], [19.044, -29.88, 2.6], [18.35, -29.83, 2.7], [18.466, -25.42, 2.8], [18.096, -30.42, 3], [19.116, -27.67, 3.3], // Sagittarius
  [18.616, 38.78, 0], [19.846, 8.87, .8], [20.69, 45.28, 1.3], // Vega, Altair, Deneb
  [23.079, 15.21, 2.5], [23.063, 28.08, 2.4], [.22, 15.18, 2.8], [.14, 29.09, 2.1], [22.961, -29.62, 1.2], [5.278, 45.99, .1] // Pegasus, Fomalhaut, Capella
];
/** Local sidereal time over Tel Aviv in hours. @param {Date} d */
export const lst = d => { const g = 18.697374558 + 24.06570982441908 * (d.getTime() / 864e5 - 10957.5); return ((g + LON / 15) % 24 + 24) % 24; };
/** Altitude and azimuth (degrees, azimuth from north through east) of a star over Tel Aviv. @param {number} ra @param {number} dec @param {Date} d */
export function altAz(ra, dec, d) {
  const H = (lst(d) - ra) * 15 * D2R, de = dec * D2R, la = LAT * D2R;
  const alt = Math.asin(Math.sin(la) * Math.sin(de) + Math.cos(la) * Math.cos(de) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H) * Math.cos(de), Math.sin(de) * Math.cos(la) - Math.cos(de) * Math.sin(la) * Math.cos(H));
  return { alt: alt / D2R, az: ((az / D2R) % 360 + 360) % 360 };
}
/** Real bright stars on a sky band W wide whose horizon is at y = hz, looking south (east on the left); [x, y, mag] for those in view. @param {Date} d @param {number} W @param {number} hz */
export function skyStars(d, W, hz) {
  const ky = hz / 62, kx = Math.min(W / 200, ky * 1.8), out = [];
  for (const [ra, dec, mag] of STARS) {
    const { alt, az } = altAz(ra, dec, d), da = az - 180;
    if (alt < 2 || Math.abs(da) > 105) continue;
    const x = Math.round(W / 2 + da * kx * Math.cos(alt * D2R * .6)), y = Math.round(hz - 6 - alt * ky);
    if (x >= 0 && x < W && y >= 1) out.push([x, y, mag]);
  }
  return out;
}
export const FIREFLY_MIN = 1440; // minutes after sunset that fireflies keep flashing: the whole night, as in the approved scene (150 would let the late night rest and save about half a percent of a core)
/** Fireflies flash from sunset until FIREFLY_MIN minutes after it, as most kinds do. @param {number} t scene minute @param {number} ss sunset minute */
export const fireflyTime = (t, ss) => (t - ss + 1440) % 1440 <= FIREFLY_MIN;
export const FAST_MS = 88, SLOW_MS = 1000; // backdrop repaint gaps: something quick on screen, only slow drift
/** Ms to the backdrop's next repaint: FAST_MS while anything quick moves (an event, a catch, rain splashes, butterflies by day, fireflies after dusk), SLOW_MS while only clouds, fog or paper boats drift, 0 when nothing moves (the minute tick still repaints). @param {{ events: number, hooks: number, wet: boolean, snow: boolean, L: number, flies: boolean, clouds: number, fog: boolean, boats: number }} o */
export const repaintMs = o => o.events || o.hooks || (o.wet && !o.snow) || (!o.wet && !o.snow && (o.L > .55 || (o.L < .5 && o.flies))) ? FAST_MS : o.clouds || o.fog || o.boats ? SLOW_MS : 0;
