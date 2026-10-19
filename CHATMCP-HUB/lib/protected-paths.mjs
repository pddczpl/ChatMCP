// Paths a coding agent must never read, write or print: credentials, private keys
// and Git internals. Shared by the local tool server and the shell-command
// analyzer so both apply exactly the same rule.

const EXAMPLE = '(?:example|sample|template|dist|defaults?)';
export const PRIVATE_FILE = new RegExp(
  '^(?:'
  + `\\.env(?!\\.${EXAMPLE}$)(?:\\..*)?`
  + '|id_(?:rsa|dsa|ecdsa|ed25519)(?:\\..*)?'
  + '|.*\\.(?:pem|p12|pfx|key|keystore|jks|ppk)'
  + '|credentials(?:\\.json)?'
  + '|secrets?\\.(?:json|ya?ml|toml)'
  + '|\\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd)'
  + ')$', 'i');
export const PRIVATE_DIRECTORIES = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube']);

const components = (value) => String(value).split(/[\\/]+/).filter((part) => part && part !== '.');

// A project can ship `.chatmcp/hooks.json`: configuration that starts programs. It is inert until the owner approves its sha256
// (lib/hooks.mjs), and no tool may write it or read it into a prompt. The rule names that one file, not the whole folder.
const HOOKS_FOLDER = '.chatmcp';
const HOOKS_FILE = 'hooks.json';
// Windows ignores trailing dots and spaces in a name and an NTFS stream suffix ("hooks.json::$DATA") names the same file.
const nameOf = (part) => String(part).toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');

/** True when a workspace-relative path names a secret file or sits inside a protected directory. */
export function isProtectedPath(relative) {
  const parts = components(relative);
  if (!parts.length) return false;
  if (parts.some((part) => PRIVATE_DIRECTORIES.has(part.toLowerCase()))) return true;
  if (parts.length >= 2 && nameOf(parts.at(-1)) === HOOKS_FILE && nameOf(parts.at(-2)) === HOOKS_FOLDER) return true;
  return PRIVATE_FILE.test(parts.at(-1));
}

/**
 * Whether one path segment, which may hold wildcards, can stand for `literal` (a bracket expression counts as any one character).
 * A wildcard that does not begin with a dot is not taken for a dot-folder: shells leave dot-names out of a bare star, and a pattern such
 * as star-slash-star is too common to refuse. The rule is a second line of defence; a file written by other means is inert until approved.
 */
function segmentMayBe(segment, literal) {
  if (nameOf(segment) === literal) return true;
  if (!/[*?[]/.test(segment) || (literal.startsWith('.') && !segment.startsWith('.'))) return false;
  const pattern = [...segment.replace(/\[[^\]]*\]/g, '?')].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${pattern}$`, 'i').test(literal);
}

/**
 * Looser check for shell arguments that may contain wildcards (".env*", "*.pem") or
 * Git "revision:path" syntax ("HEAD:.env"): the argument could name or expand to a
 * protected file, so it is treated as one.
 */
export function mayExpandToProtected(value) {
  const text = String(value).toLowerCase();
  if (isProtectedPath(text)) return true;
  // "rev:path" (git show HEAD:.env) -- every colon-separated piece may be a path.
  if (text.includes(':') && text.split(':').some((piece) => piece && piece !== text && isProtectedPath(piece))) return true;
  if (/(^|[\\/:])\.env(?!\.(?:example|sample|template|dist|defaults?)(?:$|[\\/]))/.test(text)) return true;
  if (/(^|[\\/:])\.git(?:$|[\\/])/.test(text)) return true;
  if (/\*[^\\/]*\.(?:pem|p12|pfx|key|keystore|jks|ppk)\b/.test(text)) return true;
  if (/(^|[\\/:*?])id_(?:rsa|dsa|ecdsa|ed25519)/.test(text)) return true;
  // the project hooks file, also through a wildcard in either segment (".chatmcp/*", ".chatmcp/hook*", ".chat*/hooks.json")
  const segments = text.split(/[\\/:]+/).filter(Boolean);
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segmentMayBe(segments[index], HOOKS_FOLDER) && segmentMayBe(segments[index + 1], HOOKS_FILE)) return true;
  }
  return false;
}
