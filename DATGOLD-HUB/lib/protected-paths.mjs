// Paths a coding agent must never read, write or print: credentials, private keys
// and Git internals. Shared by the local tool server and the shell-command
// analyzer so both apply exactly the same rule.
import { globMatches } from './glob-match.mjs';

const EXAMPLE = '(?:example|sample|template|dist|defaults?)';
export const PRIVATE_FILE = new RegExp(
  '^(?:'
  + `\\.env(?!\\.${EXAMPLE}$)(?:\\..*)?`
  + '|id_(?:rsa|dsa|ecdsa|ed25519)(?:\\..*)?'
  + '|.*\\.(?:pem|p12|pfx|key|keystore|jks|ppk)'
  + '|credentials(?:\\.(?:json|toml))?'
  + '|secrets?\\.(?:json|ya?ml|toml|(?:auto\\.)?tfvars)'
  + '|\\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd|pgpass|dockercfg|vault-token|terraformrc)'
  + '|_netrc'
  // Terraform: the tokens of its command line, and state, which holds every secret a resource was created with, in clear text.
  + '|terraform\\.rc'
  + '|credentials\\.tfrc\\.json'
  + '|.*\\.tfstate(?:\\.[0-9]+)?(?:\\.backup)?'
  // Google Cloud: a service-account key under its usual names, and the login gcloud keeps for client libraries.
  + '|service[-_]?account(?:[-_]?key)?(?:[-_.].*)?\\.json'
  + '|application_default_credentials\\.json'
  + '|kubeconfig(?:\\.ya?ml)?'
  + '|.*\\.kubeconfig'
  + ')$', 'i');
export const PRIVATE_DIRECTORIES = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube']);
// Files that are secret only where they are: `config.json` and `hosts.yml` are ordinary names, `.docker/config.json` holds registry
// logins and `gh/hosts.yml` (below `.config`) the GitHub token. A row is consecutive names of a path, in lower case: the path is
// protected when it ends with them, and also when it goes on below them (`gcloud/legacy_credentials` is a folder of key files).
export const PRIVATE_LOCATIONS = [
  ['.docker', 'config.json'],
  ['gh', 'hosts.yml'],
  ['.azure', 'accesstokens.json'],
  ['.azure', 'msal_token_cache.json'],
  ['.azure', 'msal_token_cache.bin'],
  ['.azure', 'service_principal_entries.json'],
  ['gcloud', 'credentials.db'],
  ['gcloud', 'access_tokens.db'],
  ['gcloud', 'legacy_credentials'],
  ['.m2', 'settings.xml'],
  ['.m2', 'settings-security.xml'],
];

const components = (value) => String(value).split(/[\\/]+/).filter((part) => part && part !== '.');

// A project can ship `.chatmcp/hooks.json`: configuration that starts programs. It is inert until the owner approves its sha256
// (lib/hooks.mjs), and no tool may write it or read it into a prompt. The rule names that one file, not the whole folder.
const HOOKS_FOLDER = '.chatmcp';
const HOOKS_FILE = 'hooks.json';
// Windows ignores trailing dots and spaces in a name and an NTFS stream suffix ("hooks.json::$DATA") names the same file. Plain string
// work on purpose: an end-anchored regular expression ("[. ]+$") over a name that a model chose takes quadratic time.
function nameOf(part) {
  let name = String(part).toLowerCase();
  const stream = name.indexOf(':');
  if (stream !== -1) name = name.slice(0, stream);
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end -= 1;
  return name.slice(0, end);
}

/** Whether the names of a path hold a row of PRIVATE_LOCATIONS: at its end (the file) or before it (something below a folder of that name). */
function atLocation(names, parts) {
  for (let start = 0; start + parts.length <= names.length; start += 1) {
    if (parts.every((part, index) => names[start + index] === part)) return true;
  }
  return false;
}

/** True when a workspace-relative path names a secret file or sits inside a protected directory. */
export function isProtectedPath(relative) {
  const parts = components(relative);
  if (!parts.length) return false;
  if (parts.some((part) => PRIVATE_DIRECTORIES.has(part.toLowerCase()))) return true;
  if (parts.length >= 2 && nameOf(parts.at(-1)) === HOOKS_FILE && nameOf(parts.at(-2)) === HOOKS_FOLDER) return true;
  if (PRIVATE_FILE.test(parts.at(-1))) return true;
  const names = parts.map(nameOf);
  return PRIVATE_LOCATIONS.some((row) => atLocation(names, row));
}

/**
 * Whether one path segment, which may hold wildcards, can stand for `literal` (a bracket expression counts as any one character).
 * A wildcard that does not begin with a dot is not taken for a dot-folder: shells leave dot-names out of a bare star, and a pattern such
 * as star-slash-star is too common to refuse. The rule is a second line of defence; a file written by other means is inert until approved.
 */
function segmentMayBe(segment, literal) {
  if (nameOf(segment) === literal) return true;
  if (!/[*?[]/.test(segment) || (literal.startsWith('.') && !segment.startsWith('.'))) return false;
  // The segment is text from a shell command, that is from a model, so it is matched by a table walk (lib/glob-match.mjs) and not by a
  // regular expression made from it: a run of stars against a name that almost matches would otherwise never finish.
  return globMatches(segment, literal, { path: true, ignoreCase: true, brackets: true });
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
  // Terraform state through a wildcard ("*.tfstate", "terraform.tfstate*")
  if (/[*?[]/.test(text) && text.includes('.tfstate')) return true;
  // A file that is secret where it is (".docker/*", ".config/gh/*.yml"). A row without a dot-folder needs one segment written out in
  // full: "gh/*" and "*/hosts.yml" are refused, star-slash-star is not.
  for (const parts of PRIVATE_LOCATIONS) {
    const anchored = parts.some((part) => part.startsWith('.'));
    for (let index = 0; index + parts.length <= segments.length; index += 1) {
      const window = segments.slice(index, index + parts.length);
      if (!window.every((segment, at) => segmentMayBe(segment, parts[at]))) continue;
      if (anchored || window.some((segment, at) => nameOf(segment) === parts[at])) return true;
    }
  }
  return false;
}
