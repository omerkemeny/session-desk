// @ts-check
// Shared JSDoc shapes; import them with /** @typedef {import('./types.js').Session} Session */.

/**
 * One session as /api/sessions returns it, or as the demo data describes it.
 * @typedef {object} Session
 * @property {string} id
 * @property {string} title
 * @property {string} project
 * @property {string} [branch]
 * @property {'waiting' | 'running' | 'done'} status
 * @property {number} [statusAt]    when the status last changed; part of the sent-home key
 * @property {string} [model]
 * @property {number} updated       ms timestamp of the newest message
 * @property {number} [tokens]
 * @property {string} [topic]       latest request from the user
 * @property {string} [ask]         the question it waits on
 * @property {string[]} [answers]   demo only: suggested replies
 * @property {string} [last]        last thing it said or did
 * @property {string[]} [subs]      running subagents
 * @property {Array<[string, number]>} [plan]
 * @property {Array<Array<any>>} [tl]       demo only: compact transcript
 * @property {Array<Array<any>>} [full]     whole transcript events, loaded on open
 * @property {Array<[string, number, number]>} [files]
 * @property {number} [err]         1 when the transcript failed to load
 * @property {string[]} [also]      other programs holding the session
 * @property {boolean} [behind]     page terminal is older than the transcript
 * @property {boolean} [term]       a page terminal is running for it
 * @property {string} [replyError]
 * @property {number} [copies]     live programs holding the session now; 2 or more means open twice
 * @property {number} [replyExit]  exit code of the last quick reply, when the server sends it
 * @property {'interactive' | 'headless'} [kind]   headless: started through the CLI's print mode by a hook or script
 * @property {boolean} [automated] every prompt came from a program (hook or script), whatever program started it
 * @property {boolean} [lastError]  the newest tool result failed
 * @property {number} [prOpened]    pull requests the session opened
 * @property {any} [consistency]    copies in sync or diverged, when the server reports it
 * @property {number} [waitingSince] ms timestamp it started waiting for you; 0 or missing when unknown
 * @property {number} [tokensToday] tokens used today (the stats time zone's day)
 * @property {number} [prsToday]    pull requests opened today
 */

/**
 * A session's outfit: hat name and body colour index into BODIES.
 * @typedef {{ hat: string, c: number }} Look
 */

/**
 * A standing place in garden fractions: [x, y] of the feet.
 * @typedef {[number, number]} Slot
 */

/**
 * Current weather; sunrise and sunset in minutes after midnight, Israel time.
 * @typedef {object} Weather
 * @property {number} code      WMO weather code
 * @property {number} cloud     cloud cover in percent
 * @property {number | null} temp
 * @property {number} sr
 * @property {number} ss
 * @property {boolean} ok       true once a forecast loaded
 */

/**
 * Page UI state shared by every module.
 * @typedef {object} DeskState
 * @property {string} q                   search text
 * @property {string | null} open         id of the session in the drawer
 * @property {boolean} first              true until the first render finished
 * @property {'term' | 'log'} [view]      drawer tab
 * @property {string | null} [fresh]      session whose terminal should restart
 * @property {number} [clock]             forced minutes after midnight, for testing the sky
 */

/**
 * A character standing in the garden or at the mine.
 * @typedef {{ el: HTMLButtonElement, slot: number, rod?: HTMLDivElement }} Actor
 */

export {};
