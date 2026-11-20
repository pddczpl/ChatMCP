// The form of the MCP tab and what it sends (POST /api/mcp/server/upsert). Secrets are write-only: the Hub never sends one back (it says only that one
// is set), so a stored secret comes into the form as an empty field, and an empty field is sent as {keep: true}, which keeps the protected value the Hub has.
import type { McpMapEntry, McpMapInput, McpServerInput, McpServerView } from './api.ts';
import type { TranslationKey } from './i18n.ts';

export interface McpEntryForm {
  name: string;
  value: string;
  /** Stored protected by the Hub (the owner may also mark a value; a name like a credential is always a secret, whatever this says). */
  secret: boolean;
  /** A secret the Hub already holds: an empty value keeps it. */
  stored: boolean;
}

export interface McpServerFormState {
  id: string;
  transport: 'stdio' | 'http';
  command: string;
  /** One argument per line. */
  args: string;
  cwd: string;
  url: string;
  env: McpEntryForm[];
  headers: McpEntryForm[];
  enabled: boolean;
  trustAnnotations: boolean;
  touchesWorkspace: boolean;
  /** The timeouts read from the Hub, sent back as they were (the form does not edit them); null for a new server (the Hub's defaults). */
  timeouts: { connectMs: number; callMs: number } | null;
}

export const emptyEntry = (): McpEntryForm => ({ name: '', value: '', secret: false, stored: false });

export function emptyServerForm(): McpServerFormState {
  return { id: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', env: [], headers: [], enabled: true, trustAnnotations: false, touchesWorkspace: false, timeouts: null };
}

const entriesOf = (map: Record<string, McpMapEntry> | undefined): McpEntryForm[] =>
  Object.entries(map ?? {}).map(([name, entry]) => (entry.secret ? { name, value: '', secret: true, stored: true } : { name, value: entry.value ?? '', secret: false, stored: false }));

/** The form of a server the Hub listed. */
export function formFromServer(server: McpServerView): McpServerFormState {
  return {
    id: server.id, transport: server.transport, command: server.command ?? '', args: (server.args ?? []).join('\n'), cwd: server.cwd ?? '', url: server.url ?? '',
    env: entriesOf(server.env), headers: entriesOf(server.headers), enabled: server.enabled, trustAnnotations: server.trust?.annotations === true,
    touchesWorkspace: server.touchesWorkspace === true, timeouts: server.timeouts ? { ...server.timeouts } : null,
  };
}

function mapInput(entries: McpEntryForm[]): Record<string, McpMapInput> {
  const map: Record<string, McpMapInput> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) continue;
    if (entry.stored && entry.value === '') map[name] = { keep: true };
    else if (entry.secret || entry.stored) map[name] = { value: entry.value, secret: true };
    else map[name] = entry.value;
  }
  return map;
}

/** The body of POST /api/mcp/server/upsert. The Hub checks everything again; a row without a name is left out, and so is an empty line of the args. */
export function serverPayload(form: McpServerFormState): { id: string; server: McpServerInput } {
  const server: McpServerInput = form.transport === 'stdio'
    ? { transport: 'stdio', command: form.command.trim(), args: form.args.split(/\r?\n/).filter((line) => line.length > 0), ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), env: mapInput(form.env), enabled: form.enabled, trust: { annotations: form.trustAnnotations }, touchesWorkspace: form.touchesWorkspace }
    : { transport: 'http', url: form.url.trim(), headers: mapInput(form.headers), env: mapInput(form.env), enabled: form.enabled, trust: { annotations: form.trustAnnotations }, touchesWorkspace: form.touchesWorkspace };
  if (form.timeouts) server.timeouts = { ...form.timeouts };
  return { id: form.id.trim(), server };
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  mcp_task_active: 'mcp_err_task_active',
  mcp_launch_changed: 'mcp_err_launch_changed',
  mcp_fingerprint_mismatch: 'mcp_err_tools_changed',
};

/** The words of the tab for a code of the Hub that the owner can act on; null for any other (the Hub's own message is shown). */
export function mcpErrorKey(code: string | undefined | null): TranslationKey | null {
  return code && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

/** True when the server's lists wait for the owner: never approved, or changed since the approval. */
export function needsToolReview(server: McpServerView): boolean {
  return server.status?.state === 'needs_review' || server.toolReview.state === 'unpinned' || server.toolReview.state === 'needs_review';
}
