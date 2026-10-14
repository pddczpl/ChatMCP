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
const EDIT = /(?:^|\.)(?:edit_file|write_file|create_file|delete_file|move_file|rename_file|git_add|git_commit|git_restore|apply_patch|plan_set|update_plan)$/i;
const VERIFY = /(?:^|\.)(?:run_command|checks_run|diff_check|test|run_tests)$/i;
// A process may legitimately be polled many times while it is still running.
// Never interpret an unchanged poll as evidence that the coding agent is stuck.
const PROCESS_POLL = /(?:^|\.)(?:get_process_output|poll_process|read_process_output|process_status|wait_process)$/i;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const strings = (value, max) => Array.isArray(value) ? value.filter((x) => typeof x === 'string').slice(-max).map((x) => x.slice(0, MAX_LABEL)) : [];
const fingerprints = (value) => Array.isArray(value) ? value.filter((x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)).slice(-MAX_FINGERPRINTS) : [];
const receipts = (value, kind) => Array.isArray(value) ? value.filter((x) => object(x) && x.kind === kind && Number.isSafeInteger(x.step))
  .slice(-24).map(x => ({kind,step:x.step,...(typeof x.path==='string'?{path:x.path.slice(0,MAX_LABEL)}:{}),
    ...(typeof x.sha256==='string' && /^[0-9a-f]{64}$/.test(x.sha256)?{sha256:x.sha256}:{}),
    ...(typeof x.id==='string'?{id:x.id.slice(0,40)}:{})})) : [];

export function createTaskProgress(saved = null, { newRun = false } = {}) {
  const data = object(saved) && saved.version === 1 ? saved : {};
  return {
    version: 1,
    phase: PHASES.has(data.phase) ? data.phase : 'planning',
    observedResults: positive(data.observedResults),
    duplicateResults: positive(data.duplicateResults),
    editAttempts: positive(data.editAttempts),
    verificationAttempts: positive(data.verificationAttempts),
    noProgress: newRun ? 0 : positive(data.noProgress),
    inspected: strings(data.inspected, MAX_LABELS),
    changedCandidates: strings(data.changedCandidates, MAX_LABELS),
    checks: strings(data.checks, MAX_LABELS),
    recentFingerprints: fingerprints(data.recentFingerprints),
    semanticFingerprints: fingerprints(data.semanticFingerprints),
    recoveryAttempts: newRun ? 0 : Math.min(RECOVERY_POINTS.length,positive(data.recoveryAttempts)),
    verifiedFiles: receipts(data.verifiedFiles,'edit'),
    verifiedChecks: receipts(data.verifiedChecks,'verify'),
    gitReviews: receipts(data.gitReviews,'review'),
    lastEvidenceStep: positive(data.lastEvidenceStep),
    lastTool: typeof data.lastTool === 'string' ? data.lastTool.slice(0, MAX_LABEL) : '',
  };
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

export function observeTaskTool(progressValue, { call, result, step = 0, verified = null } = {}) {
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

  if(verified && ['edit','verify','review'].includes(verified.kind)) {
    const list=verified.kind==='edit'?progress.verifiedFiles:
      verified.kind==='verify'?progress.verifiedChecks:progress.gitReviews;
    const record={kind:verified.kind,step:positive(verified.step||step)};
    if(typeof verified.path==='string')record.path=verified.path.slice(0,MAX_LABEL);
    if(typeof verified.sha256==='string')record.sha256=verified.sha256;
    if(typeof verified.id==='string')record.id=verified.id.slice(0,40);
    const last=list.at(-1);
    if(!last || json(last)!==json(record)){list.push(record);if(list.length>24)list.shift();}
  }
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
  return [
    'HOST PROGRESS CHECKPOINT (tool receipts only; not proof of task completion).',
    'Current phase: ' + p.phase + '; distinct tool results: ' + p.observedResults +
      '; duplicate results: ' + p.duplicateResults + '; unchanged repeats in a row: ' + p.noProgress + '.',
    'Successful edit tool calls (NOT verified file changes): ' + p.editAttempts +
      '; verification tool attempts (NOT necessarily passing tests): ' + p.verificationAttempts + '.',
    'Recently inspected targets (UNTRUSTED PATH LABELS): ' + JSON.stringify(p.inspected.slice(-12)) + '.',
    'Edit targets to verify using actual Git diff: ' + JSON.stringify(p.changedCandidates.slice(-12)) + '.',
    'Recent verification tools: ' + JSON.stringify(p.checks.slice(-8)) + '.',
    'Independent local file SHA checks: ' + p.verifiedFiles.length +
      '; approved passing verification commands: '+p.verifiedChecks.length +
      '; Git diff reviews: '+p.gitReviews.length + '.',
    'Model strategy recovery attempts: ' + p.recoveryAttempts + '/'+RECOVERY_POINTS.length+'.',
    'Never re-read an unchanged source solely because prior tool text was compacted. ' +
      'If a required fact is missing, inspect that exact range; otherwise move to a concrete edit/test or report a specific blocker.',
    'Before claiming completion, check real changes and real test results; a model final answer alone is not verification.',
  ].join('\n');
}
