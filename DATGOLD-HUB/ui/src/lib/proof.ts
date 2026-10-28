// "Reported done" is not "proven done". This decides, from what the Hub recorded, which of the two a finished turn is.
// It is a plain function so a test can pin it: the failure it guards against is a green "verified" the evidence does not back.
import type { Task } from '@/types';
import { toolKind } from './tool-labels.ts';

export type RecordedCheck = { status?: string; exitCode?: number | null; testOutcomeVerified?: boolean; snapshotHash?: string };
export type ProofTone = 'success' | 'warning' | 'danger';
export type ProofKind = 'errors' | 'failed-turn' | 'accepted' | 'checks-verified' | 'incomplete' | 'unverified-run' | 'no-evidence';

export interface Proof {
  tone: ProofTone;
  kind: ProofKind;
  title: string;
  note: string;
  chips: string[];
  /** Whether the Hub recorded anything that the evidence tab can show for this turn: false for a turn that failed before any tool or check did. */
  evidence: boolean;
}

const REASON_LIMIT = 240;
const cut = (text: string) => (text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT).trimEnd()}…` : text);

/**
 * What the Hub recorded about a finished turn: tone, words and the facts behind them.
 *
 * `verificationOutcome.ready` is NOT evidence: the Hub also reports it as true when no verification was required at all
 * ("No complex task graph required"). The only things that turn the strip green are a check whose outcome the Hub itself
 * verified, or objectives the owner accepted against fresh receipts. A model's reply never does.
 */
export function assessProof(
  task: Pick<Task, 'status' | 'toolCalls' | 'verificationOutcome' | 'completionOutcome' | 'error'>,
  runs: RecordedCheck[],
  vi: boolean,
): Proof | null {
  const calls = task.toolCalls || [];
  const edits = calls.filter(call => toolKind(call.name) === 'edit' && call.status === 'success').length;
  const commands = calls.filter(call => toolKind(call.name) === 'run').length;
  const toolErrors = calls.filter(call => call.status === 'error').length;
  const verified = runs.filter(run => run.testOutcomeVerified === true).length;
  const failed = runs.filter(run => run.status === 'failed' || (typeof run.exitCode === 'number' && run.exitCode !== 0)).length;
  const passedUnverified = runs.filter(run => run.status === 'completed' && run.exitCode === 0 && run.testOutcomeVerified !== true).length;
  const accepted = task.completionOutcome?.requirements === 'verified';
  const outcome = task.verificationOutcome;
  const snapshot = [...runs].reverse().find(run => run.snapshotHash)?.snapshotHash;

  const chips = [
    edits > 0 && (vi ? `${edits} tệp đã sửa` : `${edits} file${edits > 1 ? 's' : ''} changed`),
    commands > 0 && (vi ? `${commands} lệnh đã chạy` : `${commands} command${commands > 1 ? 's' : ''} run`),
    verified > 0 && (vi ? `${verified} kiểm tra đã xác minh` : `${verified} check${verified > 1 ? 's' : ''} verified`),
    snapshot && (vi ? `bản chụp ${snapshot.slice(0, 8)}` : `snapshot ${snapshot.slice(0, 8)}`),
  ].filter(Boolean) as string[];

  // Nothing to prove: a turn that only read and answered.
  if (!edits && !commands && !toolErrors && !runs.length && task.status !== 'failed' && outcome?.ready !== false) return null;

  if (toolErrors > 0 || failed > 0) {
    return {
      tone: 'danger', kind: 'errors', chips, evidence: true,
      title: vi ? 'Có lỗi trong lượt này' : 'Errors in this turn',
      note: vi ? 'Một hoặc nhiều công cụ hay kiểm tra báo lỗi. Xem kết quả từng mục trước khi tin vào phản hồi.' : 'One or more tools or checks reported an error. Read each result before trusting the reply.',
    };
  }
  if (task.status === 'failed') {
    // The turn stopped on an error of its own (the request to the model, the connection, a limit) and no tool or check was in error: there is no evidence to look at, and the words about
    // tools and checks would be false. The reason is the one the Hub recorded.
    const reason = (task.error || '').trim();
    return {
      tone: 'danger', kind: 'failed-turn', chips, evidence: false,
      title: vi ? 'Lượt này dừng vì lỗi, chưa có gì được xác minh' : 'This turn stopped on an error; nothing was verified',
      note: reason
        ? (vi ? `Lý do Hub ghi nhận: ${cut(reason)}` : `The reason the Hub recorded: ${cut(reason)}`)
        : (vi ? 'Lượt dừng trước khi Hub ghi nhận kiểm tra nào. Chưa có gì được xác minh.' : 'The turn stopped before the Hub recorded any check. Nothing was verified.'),
    };
  }
  if (accepted) {
    return {
      tone: 'success', kind: 'accepted', chips, evidence: true,
      title: vi ? 'Đã nghiệm thu' : 'Accepted',
      note: vi ? 'Bạn đã xác nhận các tiêu chí bằng bằng chứng còn mới do Hub ghi nhận.' : 'You accepted the criteria against fresh evidence recorded by the Hub.',
    };
  }
  if (verified > 0 && outcome?.ready !== false) {
    return {
      tone: 'success', kind: 'checks-verified', chips, evidence: true,
      title: vi ? 'Kiểm tra đã được xác minh' : 'Checks verified',
      note: vi ? 'Hub tự ghi nhận kết quả kiểm tra, độc lập với phản hồi của model. Việc này chưa chứng minh mọi yêu cầu đã đạt: hãy xem diff và kết quả.' : 'The Hub recorded the check results itself, independent of the model’s reply. That does not prove every requirement is met: read the diff and the results.',
    };
  }
  if (outcome?.ready === false) {
    return {
      tone: 'warning', kind: 'incomplete', chips, evidence: true,
      title: vi ? 'Chưa xác minh đầy đủ' : 'Not fully verified',
      note: outcome.missing?.length ? outcome.missing.join('; ') : (vi ? 'Còn thiếu bằng chứng kiểm tra.' : 'Some check evidence is missing.'),
    };
  }
  if (passedUnverified > 0) {
    return {
      tone: 'warning', kind: 'unverified-run', chips, evidence: true,
      title: vi ? 'Lệnh chạy xong, chưa xác minh kết quả test' : 'Command succeeded, test outcome not verified',
      note: vi ? 'Mã thoát 0 chưa phải bằng chứng test đã đạt. Xem kết quả kiểm tra ở tab Tiến độ.' : 'Exit code 0 is not proof that the tests passed. See the check results in the Progress tab.',
    };
  }
  return {
    tone: 'warning', kind: 'no-evidence', chips, evidence: true,
    title: vi ? 'Chưa có bằng chứng kiểm tra được ghi nhận' : 'No recorded check evidence',
    note: vi
      ? 'Hub chưa ghi nhận kiểm tra nào để xác minh lượt này. Phản hồi của model không phải bằng chứng: hãy xem diff và chạy kiểm thử.'
      : 'The Hub has not recorded any check to verify this turn. The model’s reply is not evidence: read the diff and run the tests.',
  };
}
