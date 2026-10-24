import { useQuery } from '@tanstack/react-query';
import { Download, Info, Keyboard, Server } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation, type TranslationKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { SettingsCard, FactRow } from './SettingsCard';

const SHORTCUTS: Array<[string, TranslationKey]> = [
  ['Ctrl K', 'about_sc_search'],
  ['Ctrl B', 'about_sc_sidebar'],
  ['Ctrl J', 'about_sc_panel'],
  ['Ctrl ,', 'settings_open'],
  ['Enter', 'about_sc_send'],
  ['Shift Enter', 'about_sc_newline'],
  ['Esc', 'about_sc_close'],
];

/** The Hub this window talks to, the keys, and a way to take the audit data out. */
export function AboutSection() {
  const { showToast } = useAppStore();
  const { t } = useTranslation();
  const { data: hub, error: hubError } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });

  const handleExportLogs = () => {
    // The per-launch CSRF token is not part of an export: it is only meaningful to the running Hub.
    const { csrfToken: _csrf, ...exportable } = (hub || {}) as Record<string, unknown>;
    const data = JSON.stringify(exportable, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatmcp-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t('about_exported'), 'success');
  };

  return (
    <div className="space-y-5">
      <SettingsCard icon={Server} title={t('backend_status')} description={t('about_hub_desc')}>
        <dl>
          <FactRow label={t('about_version')}>{hub?.version ? `v${hub.version}` : '–'}</FactRow>
          <FactRow label={t('about_address')}>{typeof window !== 'undefined' ? window.location?.host || '127.0.0.1:3007' : '127.0.0.1:3007'}</FactRow>
          <FactRow label={t('about_status')} tone={hubError ? 'danger' : hub ? 'success' : 'warning'}>
            <span role="status">{hubError ? t('about_hub_error', { message: hubError.message }) : hub ? t('about_hub_ok') : t('about_hub_connecting')}</span>
          </FactRow>
        </dl>
        <p className="text-[12px] leading-4 text-faint">{t('about_local_only')}</p>
      </SettingsCard>

      <SettingsCard icon={Keyboard} title={t('about_shortcuts')}>
        <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {SHORTCUTS.map(([keys, label]) => (
            <li key={keys} className="flex items-center justify-between gap-3 border-b border-line-subtle py-2 text-[13px]">
              <span className="text-muted">{t(label)}</span>
              <Kbd>{keys}</Kbd>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard icon={Info} title={t('about_data')} description={t('about_data_desc')}>
        <Button variant="secondary" onClick={handleExportLogs} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          <span>{t('export_data')}</span>
        </Button>
      </SettingsCard>
    </div>
  );
}
