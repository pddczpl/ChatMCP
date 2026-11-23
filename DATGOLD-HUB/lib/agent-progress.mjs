// Host-owned progress evidence for long-running agent tasks.
// This is not a task-success oracle: a successful tool response does not prove
// the user's objective is complete. Only bounded hashes/labels are persisted.
import { createHash } from 'node:crypto';
import { RECOVERY_POINTS, isRoutinePoll } from './agent-autonomy.mjs';

export const NO_PROGRESS_WARNING = 4;
export const NO_PROGRESS_LIMIT = 10;
const MAX_FINGERPRINTS = 80;
const MAX_LABELS = 24;
const MAX_LABEL = 160;
const PHASES = new Set(['planning', 'inspecting', 'editing', 'verifying', 'working']);
const INSPECTION = /(?:^|\.)(?:mcp_catalog|mcp_describe|mcp_capabilities|read_file|read_multiple_files|list_directory|list_files|find_files|search_files|search|tree|file|git_status|git_diff|git_log|plan_get|checks_list|list_tools)$/i;
const EDIT = /(?:^|\.)(?:edit_file|write_file|files_write_batch|create_file|delete_file|move_file|rename_file|git_add|git_commit|git_restore|apply_patch|files_apply_patch|plan_set|update_plan)$/i;
// Receipts are bound to the workspace tree they were made on (plan task pod-18, docs/PROOF-RECEIPTS.md). The trees come from the proof service at the guard seam
// (lib/proof/service.mjs): every allowed call of a category that can change files has a snapshot before and after it, whatever the tool is called, so no list of
// tool names decides what makes a receipt stale. A receipt is FRESH while its tree is the latest tree the Hub knows (`progress.tree`), STALE once that tree differs,
// and of UNKNOWN freshness when either tree is not known (checks-only, the service disabled, a snapshot that failed, a task saved before receipts had trees).
// Unknown is never fresh. verifiedInspections, verifiedFiles, verifiedChecks and gitReviews are the fresh receipts of each kind, made again from `receipts`.
export const FRESHNESS = Object.freeze({ fresh: 'fresh', stale: 'stale', unknown: 'unknown' });
const KINDS = Object.freeze({ inspect: 'verifiedInspections', edit: 'verifiedFiles', verify: 'verifiedChecks', review: 'gitReviews' });
const RECEIPTS_PER_KIND = 24;
const TREE_KEY = /^[a-z0-9-]{1,32}:(?:sha1|sha256):[0-9a-f]{40,64}$/;
/** The key a tree is compared by: its algorithm, object format and id (two ids compare only within one algorithm, docs/PROOF-TREE.md); null without a tree. */
export function treeKey(ids) {
  if (!object(ids) || typeof ids.tree !== 'string' || !/^[0-9a-f]{40,64}$/.test(ids.tree) || typeof ids.treeAlgorithm !== 'string') return null;
  const key = `${ids.treeAlgorithm}:${ids.objectFormat}:${ids.tree}`;
  return TREE_KEY.test(key) ? key : null;
}
const keyOf = (value) => (typeof value === 'string' && TREE_KEY.test(value) ? value : null);
/** fresh, stale or unknown: a receipt judged against the tree `tree` (a tree key, or null when it is not known). */
export function receiptFreshness(receipt, tree) {
  const own = keyOf(receipt?.tree);
  const current = keyOf(tree);
  if (!own || !current) return FRESHNESS.unknown;
  return own === current ? FRESHNESS.fresh : FRESHNESS.stale;
}
const VERIFY = /(?:^|\.)(?:run_command|checks_run|diff_check|test|run_tests)$/i;
// A process may legitimately be polled many times while it is still running.
// Never interpret an unchanged poll as evidence that the coding agent is stuck.
const PROCESS_POLL = /(?:^|\.)(?:get_process_output|poll_process|read_process_output|process_status|wait_process)$/i;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const strings = (value, max) => Array.isArray(value) ? value.filter((x) => typeof x === 'string').slice(-max).map((x) => x.slice(0, MAX_LABEL)) : [];
const fingerprints = (value) => Array.isArray(value) ? value.filter((x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)).slice(-MAX_FINGERPRINTS) : [];
/** One receipt as it is kept: its kind and step, what names it (path, sha256, id) and the tree it was made on (a tree key, or null when unknown). */
function receipt(value, kind = value?.kind) {
  if (!object(value) || !Object.hasOwn(KINDS, kind) || !Number.isSafeInteger(value.step) || value.step < 0) return null;
  return {
    kind, step: value.step,
    ...(typeof value.path === 'string' ? { path: value.path.slice(0, MAX_LABEL) } : {}),
    ...(typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) ? { sha256: value.sha256 } : {}),
    ...(typeof value.id === 'string' ? { id: value.id.slice(0, 40) } : {}),
    tree: keyOf(value.tree),
  };
}
/** The last RECEIPTS_PER_KIND receipts of each kind, in the order they were made. */
function bounded(list) {
  const counts = {};
  const kept = [];
  for (let at = list.length - 1; at >= 0; at--) {
    const item = list[at];
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    if (counts[item.kind] <= RECEIPTS_PER_KIND) kept.unshift(item);
  }
  return kept;
}
/**
 * The receipts of saved progress: its `receipts`, or, for progress saved before receipts had trees, the four lists it kept then, each receipt without a tree
 * (freshness unknown). The four lists of progress that has `receipts` are projections and are never read back.
 */
function savedReceipts(data) {
  if (Array.isArray(data.receipts)) return bounded(data.receipts.map((item) => receipt(item)).filter(Boolean));
  const old = Object.entries(KINDS).flatMap(([kind, bucket]) => (Array.isArray(data[bucket]) ? data[bucket] : [])
    .filter((item) => object(item) && item.kind === kind).map((item) => receipt({ ...item, tree: null }, kind)).filter(Boolean));
  return bounded(old.sort((x, y) => x.step - y.step));
}
/** The four lists of fresh receipts, made from `receipts` and `tree`. Mutates and returns `progress`. */
function project(progress) {
  for (const [kind, bucket] of Object.entries(KINDS)) {
    progress[bucket] = progress.receipts.filter((item) => item.kind === kind && receiptFreshness(item, progress.tree) === FRESHNESS.fresh);
  }
  return progress;
}
/** How many receipts are fresh, stale and of unknown freshness, and whether the Hub knows the current tree (never the tree itself). */
export function receiptSummary(progressValue, { tree } = {}) {
  const progress = createTaskProgress(progressValue);
  const current = tree === undefined ? progress.tree : keyOf(tree);
  const summary = { tree: current !== null, fresh: 0, stale: 0, unknown: 0 };
  for (const item of progress.receipts) summary[receiptFreshness(item, current)] += 1;
  return summary;
}

export function createTaskProgress(saved = null, { newRun = false } = {}) {
  const data = object(saved) && saved.version === 1 ? saved : {};
  return project({
    version: 1,
    phase: PHASES.has(data.phase) ? data.phase : 'planning',
    observedResults: positive(data.observedResults),
    duplicateResults: positive(data.duplicateResults),
    editAttempts: positive(data.editAttempts),
    verificationAttempts: positive(data.verificationAttempts),
    checksChangedTree: positive(data.checksChangedTree),
    noProgress: newRun ? 0 : positive(data.noProgress),
    inspected: strings(data.inspected, MAX_LABELS),
    changedCandidates: strings(data.changedCandidates, MAX_LABELS),
    checks: strings(data.checks, MAX_LABELS),
    recentFingerprints: fingerprints(data.recentFingerprints),
    semanticFingerprints: fingerprints(data.semanticFingerprints),
    recoveryAttempts: newRun ? 0 : Math.min(RECOVERY_POINTS.length,positive(data.recoveryAttempts)),
    // The latest tree the Hub knows. A new run does not know it until its start tree is given (observeTree): the files may have changed between runs.
    tree: newRun ? null : keyOf(data.tree),
    receipts: savedReceipts(data),
    lastEvidenceStep: positive(data.lastEvidenceStep),
    lastTool: typeof data.lastTool === 'string' ? data.lastTool.slice(0, MAX_LABEL) : '',
  });
}

/** The progress with `ids` (a tree reference's ids, e.g. a run's start tree) as the current tree; a reference without a tree makes it unknown. */
export function observeTree(progressValue, ids) {
  const progress = createTaskProgress(progressValue);
  progress.tree = treeKey(ids);
  return project(progress);
}


function json(value) {
  // Stable keys avoid mistaking a reordered argument object for new work.
  if (Array.isArray(value)) return '[' + value.map(json).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + json(value[k])).join(',') + '}';
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

export function callIdentity(call) {
  let args = {};
  try { args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments ?? {}; }
  catch { args = {}; }
  if (!object(args)) args = {};
  let name = String(call?.name ?? 'unknown');
  if (name === 'mcp_call' && typeof args.name === 'string') {
    name = args.name;
    try { args = typeof args.arguments_json === 'string' ? JSON.parse(args.arguments_json) : {}; }
    catch { args = {}; }
    if (!object(args)) args = {};
  }
  return { name: name.slice(0, MAX_LABEL), args };
}

function label(args, name) {
  const value = ['path', 'file', 'filePath', 'file_path', 'directory', 'query', 'command', 'name']
    .map((key) => args[key]).find((entry) => typeof entry === 'string' && entry.length);
  // These are UNTRUSTED path/argument labels. Never store file/tool output.
  return String(value ?? name).replace(/[\r\n\t]/g, ' ').slice(0, MAX_LABEL);
}

function remember(list, value) {
  if (!list.includes(value)) list.push(value);
  if (list.length > MAX_LABELS) list.splice(0, list.length - MAX_LABELS);
}

function semanticIdentity(name,args,result,category) {
  if(category!=='inspecting')return null;
  const family = /(?:^|\.)(?:read_file|read_multiple_files|file|file_info)$/.test(name) ? 'read' :
    /(?:^|\.)(?:find_files|search_files|symbols_search|symbols_references|search)$/.test(name) ? 'search' :
    /(?:^|\.)(?:list_directory|list_files|tree)$/.test(name) ? 'list' : 'other';
  // Paths are stable across synonyms (read_file vs file_info, search vs find).
  const scope=String(args.path||args.file||args.filePath||args.file_path||args.directory||args.cwd||'').replaceAll('\\','/').toLowerCase();
  const meta=result?.structuredContent;
  // Distinct ranges of a large file count as new inspection evidence; repeated
  // ranges of unchanged file SHA do not, even if the model uses another tool.
  const span=meta && typeof meta.sha256==='string' && /^[a-f0-9]{64}$/i.test(meta.sha256)
    ? meta.sha256+':'+String(meta.start??'')+':'+String(meta.end??'') : sha(json(result));
  return sha(family+'\0'+scope+'\0'+span);
}

export function observeTaskTool(progressValue, { call, result, step = 0, verified = null, proof = null, scanned = false } = {}) {
  const progress = createTaskProgress(progressValue);
  const { name, args } = callIdentity(call);
  const category = INSPECTION.test(name) ? 'inspecting'
    : EDIT.test(name) ? 'editing'
      : VERIFY.test(name) ? 'verifying' : 'working';
  const failed = result?.isError === true || result?.executed === false;
  const monitored = !PROCESS_POLL.test(name) && !isRoutinePoll(name);
  const key = monitored ? sha(name + '\0' + json(args) + '\0' + sha(json(result))) : null;
  const semanticKey = monitored ? semanticIdentity(name,args,result,category) : null;
  const repeated = monitored && (progress.recentFingerprints.includes(key) ||
    (semanticKey !== null && progress.semanticFingerprints.includes(semanticKey)));
  const itemLabel = label(args, name);

  // The current tree after this call. `proof` is what the guard's onProof told the caller about this call (its trees, lib/proof/service.mjs): the tree after the call
  // is the latest tree the Hub knows, whatever the tool is and whatever it returned. A call of a category that can change files (`scanned`) that ran without trees
  // (checks-only, the service disabled or halted) leaves the tree unknown: it may have changed. A call that never ran, and a read, leave it as it was. A change made
  // outside a scanned call (an external server the owner did not flag, the person's own editor) shows in the tree before the next scanned call, so in the tree after it.
  if (proof) {
    const before = treeKey(proof.treeBefore);
    const after = treeKey(proof.treeAfter);
    if (category === 'verifying' && before !== null && after !== null && before !== after) progress.checksChangedTree += 1;
    progress.tree = after;
  } else if (scanned === true && result?.executed !== false) {
    progress.tree = null;
  }

  progress.lastTool = name;
  progress.phase = category;
  if (category === 'editing' && !failed) {
    progress.editAttempts += 1;
    remember(progress.changedCandidates, itemLabel);
  } else if (category === 'verifying') {
    progress.verificationAttempts += 1;
    remember(progress.checks, name);
  }
  if (!failed && category === 'inspecting') remember(progress.inspected, itemLabel);

  if(verified && Object.hasOwn(KINDS,verified.kind)) {
    // One call can verify several files (files_write_batch): `more` carries the receipts after the first, all made on the same tree.
    const items=[verified,...(verified.kind==='edit'&&Array.isArray(verified.more)?verified.more.slice(0,49).map(item=>({...item,kind:'edit',step:verified.step,tree:verified.tree})):[])];
    for(const item of items){
      // The tree is the one verifyHostEvidence bound the receipt to (lib/agent-autonomy.mjs); a value that is not a tree key is unknown.
      const record=receipt({...item,step:positive(item.step||step)},verified.kind);
      if(!record)continue;
      const last=progress.receipts.findLast(entry=>entry.kind===record.kind);
      if(!last || json(last)!==json(record))progress.receipts.push(record);
    }
    progress.receipts=bounded(progress.receipts);
  }
  project(progress);
  // An unchanged read or rerun is not new goal progress, even if the
  // first-party host can prove the file/test result is authentic.
  if (repeated) {
    progress.duplicateResults += 1;
    progress.noProgress += 1;
  } else if(monitored || verified) {
    progress.noProgress = 0;
  }
  if(monitored && !progress.recentFingerprints.includes(key)){
    progress.observedResults += 1;
    progress.recentFingerprints.push(key);
    if (progress.recentFingerprints.length > MAX_FINGERPRINTS)progress.recentFingerprints.shift();
    progress.lastEvidenceStep = positive(step);
  }
  if(semanticKey && !progress.semanticFingerprints.includes(semanticKey)){
    progress.semanticFingerprints.push(semanticKey);
    if(progress.semanticFingerprints.length>MAX_FINGERPRINTS)progress.semanticFingerprints.shift();
  }
  const recovery=RECOVERY_POINTS.indexOf(progress.noProgress);
  const newRecovery=recovery!==-1 && progress.recoveryAttempts<recovery+1;
  if(newRecovery)progress.recoveryAttempts=recovery+1;
  return {
    progress,
    repeated,
    verified:verified?.kind??null,
    recover:newRecovery?recovery+1:0,
    warning: progress.noProgress === NO_PROGRESS_WARNING,
    stalled: progress.noProgress >= NO_PROGRESS_LIMIT,
  };
}

export function progressCheckpoint(saved) {
  const p = createTaskProgress(saved);
  const summary = receiptSummary(p);
  return [
    'HOST PROGRESS CHECKPOINT (tool receipts only; not proof of task completion).',
    'Current phase: ' + p.phase + '; distinct tool results: ' + p.observedResults +
      '; duplicate results: ' + p.duplicateResults + '; unchanged repeats in a row: ' + p.noProgress + '.',
    'Successful edit tool calls (NOT verified file changes): ' + p.editAttempts +
      '; verification tool attempts (NOT necessarily passing tests): ' + p.verificationAttempts + '.',
    'Recently inspected targets (UNTRUSTED PATH LABELS): ' + JSON.stringify(p.inspected.slice(-12)) + '.',
    'Edit targets to verify using actual Git diff: ' + JSON.stringify(p.changedCandidates.slice(-12)) + '.',
    'Recent verification tools: ' + JSON.stringify(p.checks.slice(-8)) + '.',
    // Counts only: a tree id never reaches the model (docs/PROOF-SERVICE.md).
    'Host receipts by the workspace tree they were made on: fresh on the latest tree: ' + summary.fresh + '; stale: ' + summary.stale +
      '; freshness unknown: ' + summary.unknown + (summary.tree ? '' : ' (the Hub does not know the current tree)') +
      '; passing checks that changed the files they checked: ' + p.checksChangedTree + '.\n' +
    'Fresh independent local file SHA checks: ' + p.verifiedFiles.length +
      '; approved passing verification commands: '+p.verifiedChecks.length +
      '; Git diff reviews: '+p.gitReviews.length + '.',
    'Model strategy recovery attempts: ' + p.recoveryAttempts + '/'+RECOVERY_POINTS.length+'.',
    'Never re-read an unchanged source solely because prior tool text was compacted. ' +
      'If a required fact is missing, inspect that exact range; otherwise move to a concrete edit/test or report a specific blocker.',
    'Before claiming completion, check real changes and real test results; a model final answer alone is not verification.',
  ].join('\n');
}
