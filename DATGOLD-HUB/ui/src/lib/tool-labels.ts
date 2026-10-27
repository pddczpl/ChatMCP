// Human wording for tool calls and approval categories. The technical name (local.edit_file) stays available as a tooltip and as
// the accessible label; what a person reads first is what happened ("Sửa tệp calc.js").
import type { ToolCall } from '@/types';

export type Lang = 'vi' | 'en';
export type ToolKind = 'read' | 'search' | 'edit' | 'run' | 'git' | 'plan' | 'agent' | 'code' | 'tool';

const bare = (name: string) => name.replace(/^[a-z0-9-]+\./i, '');

export function toolKind(name: string): ToolKind {
  const n = bare(name).toLowerCase();
  if (/update_plan|plan/.test(n)) return 'plan';
  if (/spawn|subagent|agent|workflow|delegate/.test(n)) return 'agent';
  if (/symbol|reference|definition|repo_map|diagnostic|outline/.test(n)) return 'code';
  if (/git/.test(n)) return 'git';
  if (/write|edit|patch|create|replace|delete|rename|move|batch/.test(n)) return 'edit';
  if (/command|shell|exec|bash|terminal|run|test|check|powershell|cmd/.test(n)) return 'run';
  if (/search|grep|find|glob/.test(n)) return 'search';
  if (/read|view|list|stat|open|cat|tree|directory/.test(n)) return 'read';
  return 'tool';
}

const verbs: Record<ToolKind, { vi: string; en: string }> = {
  read: { vi: 'Đọc', en: 'Read' },
  search: { vi: 'Tìm kiếm', en: 'Search' },
  edit: { vi: 'Sửa', en: 'Edit' },
  run: { vi: 'Chạy lệnh', en: 'Run' },
  git: { vi: 'Git', en: 'Git' },
  plan: { vi: 'Cập nhật kế hoạch', en: 'Update plan' },
  agent: { vi: 'Giao việc cho subagent', en: 'Delegate to a subagent' },
  code: { vi: 'Phân tích mã', en: 'Analyse code' },
  tool: { vi: 'Công cụ', en: 'Tool' },
};

export function toolTarget(tool: Pick<ToolCall, 'args' | 'summary'>): string {
  const a = tool.args ?? {};
  const value = a.path ?? a.command ?? a.cmd ?? a.query ?? a.TargetFile ?? a.file ?? a.pattern ?? tool.summary ?? '';
  return typeof value === 'string' ? value : '';
}

/** "Sửa tệp" + "calc.js" for a file tool, "Chạy lệnh" + "node test.js" for a command. */
export function describeTool(tool: Pick<ToolCall, 'name' | 'args' | 'summary'>, lang: Lang = 'vi'): { kind: ToolKind; verb: string; target: string } {
  const kind = toolKind(tool.name);
  const n = bare(tool.name).toLowerCase();
  let verb = verbs[kind][lang];
  if (kind === 'read' && /list|tree|directory/.test(n)) verb = lang === 'vi' ? 'Xem thư mục' : 'List folder';
  else if (kind === 'read') verb = lang === 'vi' ? 'Đọc tệp' : 'Read file';
  else if (kind === 'edit' && /write|create|batch/.test(n)) verb = lang === 'vi' ? 'Ghi tệp' : 'Write file';
  else if (kind === 'edit') verb = lang === 'vi' ? 'Sửa tệp' : 'Edit file';
  else if (kind === 'tool') verb = bare(tool.name);
  return { kind, verb, target: toolTarget(tool) };
}

/** "Đọc 2 tệp · sửa 1 tệp · chạy 1 lệnh" */
export function summarizeTools(items: Pick<ToolCall, 'name'>[], lang: Lang = 'vi'): string {
  const count = (kinds: ToolKind[]) => items.filter(item => kinds.includes(toolKind(item.name))).length;
  const reads = count(['read', 'search', 'code']);
  const edits = count(['edit']);
  const runs = count(['run', 'git']);
  const other = items.length - reads - edits - runs;
  const parts = lang === 'vi'
    ? [reads && `đọc ${reads} tệp`, edits && `sửa ${edits} tệp`, runs && `chạy ${runs} lệnh`, other > 0 && `${other} thao tác khác`]
    : [reads && `read ${reads}`, edits && `edited ${edits}`, runs && `ran ${runs} command${runs > 1 ? 's' : ''}`, other > 0 && `${other} other`];
  const text = parts.filter(Boolean).join(' · ');
  const fallback = lang === 'vi' ? `${items.length} thao tác` : `${items.length} tool calls`;
  const sentence = text || fallback;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export type RiskLevel = 'low' | 'medium' | 'high';

/** The approval category from the Hub, in words, with how worried to be. */
export function riskInfo(category: string, lang: Lang = 'vi'): { label: string; level: RiskLevel; levelLabel: string } {
  const table: Record<string, { vi: string; en: string; level: RiskLevel }> = {
    read: { vi: 'Đọc dữ liệu', en: 'Read data', level: 'low' },
    checkpoint: { vi: 'Tạo checkpoint', en: 'Create a checkpoint', level: 'low' },
    workspace_edit: { vi: 'Sửa tệp trong workspace', en: 'Edit files in the workspace', level: 'medium' },
    execute: { vi: 'Chạy lệnh trên máy', en: 'Run a command on this machine', level: 'medium' },
    dangerous: { vi: 'Thao tác nguy hiểm', en: 'Dangerous action', level: 'high' },
    blocked: { vi: 'Bị chặn theo chính sách', en: 'Blocked by policy', level: 'high' },
    unknown: { vi: 'Chưa phân loại', en: 'Not classified', level: 'high' },
  };
  const row = table[category] ?? { vi: category || 'Chưa phân loại', en: category || 'Not classified', level: 'high' as RiskLevel };
  const levelLabel = { low: { vi: 'Rủi ro thấp', en: 'Low risk' }, medium: { vi: 'Rủi ro trung bình', en: 'Medium risk' }, high: { vi: 'Rủi ro cao', en: 'High risk' } }[row.level][lang];
  return { label: row[lang], level: row.level, levelLabel };
}
