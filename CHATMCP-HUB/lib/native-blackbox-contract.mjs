// Declarative public-case checks. Neither repository code nor child output may
// supply executable grading logic or an authoritative pass/count assertion.
export const BLACKBOX_KIND = 'node-json-blackbox';
export const BLACKBOX_COMMAND = 'node --chatmcp-blackbox-v1';
export const NATIVE_GRADER_KIND = 'native-blackbox';
export const MAX_BLACKBOX_BYTES = 64 * 1024;
export const ZERO_SHA256 = '0'.repeat(64);
const SHA = /^[0-9a-f]{64}$/;
const bad = message => Object.assign(new Error(message), { code: 'invalid_blackbox_check', statusCode: 400 });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const isBlackboxManifestPath = value => typeof value === 'string' &&
  /^chatmcp\.checks\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(value);

export function parseStrictJson(bytes) {
  const text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BLACKBOX_BYTES) throw bad('Check JSON exceeds 64 KiB.');
  let value;
  try { value = JSON.parse(text); } catch { throw bad('Check must contain exactly one valid JSON value.'); }
  // JSON.parse validates grammar but silently overwrites duplicate object keys.
  // Inspect property tokens, including escaped spellings, at every depth.
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const token = text[i];
    if (token === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      const top = stack.at(-1);
      if (top?.keys && top.keyExpected) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (top.keys.has(key)) throw bad('Duplicate JSON object key is forbidden.');
        top.keys.add(key); top.keyExpected = false;
      }
    } else if (token === '{') stack.push({ keys: new Set(), keyExpected: true });
    else if (token === '[') stack.push({});
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)?.keys) stack.at(-1).keyExpected = true;
  }
  let nodes = 0;
  const inspect = (item, depth) => {
    if (++nodes > 10000 || depth > 16) throw bad('Check JSON nesting or value count exceeds its bound.');
    if (typeof item === 'number' && !Number.isFinite(item)) throw bad('JSON numbers must be finite.');
    if (item && typeof item === 'object') for (const child of Object.values(item)) inspect(child, depth + 1);
  };
  inspect(value, 0);
  return value;
}

export function validateBlackboxManifest(bytes) {
  const spec = parseStrictJson(bytes);
  if (!exactKeys(spec, ['version', 'kind', 'adapter', 'cases']) || spec.version !== 1 || spec.kind !== BLACKBOX_KIND ||
      typeof spec.adapter !== 'string' || spec.adapter.length > 512 ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:mjs|cjs|js)$/.test(spec.adapter) ||
      spec.adapter.split('/').some(part => part === '.' || part === '..' || part.endsWith('.') ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)) ||
      !Array.isArray(spec.cases) || spec.cases.length < 1 || spec.cases.length > 64) throw bad('Invalid declarative black-box schema.');
  const ids = new Set();
  for (const item of spec.cases) {
    if (!exactKeys(item, ['id', 'input', 'expected']) || typeof item.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) throw bad('Cases require unique IDs, input, and expected JSON values.');
    ids.add(item.id);
  }
  return spec;
}

export function validateBlackboxRequest(grader) {
  if (!exactKeys(grader, ['version', 'kind', 'manifestPath', 'manifestSha256', 'caseIds']) ||
      grader.version !== 1 || grader.kind !== BLACKBOX_KIND || !isBlackboxManifestPath(grader.manifestPath) ||
      !SHA.test(grader.manifestSha256) || !Array.isArray(grader.caseIds) ||
      grader.caseIds.length < 1 || grader.caseIds.length > 64 ||
      grader.caseIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
      new Set(grader.caseIds).size !== grader.caseIds.length) throw bad('Invalid host-owned black-box request binding.');
  return Object.freeze({ ...grader, caseIds: Object.freeze([...grader.caseIds]) });
}

export function validateNativeGraderEvidence(grader) {
  if (!exactKeys(grader, ['version', 'kind', 'manifestSha256', 'cases', 'passed', 'failed', 'valid']) ||
      grader.version !== 1 || grader.kind !== NATIVE_GRADER_KIND || !SHA.test(grader.manifestSha256) ||
      !Number.isSafeInteger(grader.cases) || grader.cases < 1 || grader.cases > 64 ||
      !Number.isSafeInteger(grader.passed) || grader.passed < 0 || grader.passed > grader.cases ||
      !Number.isSafeInteger(grader.failed) || grader.failed < 0 || grader.failed > grader.cases ||
      grader.passed + grader.failed !== grader.cases || typeof grader.valid !== 'boolean') throw bad('Invalid native grader evidence.');
  return Object.freeze({ ...grader });
}
