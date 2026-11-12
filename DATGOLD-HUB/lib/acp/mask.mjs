// What leaves the ACP agent for an editor is masked here, and nowhere else.
//
// ACP is a new way for the contents of files to leave the Hub (the text of a diff, the arguments of a call, the words of an error), and the editor on the other end may pass them on
// (its own cloud features, its telemetry, a shared session). So every message, every error and every line of the log goes through ONE function that does what the approval card does:
// the Hub's `maskSecrets` (lib/permissions.mjs) on every string of the DECODED value. It is never run on JSON text: a JSON string writes a double quote as \" and a line break as \n, and the
// masking rules for `"password": "..."`, for a flag with a quoted value or for a command on its own line do not see through that (the weakness of `safePreview`, which stringifies first).
//
// Besides the patterns of `maskSecrets` (tokens by their shape, `name = value` pairs, flags that take a secret, the body of a private key between its frames), the agent masks the
// credentials it holds itself, by value: the bearer of the Hub and its CSRF token. The list is asked for on every call, so a credential that is learned after the start is masked from then on.
//
// Keys of objects are structure and are left as they are. A string is masked wherever it stands, ids and paths included: the patterns do not alter ordinary ids, paths or URIs (the tests
// pass names that say token and password through), and a list of "structural" fields would be one more thing that a new message could get wrong.
import { maskSecrets } from '../permissions.mjs';

const MAX_DEPTH = 64;
const CUT = '[cut: nested too deeply or circular]';

/** @param {{secrets?: () => string[]}} [options] the credentials to mask by value, asked for on every call */
export function createMasker({ secrets = () => [] } = {}) {
  const text = (value) => maskSecrets(String(value), secrets());
  const walk = (value, depth, ancestors) => {
    if (typeof value === 'string') return text(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH || ancestors.has(value)) return CUT;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, ancestors));
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1, ancestors)]));
    } finally { ancestors.delete(value); }
  };
  return {
    /** A string, masked. */
    text,
    /** A copy of a value (any JSON-like structure) with every string masked; the argument is not changed. */
    value: (value) => walk(value, 0, new Set()),
    /** The words of an error, masked, as a string. */
    error(error) {
      if (error === undefined || error === null) return 'unknown error';
      return text(error instanceof Error ? error.message : String(error));
    },
  };
}
