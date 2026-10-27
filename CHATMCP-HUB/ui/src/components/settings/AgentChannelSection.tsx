import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CircleCheck, Copy, Download, Link2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { formatTime } from '@/lib/format';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { ChatGptWebRiskNote } from '@/components/approval/ChatGptWebRiskNote';
import { SettingsCard } from './SettingsCard';

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase() === b.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase();

/**
 * How the agent reaches its model: the configured Model API, or the ChatGPT tab of the person's own browser through the
 * Companion extension (never a ChatGPT API token, never the login credentials).
 */
export function AgentChannelSection() {
  const { showToast, selectedWorkspacePath } = useAppStore();
  const queryClient = useQueryClient();
  const { t, lang } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });

  const currentWs = (hub?.workspaces?.items?.some(w => w.path === selectedWorkspacePath) ? selectedWorkspacePath :
    hub?.workspaces?.activePath) || hub?.workspace?.path || '';
  const [changingTransport, setChangingTransport] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const transport = hub?.agent?.mode || 'api';
  const companion = hub?.browser;

  const changeTransport = async (mode: 'api' | 'chatgpt-web') => {
    if (changingTransport) return;
    setChangingTransport(true);
    try {
      await api.setAgentMode(mode);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(mode === 'api' ? t('chan_toast_api') : t('chan_toast_web'), 'success');
    } catch (e: any) { showToast(e.message || t('chan_switch_failed'), 'error'); }
    finally { setChangingTransport(false); }
  };

  // "Review before send": off unless chosen; one global switch and an optional override for the workspace shown above.
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const reviewGlobal = companion?.privacy?.reviewBeforeSend === true;
  const workspaceOverride = companion?.privacy?.workspaces?.find(item => currentWs && samePath(item.path, currentWs));
  const savePrivacy = async (payload: { reviewBeforeSend?: boolean; workspacePath?: string; workspaceReview?: boolean | null }, message: string) => {
    if (savingPrivacy) return;
    setSavingPrivacy(true);
    try {
      await api.configureBrowserPrivacy(payload);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(message, 'success');
    } catch (e: any) { showToast(e.message || t('chan_privacy_failed'), 'error'); }
    finally { setSavingPrivacy(false); }
  };

  const issuePairCode = async () => {
    if (pairingBusy) return;
    setPairingBusy(true);
    try {
      const code = await api.createBrowserPairCode();
      setPairCode(code);
      showToast(t('chan_toast_pair'), 'info');
    } catch (e: any) { showToast(e.message || t('chan_pair_failed'), 'error'); }
    finally { setPairingBusy(false); }
  };
  const disconnectCompanion = async () => {
    if (!window.confirm(t('chan_unpair_confirm'))) return;
    setPairingBusy(true);
    try {
      await api.unpairBrowser();
      setPairCode(null);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(t('chan_unpaired'), 'info');
    } catch (e: any) { showToast(e.message || t('chan_unpair_failed'), 'error'); }
    finally { setPairingBusy(false); }
  };

  const options = [
    { id: 'api', label: 'Model API', hint: t('chan_opt_api_hint') },
    { id: 'chatgpt-web', label: 'ChatGPT Web', hint: t('chan_opt_web_hint') },
  ] as const;

  return (
    <div className="space-y-5">
      {/* The browser transport is an existing paired extension, NOT a ChatGPT API token, and never receives the login credentials. */}
      <SettingsCard data-testid="agent-transport-settings" icon={Bot} title={t('chan_title')}
        description={t('chan_desc')}>
        <div className="grid grid-cols-2 gap-3">
          {options.map(option => (
            <button type="button" key={option.id} disabled={changingTransport}
              aria-pressed={transport === option.id} aria-label={t('chan_opt_aria', { label: option.label })}
              onClick={() => void changeTransport(option.id)}
              className={cn('space-y-1 rounded-xl border p-3.5 text-left transition-colors disabled:opacity-50',
                transport === option.id ? 'border-primary bg-primary/10' : 'border-line bg-surface hover:border-line-strong hover:bg-hover')}>
              <span className={cn('block text-[13px] font-semibold', transport === option.id && 'text-primary')}>{option.label}</span>
              <span className="block text-[12px] leading-4 text-muted">{option.hint}</span>
            </button>
          ))}
        </div>

        {/* Visible BEFORE the person switches to this channel: what it automates, the Terms-of-Use risk, where content goes. */}
        <ChatGptWebRiskNote testId="chatgpt-web-risk-note" />

        <div className="space-y-3 rounded-xl border border-line bg-surface p-4" data-testid="chatgpt-web-privacy-settings">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" data-testid="review-before-send-toggle" checked={reviewGlobal} disabled={savingPrivacy}
              onChange={event => void savePrivacy({ reviewBeforeSend: event.target.checked }, event.target.checked ? t('chan_review_on') : t('chan_review_off'))} />
            <span>
              <span className="block text-[13px] font-medium text-fg">{t('chan_review_label')}</span>
              <span className="mt-0.5 block text-[12px] leading-4 text-muted">{t('chan_review_desc')}</span>
            </span>
          </label>
          <label className="flex items-center gap-3 text-[13px] text-muted">
            <span className="shrink-0">{t('chan_current_ws')}</span>
            <Select data-testid="review-before-send-workspace" disabled={savingPrivacy || !currentWs} aria-label={t('chan_ws_review_aria')}
              value={workspaceOverride ? (workspaceOverride.review ? 'on' : 'off') : ''}
              onChange={event => void savePrivacy({ workspacePath: currentWs, workspaceReview: event.target.value === 'on' ? true : event.target.value === 'off' ? false : null }, t('chan_ws_saved'))}>
              <option value="">{t('chan_follow_global', { state: t(reviewGlobal ? 'chan_on' : 'chan_off') })}</option>
              <option value="on">{t('chan_always_review')}</option>
              <option value="off">{t('chan_never_review')}</option>
            </Select>
          </label>
        </div>

        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Link2 className="h-3.5 w-3.5" />
          <span>{!companion?.paired ? t('chan_unpaired_status') :
            companion.connected ? t('chan_connected') :
              t('chan_waiting_tab')}</span>
          {companion?.connected && <CircleCheck className="h-3.5 w-3.5 text-success" />}
        </div>

        <div className="flex flex-wrap gap-2" data-testid="browser-companion-install-links">
          <a className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-primary transition-colors hover:border-line-strong hover:bg-hover"
            href="https://github.com/pddczpl/ChatMCP/releases/latest/download/DatGold-Browser-Companion.zip"
            target="_blank" rel="noopener noreferrer"
            aria-label={t('chan_zip_aria')}>
            <Download className="h-3.5 w-3.5" /> {t('chan_zip_link')}
          </a>
          <a className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-3 text-[13px] text-muted transition-colors hover:border-line-strong hover:bg-hover hover:text-fg"
            href="https://github.com/pddczpl/ChatMCP/blob/main/CHATMCP-HUB/extension/INSTALL-EXTENSION.txt"
            target="_blank" rel="noopener noreferrer">{t('chan_install_guide')}</a>
        </div>
        <p className="text-[12px] leading-5 text-muted">
          {t('chan_help_a')}<code>chrome://extensions</code>{t('chan_help_or')}<code>edge://extensions</code>{t('chan_help_b')}<strong>{t('chan_help_dir')}</strong>{t('chan_help_c')}<code>CHATMCP-HUB/extension</code>{t('chan_help_d')}<a className="text-primary underline"
            href="https://chatgpt.com" target="_blank" rel="noreferrer">chatgpt.com</a>{t('chan_help_e')}
        </p>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => void issuePairCode()} disabled={pairingBusy || companion?.pairingAvailable === false}>
            {pairingBusy ? t('chan_busy') : t('chan_make_code')}
          </Button>
          {companion?.paired && <button type="button" onClick={() => void disconnectCompanion()}
            disabled={pairingBusy} className="text-[13px] text-danger hover:underline disabled:opacity-50">{t('chan_unpair')}</button>}
        </div>
        {pairCode && <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-surface p-3">
          <code data-testid="chatgpt-pair-code" className="text-lg font-semibold tracking-widest text-fg">{pairCode.code}</code>
          <button type="button" aria-label={t('chan_copy_code')}
            onClick={() => void navigator.clipboard.writeText(pairCode.code)
              .then(() => showToast(t('chan_code_copied'), 'success'))
              .catch(() => showToast(t('chan_code_manual'), 'info'))}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"><Copy className="h-3.5 w-3.5" /></button>
          <span className="ml-auto text-[12px] text-faint">{t('chan_expires', { time: formatTime(pairCode.expiresAt, lang) })}</span>
        </div>}
        {transport === 'chatgpt-web' && <p className="text-[12px] leading-5 text-warning">
          {t('chan_web_warning')}
        </p>}
      </SettingsCard>
    </div>
  );
}
