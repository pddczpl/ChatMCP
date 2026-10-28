// The version of the Hub that the tests run against (lib/manager.mjs), and releases made from it. A suite that starts the real Hub, or runs a tool that prints the Hub's own version, must not write down
// the number of the release it was written in: every release changes VERSION, and "newer than the Hub that runs" has to stay true.
import { VERSION } from '../../lib/manager.mjs';

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(VERSION);
if (!match) throw new Error(`VERSION is not x.y.z: ${VERSION}`);
const [major, minor, patch] = match.slice(1).map(Number);

/** The version that the Hub under test says it is. */
export const RUNNING = VERSION;
/** The next patch release, and the one after it (3.11.0: 3.11.1 and 3.11.2). */
export const NEXT_PATCH = `${major}.${minor}.${patch + 1}`;
export const NEXT_PATCH_2 = `${major}.${minor}.${patch + 2}`;
/** The patch release that is `count` after the running one (3.11.0, 9: 3.11.9). */
export const patchAfter = (count) => `${major}.${minor}.${patch + count}`;
/** The next minor release (3.11.0: 3.12.0). */
export const NEXT_MINOR = `${major}.${minor + 1}.0`;
/** The text with every character that a regular expression reads as a pattern escaped (a version has dots). */
export const exactly = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
