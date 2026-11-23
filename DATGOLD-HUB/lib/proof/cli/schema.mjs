// The JSON Schemas of what `chatmcp verify --json` prints (docs/PROOF-CLI.md, "JSON answers"): one envelope for every answer, and the
// `data` of each command. They use only the keywords of ./../schema-validate.mjs, so the suite validates every answer it gets with them.
import { CLI_FORMAT, CODES, COMMANDS, EXIT } from './codes.mjs';

const HEX64 = '^[0-9a-f]{64}$';
const GIT_ID = '^(?:[0-9a-f]{40}|[0-9a-f]{64})$';
const deepFreeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const closed = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const text = (maxLength = 4096) => ({ type: 'string', maxLength });
const nullable = (schema) => ({ oneOf: [{ type: 'null' }, schema] });
const count = { type: 'integer', minimum: 0 };
const hex64 = { type: 'string', pattern: HEX64 };
const gitId = { type: 'string', pattern: GIT_ID };
const flag = { type: 'boolean' };
const list = (items, maxItems = 1000) => ({ type: 'array', items, maxItems });

const acceptanceState = closed({ present: flag, sha256: nullable(hex64), trusted: flag });
const paths = closed({ session: text(), ledger: text(), baseline: text(), acceptanceCopy: nullable(text()) });
const stream = closed({ sha256: hex64, bytes: count, truncated: flag, preview: text(8192), previewTruncated: flag });
const baselineSummary = closed({
  id: text(64), createdAt: text(64), sha256: hex64, verifiedAgainst: { enum: ['anchor', 'self'] }, treeAlgorithm: text(32), objectFormat: { enum: ['sha1', 'sha256'] },
  tree: gitId, files: count, bytes: count, repository: flag, patchAvailable: flag, patchReason: nullable(text(64)),
});

/** The envelope of every answer. */
export const CLI_OUTPUT_SCHEMA = deepFreeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: CLI_FORMAT,
  title: 'An answer of chatmcp verify --json',
  ...closed({
    format: { const: CLI_FORMAT },
    command: { enum: [...COMMANDS, 'help', 'version', null] },
    exitCode: { enum: Object.values(EXIT) },
    outcome: { enum: Object.keys(EXIT) },
    code: { enum: Object.keys(CODES) },
    message: { type: 'string', minLength: 1, maxLength: 8192 },
    lang: { enum: ['en', 'vi'] },
    workspace: nullable(text()),
    data: { type: ['object', 'null'] },
    detail: { oneOf: [{ type: 'null' }, { type: 'object', maxProperties: 12 }] },
  }),
});

/** The `data` of each command, when the command got as far as its result. */
export const CLI_DATA_SCHEMAS = deepFreeze({
  help: closed({ topic: nullable({ enum: COMMANDS }), usage: text(16384) }),
  version: closed({ version: text(64) }),
  init: closed({
    file: { const: '.chatmcp/acceptance.yml' }, written: flag, sha256: hex64, criteria: count, checks: list(text()),
    skipped: list(closed({ command: text(), from: text(), reason: text(128) })), text: text(65536),
  }),
  trust: closed({
    file: { const: '.chatmcp/acceptance.yml' }, sha256: hex64, trusted: flag, approvedBy: nullable(text(256)), at: nullable(text(64)),
    checks: list(closed({ criterion: text(128), run: text(), cwd: text() })), manual: list(text(128)), trustCommand: nullable(text()),
  }),
  snapshot: closed({
    taskId: text(160), baselineId: text(64), baselineSha256: hex64, createdAt: text(64), treeAlgorithm: text(32), objectFormat: { enum: ['sha1', 'sha256'] },
    tree: gitId, files: count, bytes: count, repository: flag, patchAvailable: flag, patchReason: nullable(text(64)), acceptance: acceptanceState, paths,
  }),
  run: closed({
    taskId: text(160), command: text(8192), shell: { enum: ['bash', 'sh', 'powershell'] }, cwd: text(),
    receipt: closed({
      seq: { type: 'integer', minimum: 1 }, hash: hex64, commandSha256: hex64, argsSha256: hex64, exit: nullable({ type: 'integer' }), signal: nullable(text(32)),
      timedOut: flag, cancelled: flag, durationMs: count, passed: flag, stdout: stream, stderr: stream, treeBefore: nullable(gitId), treeAfter: nullable(gitId),
    }),
  }),
  show: closed({
    taskId: text(160), baseline: baselineSummary,
    ledger: closed({ records: count, verified: flag, checks: count, lastHash: hex64 }),
    acceptance: closed({ baseline: acceptanceState, current: closed({ present: flag, sha256: nullable(hex64), trusted: flag, changed: flag }) }),
    receipts: list(closed({ seq: { type: 'integer', minimum: 1 }, ts: text(64), command: text(8192), cwd: text(), shell: text(32), exit: nullable({ type: 'integer' }), passed: flag, treeBefore: nullable(gitId) }), 50),
    receiptsOmitted: count, paths,
  }),
  pack: closed({
    taskId: text(160), file: text(), digest: hex64, statement: { type: 'object' },
    criteria: list(closed({ id: text(128), status: { enum: ['evidenced', 'owner_accepted', 'unverified', 'failed', 'stale', 'checks_modified'] } })),
    changes: closed({ added: count, modified: count, deleted: count }), receipts: count,
  }),
});
