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

/** True when a workspace-relative path names a secret file or sits inside a protected directory. */
export function isProtectedPath(relative) {
  const parts = components(relative);
  if (!parts.length) return false;
  if (parts.some((part) => PRIVATE_DIRECTORIES.has(part.toLowerCase()))) return true;
  return PRIVATE_FILE.test(parts.at(-1));
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
  return false;
}
