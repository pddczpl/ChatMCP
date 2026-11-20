// The owner's screen for external MCP servers (P2 slice D, plan task ext-14; docs/MCP-CLIENT.md "The screen and its routes"). It shows what the Hub
// reports (GET /api/mcp/servers) and sends the owner's decisions to the routes of lib/mcp/http-api.mjs. Nothing is decided here: a launch is approved
// with the fingerprint of the record shown, a list of tools with the fingerprint of the lists shown, and the Hub refuses either when what it would
// approve is no longer what was shown. Secrets are write-only: the Hub never sends one, and the form sends an empty secret field as "keep".
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, RefreshCw, X } from 'lucide-react';
import { api, type McpConnectionState, type McpLaunchRecord, type McpPolicyWord, type McpServerView, type McpToolReview, type McpToolView } from '@/lib/api';
import { hasTranslation, useTranslation, type Translate } from '@/lib/i18n';
import { emptyEntry, emptyServerForm, formFromServer, mcpErrorKey, needsToolReview, serverPayload, type McpEntryForm, type McpServerFormState } from '@/lib/mcp-servers';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { EmptyBlock, ErrorLine, LoadingLine, SectionHeading, TabBody } from './parts';

type Notice = { kind: 'ok' | 'error'; text: string } | null;
const WORDS: McpPolicyWord[] = ['ask', 'allow', 'deny'];

/** The words for a refusal of the Hub: its own words, or the tab's for the codes the owner can act on. */
function errorText(t: Translate, error: unknown): string {
  const key = mcpErrorKey((error as { code?: string } | null)?.code);
  return key ? t(key) : String((error as Error | null)?.message ?? error);
}

function stateLabel(t: Translate, state: McpConnectionState): string {
  const key = `mcp_state_${state}`;
  return hasTranslation(key) ? t(key) : state;
}

function stateTone(state: McpConnectionState): 'success' | 'warning' | 'danger' | 'neutral' | 'info' {
  if (state === 'connected') return 'success';
  if (state === 'needs_review' || state === 'needs_launch_approval') return 'warning';
  if (state === 'failed' || state === 'lost') return 'danger';
  if (state === 'connecting') return 'info';
  return 'neutral';
}

export function McpTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['mcpServers'], queryFn: api.getMcpServers, refetchInterval: 4000 });
  const [editing, setEditing] = useState<{ form: McpServerFormState; existing: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['mcpServers'] });
  const reload = useMutation({
    mutationFn: api.reloadMcpServers,
    onSuccess: (answer) => { queryClient.setQueryData(['mcpServers'], answer); setNotice(null); },
    onError: (failure) => { setNotice({ kind: 'error', text: errorText(t, failure) }); void refresh(); },
  });
  const save = useMutation({
    mutationFn: (form: McpServerFormState) => { const { id, server } = serverPayload(form); return api.upsertMcpServer(id, server); },
    onSuccess: (answer) => { setEditing(null); setNotice({ kind: 'ok', text: t('mcp_saved', { id: answer.server.id }) }); void refresh(); },
    onError: (failure) => setNotice({ kind: 'error', text: errorText(t, failure) }),
  });

  return (
    <TabBody label={t('tab_mcp')} testId="mcp-tab">
      <div className="space-y-2">
        <SectionHeading title={t('mcp_title')} count={data?.servers.length} action={
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="quiet" onClick={() => reload.mutate()} disabled={reload.isPending}><RefreshCw className="h-3.5 w-3.5" />{t('mcp_reload')}</Button>
            <Button size="sm" variant="primary" onClick={() => { setNotice(null); setEditing({ form: emptyServerForm(), existing: false }); }}><Plus className="h-3.5 w-3.5" />{t('mcp_add')}</Button>
          </div>
        } />
        <p className="text-[12px] leading-4 text-muted">{t('mcp_intro')}</p>
      </div>
      {data && data.runtime.state !== 'ready' && <ErrorLine message={t('mcp_runtime_missing', { code: data.runtime.code ?? data.runtime.state })} />}
      {data?.configError && (
        <div role="alert" className="space-y-1 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <p className="break-words">{t('mcp_config_error', { message: data.configError.message })}</p>
          {data.servers.length > 0 && <p>{t('mcp_config_error_kept')}</p>}
        </div>
      )}
      {notice && (notice.kind === 'error'
        ? <ErrorLine message={notice.text} />
        : <p role="status" data-testid="mcp-notice" className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[13px] text-success">{notice.text}</p>)}
      {editing && (
        <McpServerFormView key={editing.existing ? `edit-${editing.form.id}` : 'new'} initial={editing.form} editing={editing.existing} busy={save.isPending}
          onSubmit={(form) => save.mutate(form)} onCancel={() => setEditing(null)} />
      )}
      {isLoading && <LoadingLine text={t('mcp_loading')} />}
      {error && <ErrorLine message={t('mcp_load_failed', { message: errorText(t, error) })} />}
      {data && data.servers.length === 0 && !editing && <EmptyBlock icon={Plug} title={t('mcp_empty')} hint={t('mcp_empty_hint')} />}
      {data?.servers.map((server) => (
        <McpServerCard key={server.id} server={server} onNotice={setNotice}
          onEdit={() => { setNotice(null); setEditing({ form: formFromServer(server), existing: true }); }} />
      ))}
    </TabBody>
  );
}

function McpServerCard({ server, onEdit, onNotice }: { server: McpServerView; onEdit: () => void; onNotice: (notice: Notice) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [launch, setLaunch] = useState<McpLaunchRecord | null>(null);
  const [review, setReview] = useState<McpToolReview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = server.status;
  const state: McpConnectionState = status?.state ?? 'idle';
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['mcpServers'] });
  const fail = (failure: unknown) => onNotice({ kind: 'error', text: errorText(t, failure) });
  const code = (failure: unknown) => (failure as { code?: string } | null)?.code;

  const test = useMutation({
    mutationFn: () => api.testMcpServer(server.id),
    onSuccess: (answer) => {
      onNotice(answer.ok ? { kind: 'ok', text: t('mcp_test_ok', { id: server.id }) } : { kind: 'error', text: answer.error && mcpErrorKey(answer.error.code) ? errorText(t, answer.error) : t('mcp_last_error', { code: answer.error?.code ?? '', message: answer.error?.message ?? '' }) });
      void refresh();
    },
    onError: fail,
  });
  const showLaunch = useMutation({ mutationFn: () => api.getMcpLaunchRecord(server.id), onSuccess: setLaunch, onError: fail });
  // After the approval the server is tested at once: that starts it, lists its tools and shows what to review next.
  const approveLaunch = useMutation({
    mutationFn: (fingerprint: string) => api.approveMcpLaunch(server.id, fingerprint),
    onSuccess: () => { setLaunch(null); test.mutate(); },
    onError: (failure) => { fail(failure); if (code(failure) === 'mcp_launch_changed') showLaunch.mutate(); },
  });
  const showReview = useMutation({ mutationFn: () => api.getMcpToolReview(server.id), onSuccess: setReview, onError: fail });
  const approveTools = useMutation({
    mutationFn: (fingerprint: string) => api.approveMcpTools(server.id, fingerprint),
    onSuccess: () => { setReview(null); void refresh(); },
    onError: (failure) => { fail(failure); if (code(failure) === 'mcp_fingerprint_mismatch') showReview.mutate(); },
  });
  const policy = useMutation({
    mutationFn: (patch: { default?: McpPolicyWord | null; tools?: Record<string, McpPolicyWord | null> }) => api.setMcpToolPolicy(server.id, patch),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteMcpServer(server.id),
    onSuccess: () => { onNotice({ kind: 'ok', text: t('mcp_deleted', { id: server.id }) }); void refresh(); },
    onError: (failure) => { setConfirmDelete(false); fail(failure); },
  });

  const refused = status ? status.refused.tools + status.refused.prompts + status.refused.resources : 0;
  const defaultWord: McpPolicyWord = server.policy.default ?? 'ask';
  const listed = new Set(server.tools.map((tool) => tool.name));
  const unlisted = Object.entries(server.policy.tools ?? {}).filter(([name]) => !listed.has(name));
  const chooseRule = (name: string, value: string) => policy.mutate({ tools: { [name]: (value || null) as McpPolicyWord | null } });
  const reviewPending = needsToolReview(server) && server.toolReview.state !== 'not_connected';

  return (
    <article data-testid={`mcp-server-${server.id}`} className="space-y-3 rounded-xl border border-line bg-surface px-3 py-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-semibold text-fg">{server.id}</span>
          <Badge>{t(server.transport === 'stdio' ? 'mcp_transport_stdio' : 'mcp_transport_http')}</Badge>
          <Badge variant={stateTone(state)} data-testid={`mcp-state-${server.id}`}>{stateLabel(t, state)}</Badge>
          {!server.enabled && <Badge variant="warning">{t('mcp_disabled')}</Badge>}
        </div>
        <p className="break-all font-mono text-[12px] text-muted">{server.transport === 'stdio' ? [server.command ?? '', ...(server.args ?? [])].join(' ') : server.url}</p>
        {status?.server && <p className="text-[12px] text-muted">{t('mcp_server_info', { name: status.server.name, version: status.server.version, protocol: status.protocolVersion ?? '-' })}</p>}
        {status && status.calls > 0 && <p className="text-[12px] text-muted">{t('mcp_calls', { count: status.calls })}</p>}
        {status?.lastError && <p className="break-words text-[12px] text-danger">{t('mcp_last_error', { code: status.lastError.code, message: status.lastError.message })}</p>}
        {status?.retryAt && <p className="text-[12px] text-muted">{t('mcp_retry_at', { time: new Date(status.retryAt).toLocaleTimeString() })}</p>}
        {refused > 0 && <p className="text-[12px] text-warning">{t('mcp_refused', { count: refused })}</p>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending}>{t('mcp_test')}</Button>
        <Button size="sm" variant="quiet" onClick={onEdit}>{t('mcp_edit')}</Button>
        {confirmDelete ? (
          <>
            <Button size="sm" variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>{t('mcp_delete_confirm', { id: server.id })}</Button>
            <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(false)}>{t('mcp_cancel')}</Button>
          </>
        ) : <Button size="sm" variant="quiet" onClick={() => setConfirmDelete(true)}>{t('mcp_delete')}</Button>}
      </div>

      {server.transport === 'stdio' && (
        <div className="space-y-2">
          <p className={status?.launch?.approved ? 'text-[12px] text-muted' : 'text-[12px] text-warning'}>{status?.launch?.approved ? t('mcp_launch_ok') : t('mcp_launch_needed')}</p>
          <Button size="sm" variant={status?.launch?.approved ? 'quiet' : 'outline'} disabled={showLaunch.isPending} onClick={() => (launch ? setLaunch(null) : showLaunch.mutate())}>
            {launch ? t('mcp_launch_hide') : t('mcp_launch_show')}
          </Button>
          {launch && <LaunchRecordView answer={launch} busy={approveLaunch.isPending} onApprove={(fingerprint) => approveLaunch.mutate(fingerprint)} />}
        </div>
      )}

      {reviewPending && (
        <div className="space-y-2">
          <p className="text-[12px] text-warning">{server.toolReview.state === 'needs_review' ? t('mcp_tools_changed') : t('mcp_tools_review_needed')}</p>
          <Button size="sm" disabled={showReview.isPending} onClick={() => (review ? setReview(null) : showReview.mutate())}>{review ? t('mcp_tools_review_hide') : t('mcp_tools_review')}</Button>
          {review && <ToolReviewView review={review} busy={approveTools.isPending} onApprove={(fingerprint) => approveTools.mutate(fingerprint)} />}
        </div>
      )}

      {server.tools.length === 0 && state !== 'connected' && state !== 'needs_review' && <p className="text-[12px] text-muted">{t('mcp_tools_not_connected')}</p>}

      {(server.tools.length > 0 || unlisted.length > 0) && (
        <div className="space-y-2">
          <SectionHeading title={t('mcp_tools_heading')} count={server.tools.length} />
          <label className="flex items-center justify-between gap-2 text-[12px] text-muted">
            <span>{t('mcp_policy_default')}</span>
            <Select className="h-8 w-auto shrink-0" value={defaultWord} disabled={policy.isPending}
              onChange={(event) => policy.mutate({ default: event.target.value === 'ask' ? null : event.target.value as McpPolicyWord })}>
              {WORDS.map((word) => <option key={word} value={word}>{t(`mcp_policy_${word}`)}</option>)}
            </Select>
          </label>
          <p className="text-[12px] leading-4 text-faint">{t('mcp_policy_note')}</p>
          {server.tools.map((tool) => (
            <ToolRow key={tool.name} testId={`mcp-tool-${server.id}-${tool.name}`} tool={tool} defaultWord={defaultWord} busy={policy.isPending} onChoose={chooseRule} />
          ))}
          {unlisted.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted">{t('mcp_rules_unlisted')}</p>
              {unlisted.map(([name, rule]) => (
                <ToolRow key={name} testId={`mcp-rule-${server.id}-${name}`} tool={{ name, description: '', annotations: {}, rule, policy: rule }} defaultWord={defaultWord} busy={policy.isPending} onChoose={chooseRule} />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function ToolRow({ testId, tool, defaultWord, busy, onChoose }: { testId: string; tool: McpToolView; defaultWord: McpPolicyWord; busy: boolean; onChoose: (name: string, value: string) => void }) {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} className="space-y-1 rounded-lg border border-line px-2.5 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="break-all font-mono text-[12px] font-semibold text-fg">{tool.name}</span>
          {tool.annotations.readOnlyHint === true && <Badge>{t('mcp_hint_readonly')}</Badge>}
          {tool.annotations.destructiveHint === true && <Badge variant="warning">{t('mcp_hint_destructive')}</Badge>}
        </div>
        <Select className="h-8 w-auto max-w-full shrink-0" aria-label={t('mcp_policy_rule_of', { tool: tool.name })} value={tool.rule ?? ''} disabled={busy}
          onChange={(event) => onChoose(tool.name, event.target.value)}>
          <option value="">{t('mcp_policy_inherit', { word: t(`mcp_policy_${defaultWord}`) })}</option>
          {WORDS.map((word) => <option key={word} value={word}>{t(`mcp_policy_${word}`)}</option>)}
        </Select>
      </div>
      {tool.description && <p className="line-clamp-2 break-words text-[12px] text-muted">{tool.description}</p>}
    </div>
  );
}

/** The launch record of a stdio server, as the Hub computed it, and the button that approves exactly this record (its fingerprint). */
export function LaunchRecordView({ answer, busy, onApprove }: { answer: McpLaunchRecord; busy: boolean; onApprove: (fingerprint: string) => void }) {
  const { t } = useTranslation();
  const record = answer.record;
  if (!record) return null;
  const rows: [string, React.ReactNode][] = [
    [t('mcp_launch_command'), record.command],
    [t('mcp_launch_args'), record.args.length ? <ol className="space-y-0.5">{record.args.map((arg, index) => <li key={index}>{arg}</li>)}</ol> : t('mcp_none')],
    [t('mcp_launch_cwd'), record.cwd ?? t('mcp_none')],
    [t('mcp_launch_env'), record.envKeys.length ? record.envKeys.join(', ') : t('mcp_none')],
    [t('mcp_launch_executable'), record.executable ?? t('mcp_launch_not_found')],
    [t('mcp_launch_sha'), record.sha256 ?? t('mcp_none')],
    [t('mcp_launch_fingerprint'), answer.fingerprint ?? t('mcp_none')],
  ];
  return (
    <div data-testid="mcp-launch-record" className="space-y-2 rounded-lg border border-line bg-panel p-3">
      <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="break-all font-mono text-fg">{value}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="text-[12px] leading-4 text-muted">{t('mcp_launch_note')}</p>
      {!answer.approved && answer.fingerprint && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onApprove(answer.fingerprint as string)}>{t('mcp_launch_approve')}</Button>
      )}
    </div>
  );
}

/** The lists of a server to approve: what changed since the pin (or that there is none yet), every tool with its description, and the Approve button. */
export function ToolReviewView({ review, busy, onApprove }: { review: McpToolReview; busy: boolean; onApprove: (fingerprint: string) => void }) {
  const { t } = useTranslation();
  const diff = review.diff;
  const approvable = (review.state === 'unpinned' || review.state === 'needs_review') && Boolean(review.fingerprint);
  return (
    <div data-testid="mcp-tool-review" className="space-y-2 rounded-lg border border-line bg-panel p-3 text-[12px]">
      {review.state === 'needs_review' && diff ? (
        <ul className="space-y-1">
          {diff.added.map((entry) => <li key={`added-${entry.kind}-${entry.name}`} className="flex flex-wrap items-center gap-1.5"><Badge variant="success">{t('mcp_diff_added')}</Badge><span className="font-mono">{entry.kind} {entry.name}</span></li>)}
          {diff.removed.map((entry) => <li key={`removed-${entry.kind}-${entry.name}`} className="flex flex-wrap items-center gap-1.5"><Badge variant="danger">{t('mcp_diff_removed')}</Badge><span className="font-mono">{entry.kind} {entry.name}</span></li>)}
          {diff.changed.map((entry) => <li key={`changed-${entry.kind}-${entry.name}`} className="flex flex-wrap items-center gap-1.5"><Badge variant="warning">{t('mcp_diff_changed')}</Badge><span className="font-mono">{entry.kind} {entry.name}</span><span className="text-muted">({entry.fields.join(', ')})</span></li>)}
        </ul>
      ) : review.state === 'needs_review' ? <p className="text-muted">{t('mcp_review_algorithm')}</p> : <p className="text-muted">{t('mcp_review_first')}</p>}
      <ul className="space-y-1.5">
        {review.tools.map((tool) => (
          <li key={tool.name} className="space-y-0.5 rounded-md border border-line px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="break-all font-mono font-semibold text-fg">{tool.name}</span>
              {tool.annotations?.readOnlyHint === true && <Badge>{t('mcp_hint_readonly')}</Badge>}
              {tool.annotations?.destructiveHint === true && <Badge variant="warning">{t('mcp_hint_destructive')}</Badge>}
            </div>
            {tool.description && <p className="whitespace-pre-wrap break-words text-muted">{tool.description}</p>}
          </li>
        ))}
      </ul>
      {review.prompts.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-muted">{t('mcp_review_prompts')}</p>
          <ul className="space-y-0.5">{review.prompts.map((prompt) => <li key={prompt.name}><span className="font-mono">{prompt.name}</span>{prompt.description ? <span className="text-muted"> {prompt.description}</span> : null}</li>)}</ul>
        </div>
      )}
      {review.fingerprint && <p className="break-all font-mono text-[12px] text-faint">{review.fingerprint}</p>}
      {approvable && <Button size="sm" variant="primary" disabled={busy} onClick={() => onApprove(review.fingerprint as string)}>{t('mcp_tools_approve')}</Button>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-[12px] text-fg">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function EntryList({ title, entries, addLabel, onChange, onAdd, onRemove }: {
  title: string; entries: McpEntryForm[]; addLabel: string;
  onChange: (index: number, patch: Partial<McpEntryForm>) => void; onAdd: () => void; onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[12px] text-muted">{title}</legend>
      {entries.map((entry, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-1.5">
          <Input className="h-8 font-mono" aria-label={t('mcp_form_name')} value={entry.name} disabled={entry.stored} spellCheck={false} autoComplete="off"
            onChange={(event) => onChange(index, { name: event.target.value })} />
          <Input className="h-8 font-mono" aria-label={t('mcp_form_value')} type={entry.secret || entry.stored ? 'password' : 'text'} value={entry.value} spellCheck={false} autoComplete="off"
            placeholder={entry.stored ? t('mcp_form_secret_set') : undefined} onChange={(event) => onChange(index, { value: event.target.value })} />
          <label className="flex items-center gap-1 text-[12px] text-muted">
            <input type="checkbox" checked={entry.secret} disabled={entry.stored} onChange={(event) => onChange(index, { secret: event.target.checked })} />
            {t('mcp_form_secret')}
          </label>
          <Button type="button" size="icon" variant="quiet" aria-label={t('mcp_form_remove', { name: entry.name || '-' })} onClick={() => onRemove(index)}><X className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="quiet" onClick={onAdd}><Plus className="h-3.5 w-3.5" />{addLabel}</Button>
    </fieldset>
  );
}

/** Add or edit one server. The id cannot change while editing (another id is another server). */
export function McpServerFormView({ initial, editing, busy, onSubmit, onCancel }: {
  initial: McpServerFormState; editing: boolean; busy: boolean; onSubmit: (form: McpServerFormState) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<McpServerFormState>(initial);
  const set = (patch: Partial<McpServerFormState>) => setForm((current) => ({ ...current, ...patch }));
  const entries = (list: 'env' | 'headers') => ({
    entries: form[list],
    onChange: (index: number, patch: Partial<McpEntryForm>) => setForm((current) => ({ ...current, [list]: current[list].map((entry, at) => (at === index ? { ...entry, ...patch } : entry)) })),
    onAdd: () => setForm((current) => ({ ...current, [list]: [...current[list], emptyEntry()] })),
    onRemove: (index: number) => setForm((current) => ({ ...current, [list]: current[list].filter((_, at) => at !== index) })),
  });
  return (
    <form data-testid="mcp-server-form" className="space-y-3 rounded-xl border border-primary/30 bg-surface p-3" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
      <h3 className="text-[13px] font-semibold text-fg">{editing ? t('mcp_form_edit_title', { id: form.id }) : t('mcp_form_add_title')}</h3>
      <Field label={t('mcp_form_id')}>
        <Input className="font-mono" value={form.id} disabled={editing} spellCheck={false} autoComplete="off" onChange={(event) => set({ id: event.target.value })} />
      </Field>
      <Field label={t('mcp_form_transport')}>
        <Select value={form.transport} onChange={(event) => set({ transport: event.target.value as McpServerFormState['transport'] })}>
          <option value="stdio">{t('mcp_transport_stdio')}</option>
          <option value="http">{t('mcp_transport_http')}</option>
        </Select>
      </Field>
      {form.transport === 'stdio' ? (
        <>
          <Field label={t('mcp_form_command')}>
            <Input className="font-mono" value={form.command} spellCheck={false} autoComplete="off" onChange={(event) => set({ command: event.target.value })} />
          </Field>
          <Field label={t('mcp_form_args')}>
            <Textarea className="font-mono" rows={3} value={form.args} spellCheck={false} onChange={(event) => set({ args: event.target.value })} />
          </Field>
          <Field label={t('mcp_form_cwd')}>
            <Input className="font-mono" value={form.cwd} spellCheck={false} autoComplete="off" onChange={(event) => set({ cwd: event.target.value })} />
          </Field>
        </>
      ) : (
        <Field label={t('mcp_form_url')}>
          <Input className="font-mono" value={form.url} spellCheck={false} autoComplete="off" onChange={(event) => set({ url: event.target.value })} />
        </Field>
      )}
      <EntryList title={t('mcp_form_env')} addLabel={t('mcp_form_add_env')} {...entries('env')} />
      {form.transport === 'http' && <EntryList title={t('mcp_form_headers')} addLabel={t('mcp_form_add_header')} {...entries('headers')} />}
      <div className="space-y-1.5">
        <Check label={t('mcp_form_enabled')} checked={form.enabled} onChange={(enabled) => set({ enabled })} />
        <Check label={t('mcp_form_trust')} checked={form.trustAnnotations} onChange={(trustAnnotations) => set({ trustAnnotations })} />
        <Check label={t('mcp_form_touches')} checked={form.touchesWorkspace} onChange={(touchesWorkspace) => set({ touchesWorkspace })} />
      </div>
      <p className="text-[12px] leading-4 text-muted">{t('mcp_form_secret_note')}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>{t('mcp_form_save')}</Button>
        <Button type="button" size="sm" variant="quiet" onClick={onCancel}>{t('mcp_cancel')}</Button>
      </div>
    </form>
  );
}
