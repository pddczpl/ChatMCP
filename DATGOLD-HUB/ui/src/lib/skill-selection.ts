// What the page says under a finished turn about the skills the Hub took for it: which, and on what grounds, or why none. Plain functions, so a test can pin the words.
//
// The Hub chooses skills by keywords in the request (and a short table of Vietnamese phrases) and by the kind of project, so this line is a record of what it did and why, never
// a verdict: a skill that was taken is not a skill that was followed, and one that was not taken may still have been the right one. It is drawn with the neutral tokens of
// the project-instructions line, never in the colours of the evidence strip (see proof.ts). The strings of the record come from skills and project files: they are shown as
// text only (React escapes them) and cut to a few entries.
import type { SkillSelectionRecord, SkillSelectionWhy } from '../types/index';

export type Lang = 'vi' | 'en';

export interface SkillLine {
  id: string;
  name: string;
  /** Why the Hub took it, one phrase per ground. */
  reasons: string[];
}

export interface SkillSelectionView {
  /** 'selected': skills were taken; 'none': nothing reached the threshold; 'off': no skill is turned on; 'empty': there was no request to read. */
  kind: 'selected' | 'none' | 'off' | 'empty';
  headline: string;
  skills: SkillLine[];
  /** The skill closest to the threshold, when nothing was taken and one came near. */
  nearest: string | null;
  /** What the Hub saw of the project, when that explains a choice. */
  project: string | null;
  /** What the model itself is told: the other skills that are turned on, which it reads with skill_load. */
  catalog: string | null;
  note: string;
}

const MAX_SKILLS = 8;
const MAX_PROJECT = 8;
const MAX_REASONS = 6;

const TEXT = {
  vi: {
    selected: (n: number) => `Kỹ năng Hub nạp sẵn cho lượt này: ${n}`,
    none: 'Hub không nạp sẵn kỹ năng nào cho lượt này',
    off: 'Chưa bật kỹ năng nào',
    empty: 'Không có yêu cầu nào để chọn kỹ năng',
    noteSelected: 'Hub nạp sẵn theo từ khóa trong yêu cầu và theo loại dự án. Nạp kỹ năng vào không có nghĩa là model đã làm theo, và Hub không kiểm tra điều đó.',
    noteNone: (considered: number, threshold: number) => `Yêu cầu không nhắc tới việc nào của ${considered} kỹ năng đang bật (cần đạt ${threshold} điểm khớp). Hub chọn theo từ khóa và chỉ hiểu một số cụm tiếng Việt thường gặp, nên có thể bỏ sót; hãy nhắc tên công cụ (Docker, pytest, commit…) hoặc bật kỹ năng trong phần Kỹ năng.`,
    catalog: (listed: number, omitted: number, names: boolean) => `Model còn thấy ${names ? 'tên' : 'tên và mô tả'} của ${listed} kỹ năng khác đang bật${omitted ? ` (còn ${omitted} kỹ năng nữa không đủ chỗ để nêu tên)` : ''} và tự đọc khi cần bằng skill_load; kỹ năng nó đã đọc hiện ở dòng “Kỹ năng đã đọc theo yêu cầu”.`,
    noteNoneCatalog: (considered: number, threshold: number, listed: number, omitted: number, names: boolean) => `Từ khóa trong yêu cầu không khớp kỹ năng nào trong ${considered} kỹ năng đang bật (cần đạt ${threshold} điểm khớp). Model vẫn thấy ${names ? 'tên' : 'tên và mô tả'} của ${listed} kỹ năng${omitted ? ` (còn ${omitted} kỹ năng nữa không đủ chỗ để nêu tên)` : ''} và tự đọc cái cần bằng skill_load, dựa trên cuộc trò chuyện và các tệp nó đã xem; kỹ năng nó đã đọc hiện ở dòng “Kỹ năng đã đọc theo yêu cầu”.`,
    noteOff: 'Không có kỹ năng nào đang bật nên Hub không có gì để chọn. Bật hoặc cài kỹ năng trong phần Kỹ năng.',
    noteEmpty: 'Lượt này không có nội dung yêu cầu để so với các kỹ năng.',
    nearest: (name: string, score: number, threshold: number) => `Gần nhất: ${name} (${score}/${threshold} điểm)`,
    project: (labels: string) => `Hub thấy dự án có: ${labels}`,
    noProject: 'Hub chưa nhận ra loại dự án từ các tệp ở thư mục gốc.',
    named: (word: string) => `nhắc tới “${word}”`,
    read: (phrase: string, word: string) => `“${phrase}” → ${word}`,
    description: (words: string) => `từ trong mô tả: ${words}`,
    inProject: (label: string) => `dự án có ${label}`,
    earlier: 'từ tin nhắn trước',
  },
  en: {
    selected: (n: number) => `Skills the Hub preloaded for this turn: ${n}`,
    none: 'The Hub preloaded no skill for this turn',
    off: 'No skill is turned on',
    empty: 'No request to choose skills for',
    noteSelected: 'The Hub preloads by keywords in the request and by the kind of project. A skill being loaded does not mean the model followed it, and the Hub does not check that.',
    noteNone: (considered: number, threshold: number) => `The request does not mention anything that the ${considered} skills turned on are about (a match needs ${threshold} points). The Hub chooses by keywords and understands only some common Vietnamese phrases, so it can miss; name the tool (Docker, pytest, commit…) or turn a skill on in Skills.`,
    catalog: (listed: number, omitted: number, names: boolean) => `The model also sees ${names ? 'the name' : 'the name and description'} of ${listed} other skills that are turned on${omitted ? ` (${omitted} more did not fit, so they are not named)` : ''} and reads one with skill_load when it needs it; the skills it read are on the line "Skills read on demand".`,
    noteNoneCatalog: (considered: number, threshold: number, listed: number, omitted: number, names: boolean) => `No keyword of the request matched any of the ${considered} skills turned on (a match needs ${threshold} points). The model still sees ${names ? 'the name' : 'the name and description'} of ${listed} skills${omitted ? ` (${omitted} more did not fit, so they are not named)` : ''} and reads what it needs with skill_load, from the conversation and the files it has looked at; the skills it read are on the line "Skills read on demand".`,
    noteOff: 'No skill is turned on, so the Hub has nothing to choose from. Turn on or install a skill in Skills.',
    noteEmpty: 'This turn has no request text to compare with the skills.',
    nearest: (name: string, score: number, threshold: number) => `Closest: ${name} (${score}/${threshold} points)`,
    project: (labels: string) => `The Hub sees a project with: ${labels}`,
    noProject: 'The Hub does not recognise a kind of project from the files in the root folder.',
    named: (word: string) => `mentions “${word}”`,
    read: (phrase: string, word: string) => `“${phrase}” → ${word}`,
    description: (words: string) => `words in its description: ${words}`,
    inProject: (label: string) => `the project has ${label}`,
    earlier: 'from an earlier message',
  },
} as const;

const REASONS = new Set(['selected', 'no_match', 'no_skills', 'no_prompt']);
const str = (value: unknown): value is string => typeof value === 'string';

/** The grounds of one skill as phrases: words of the request (or the Vietnamese phrase they were read from), the words of its description once, the project, an earlier message. */
function reasonsOf(why: SkillSelectionWhy[] | undefined, source: string, lang: Lang): string[] {
  const text = TEXT[lang];
  const named: string[] = [];
  const words: string[] = [];
  const where: string[] = [];
  const once = (list: string[], reason: string) => { if (!list.includes(reason)) list.push(reason); };
  for (const item of Array.isArray(why) ? why : []) {
    if (item === null || typeof item !== 'object') continue;
    if (item.kind === 'description' && str(item.word)) once(words, item.word);
    else if ((item.kind === 'trigger' || item.kind === 'id' || item.kind === 'name') && str(item.word)) once(named, str(item.via) ? text.read(item.via, item.word) : text.named(item.word));
    else if (item.kind === 'project' && str(item.label)) once(where, text.inProject(item.label));
  }
  return [...named, ...(words.length ? [text.description(words.join(', '))] : []), ...where, ...(source === 'earlier' ? [text.earlier] : [])].slice(0, MAX_REASONS);
}

/**
 * What to say under a finished turn, or null when there is nothing to say: no record (a ChatGPT Web task, a task from before the record existed), or one this page does not
 * know how to read.
 */
export function describeSkillSelection(record: SkillSelectionRecord | null | undefined, lang: Lang = 'vi'): SkillSelectionView | null {
  if (record === null || typeof record !== 'object' || !REASONS.has(record.reason) || !Array.isArray(record.selected) || !Number.isInteger(record.considered)) return null;
  const text = TEXT[lang];
  const considered = record.considered;
  const threshold = Number.isInteger(record.threshold) ? record.threshold : 3;
  const labels = (Array.isArray(record.project) ? record.project : []).filter((signal) => signal !== null && typeof signal === 'object' && str(signal.label)).slice(0, MAX_PROJECT).map((signal) => signal.label);
  const project = labels.length ? text.project(labels.join(' · ')) : null;
  // The skills the skill index named to the model besides the preloaded ones (records from before it existed have none).
  const named = (value: unknown) => (Array.isArray(value) ? value.filter(str).length : 0);
  const listed = named(record.catalog?.listed);
  const unnamed = named(record.catalog?.omitted);
  // 'names': the room was small and the model was told the ids alone, not what each is for.
  const idsOnly = record.catalog?.form === 'names';
  if (record.reason === 'selected') {
    const skills = record.selected.filter((skill) => skill !== null && typeof skill === 'object' && str(skill.id) && str(skill.name)).slice(0, MAX_SKILLS)
      .map((skill) => ({ id: skill.id, name: skill.name, reasons: reasonsOf(skill.why, skill.source, lang) }));
    if (!skills.length) return null;
    return { kind: 'selected', headline: text.selected(skills.length), skills, nearest: null, project, catalog: listed ? text.catalog(listed, unnamed, idsOnly) : null, note: text.noteSelected };
  }
  if (record.reason === 'no_skills') return { kind: 'off', headline: text.off, skills: [], nearest: null, project: null, catalog: null, note: text.noteOff };
  if (record.reason === 'no_prompt') return { kind: 'empty', headline: text.empty, skills: [], nearest: null, project: null, catalog: null, note: text.noteEmpty };
  const near = record.nearest;
  const nearest = near !== null && typeof near === 'object' && str(near.name) && Number.isInteger(near.score) ? text.nearest(near.name, near.score, threshold) : null;
  const note = listed ? text.noteNoneCatalog(considered, threshold, listed, unnamed, idsOnly) : text.noteNone(considered, threshold);
  return { kind: 'none', headline: text.none, skills: [], nearest, project: project ?? text.noProject, catalog: null, note };
}
