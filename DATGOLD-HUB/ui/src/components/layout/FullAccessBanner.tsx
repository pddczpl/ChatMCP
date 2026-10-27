import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';

/** A thin, permanent strip under the header while FULL ACCESS is on: the state must not be possible to forget. */
export function FullAccessBanner() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useAppStore(state => state.showToast);
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const [busy, setBusy] = useState(false);
  if (hub?.studio?.permissions?.executionPolicy !== 'full-access') return null;

  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.configurePermissions({ mode: 'review', executionPolicy: 'host-review' });
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(t('agents_fab_back_to_review'), 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('agents_conv_mode_failed'), 'error');
    } finally { setBusy(false); }
  };

  return (
    <div role="alert" data-testid="full-access-banner"
      className="flex shrink-0 items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-[13px] text-danger">
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 font-medium">{t('full_access_banner')}</span>
      <Button size="sm" variant="danger" disabled={busy} onClick={() => void turnOff()} className="h-7 shrink-0">{t('full_access_turn_off')}</Button>
    </div>
  );
}
