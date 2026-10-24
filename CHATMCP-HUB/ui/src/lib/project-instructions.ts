// What the page says about the project's AGENTS.md / CLAUDE.md: the switch in Settings and the line under a turn. Plain functions, so a test can pin the words.
//
// Two rules the wording follows (docs/THREAT-MODEL.md Surface 5):
//   * "loaded" is not "followed": the Hub knows which files it put into the instructions of a run and how much of each; it does not know what a model did with them.
//     Nothing here is a proof or a verification, and nothing here is drawn with the colours of one (see proof.ts).
//   * the files are text of whoever owns the repository: they are labelled as such, and they cannot change a permission.
import type { ProjectInstructionFile, ProjectInstructionsRecord, ProjectInstructionsSetting, SkillLoadReceipt, TaskEvent } from '../types/index';

export type Lang = 'vi' | 'en';

const locale = (lang: Lang) => (lang === 'en' ? 'en-US' : 'vi-VN');

/** 842 B, 1.2 KB (vi: 1,2 KB), 8 KB. */
export function formatBytes(value: number | null | undefined, lang: Lang = 'vi'): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '–';
  const bytes = Math.round(value);
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  return `${kilobytes.toLocaleString(locale(lang), { minimumFractionDigits: kilobytes < 10 && !Number.isInteger(kilobytes) ? 1 : 0, maximumFractionDigits: kilobytes < 10 ? 1 : 0 })} KB`;
}

const grouped = (value: number, lang: Lang) => value.toLocaleString(locale(lang));

// ---- the switch in Settings -----------------------------------------------------------------------------------------------------------------

export type SwitchStatusKey = 'pi_status_unknown' | 'pi_status_default_on' | 'pi_status_config_on' | 'pi_status_config_off' | 'pi_status_env_on' | 'pi_status_env_off';

export interface SwitchView {
  /** What the checkbox shows: what applies to the next run. */
  checked: boolean;
  /** The environment variable of the Hub decides, so a click would change nothing: the checkbox is shown but cannot be used. */
  locked: boolean;
  /** Not usable: locked, or the Hub has not said what the setting is. */
  disabled: boolean;
  /** Who decided, as a translation key of i18n.ts. */
  statusKey: SwitchStatusKey;
  /** The choice the owner saved, shown only while the variable hides it. */
  hiddenChoice: boolean | null;
}

export function describeSwitch(setting: ProjectInstructionsSetting | null | undefined): SwitchView {
  if (!setting || typeof setting.enabled !== 'boolean') return { checked: false, locked: false, disabled: true, statusKey: 'pi_status_unknown', hiddenChoice: null };
  const locked = setting.source === 'env';
  const statusKey: SwitchStatusKey = locked ? (setting.enabled ? 'pi_status_env_on' : 'pi_status_env_off')
    : setting.source === 'default' ? 'pi_status_default_on'
    : setting.enabled ? 'pi_status_config_on' : 'pi_status_config_off';
  return { checked: setting.enabled, locked, disabled: locked, statusKey, hiddenChoice: locked && typeof setting.saved === 'boolean' ? setting.saved : null };
}

// ---- the line under a turn --------------------------------------------------------------------------------------------------------------------

export interface TurnView {
  /** 'files': what was loaded; 'off': the Hub did not load them for this run; 'error': it could not look. */
  kind: 'files' | 'off' | 'error';
  headline: string;
  /** One entry per file that is worth a word: name, size, and what was cut or why it was not loaded. */
  files: string[];
  /** The skills the model read on demand during this run (skill_load), with their size. */
  skills: string[];
  skillsLabel: string;
  /** The limit of what the Hub knows. */
  note: string;
}

const TEXT = {
  vi: {
    loaded: (bytes: string, cap: string) => `Hướng dẫn dự án đã nạp (${bytes} trong giới hạn ${cap})`,
    off: 'Hướng dẫn dự án: tắt',
    error: 'Hướng dẫn dự án: không đọc được thư mục workspace',
    cut: (bytes: string) => `cắt ${bytes} byte`,
    same: (name: string) => `giống ${name}`,
    notLoaded: (reason: string) => `không nạp: ${reason}`,
    skills: 'Kỹ năng đã đọc theo yêu cầu',
    cutSkill: (bytes: string) => `cắt ${bytes} byte`,
    noteLoaded: 'Văn bản không tin cậy của người viết dự án. Nạp vào chỉ dẫn không có nghĩa là model đã làm theo, và Hub không kiểm tra điều đó.',
    noteOff: 'Hub không nạp AGENTS.md hay CLAUDE.md cho lượt này; agent vẫn có thể tự mở chúng bằng công cụ đọc tệp.',
    noteError: 'Lượt này chạy mà không có hướng dẫn dự án.',
    reasons: {
      budget_exhausted: 'hết chỗ trong giới hạn byte', too_large: 'tệp quá lớn', binary: 'tệp nhị phân', not_utf8: 'không phải UTF-8', unsupported_encoding: 'mã hóa không hỗ trợ',
      outside_workspace: 'nằm ngoài workspace', protected_path: 'tệp được bảo vệ', not_file: 'không phải tệp thường', unreadable: 'không đọc được', dangling_link: 'liên kết hỏng',
    } as Record<string, string>,
    unknownReason: 'lý do không rõ',
  },
  en: {
    loaded: (bytes: string, cap: string) => `Project instructions loaded (${bytes} of a ${cap} limit)`,
    off: 'Project instructions: off',
    error: 'Project instructions: the workspace folder could not be read',
    cut: (bytes: string) => `cut ${bytes} bytes`,
    same: (name: string) => `same as ${name}`,
    notLoaded: (reason: string) => `not loaded: ${reason}`,
    skills: 'Skills read on demand',
    cutSkill: (bytes: string) => `cut ${bytes} bytes`,
    noteLoaded: "Untrusted text from whoever wrote the project. Being loaded into the instructions does not mean the model followed it, and the Hub does not check that.",
    noteOff: 'The Hub did not load AGENTS.md or CLAUDE.md for this run; the agent can still open them with its file-reading tool.',
    noteError: 'This run went ahead without project instructions.',
    reasons: {
      budget_exhausted: 'no room left in the byte limit', too_large: 'file too large', binary: 'binary file', not_utf8: 'not valid UTF-8', unsupported_encoding: 'unsupported text encoding',
      outside_workspace: 'outside the workspace', protected_path: 'protected file', not_file: 'not a regular file', unreadable: 'could not be read', dangling_link: 'broken link',
    } as Record<string, string>,
    unknownReason: 'reason unknown',
  },
} as const;

function describeFile(file: ProjectInstructionFile, lang: Lang): string | null {
  const text = TEXT[lang];
  const name = String(file.path);
  if (file.status === 'alias') return `${name} · ${text.same(String(file.aliasOf))}`;
  if (file.status === 'skipped') {
    // An empty file is nothing to report (the Hub does not list it either).
    if (file.reason === 'empty') return null;
    const reason = file.reason && Object.hasOwn(text.reasons, file.reason) ? text.reasons[file.reason] : text.unknownReason;
    return `${name} · ${text.notLoaded(reason)}`;
  }
  const size = formatBytes(file.loadedBytes, lang);
  return file.status === 'truncated' && file.cutBytes > 0 ? `${name} · ${size}, ${text.cut(grouped(file.cutBytes, lang))}` : `${name} · ${size}`;
}

/**
 * The skills the model read on demand in the LATEST run: the skill_loaded events after the last instructions_loaded event (each run records one at its start; the events
 * the page has are the newest ones, so when that event is not among them they all belong to the latest run). A skill read twice is listed once, with its last receipt.
 */
export function skillsLoadedInLatestRun(events: TaskEvent[] | null | undefined): SkillLoadReceipt[] {
  const list = Array.isArray(events) ? events : [];
  const start = list.map((event) => event?.type).lastIndexOf('instructions_loaded') + 1;
  const byId = new Map<string, SkillLoadReceipt>();
  for (const event of list.slice(start)) {
    const receipt = event?.type === 'skill_loaded' ? event.skillLoad : undefined;
    if (receipt && typeof receipt.id === 'string' && receipt.id) { byId.delete(receipt.id); byId.set(receipt.id, receipt); }
  }
  return [...byId.values()];
}

/**
 * What to say under a finished turn, or null when there is nothing to say: no record (a ChatGPT Web task, a task from before the record existed), or loading was on and
 * the workspace has no such file and the model read no skill on demand.
 */
export function describeTurn(task: { projectInstructions?: ProjectInstructionsRecord | null; events?: TaskEvent[] } | null | undefined, lang: Lang = 'vi'): TurnView | null {
  const record = task?.projectInstructions;
  if (!record || typeof record !== 'object') return null;
  const text = TEXT[lang];
  const skillReceipts = skillsLoadedInLatestRun(task?.events);
  const skills = skillReceipts.map((receipt) => {
    const size = formatBytes(receipt.loadedBytes, lang);
    return receipt.truncated && typeof receipt.cutBytes === 'number' && receipt.cutBytes > 0 ? `${receipt.id} · ${size}, ${text.cutSkill(grouped(receipt.cutBytes, lang))}` : `${receipt.id} · ${size}`;
  });
  const base = { files: [] as string[], skills, skillsLabel: text.skills };
  if (record.enabled === false) return { kind: 'off', headline: text.off, note: text.noteOff, ...base };
  if (record.error) return { kind: 'error', headline: text.error, note: text.noteError, ...base };
  const files = (Array.isArray(record.files) ? record.files : []).map((file) => describeFile(file, lang)).filter((line): line is string => line !== null);
  if (!files.length && !skills.length) return null;
  return { kind: 'files', headline: text.loaded(formatBytes(record.blockBytes, lang), formatBytes(record.maxBytes, lang)), note: text.noteLoaded, ...base, files };
}
