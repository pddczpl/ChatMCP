import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

/**
 * Turning FULL ACCESS on needs the exact words typed. It is a native modal dialog, so it opens above Settings as well
 * (the permission list lives there) and keeps focus inside until the person decides.
 */
export function FullAccessDialog() {
  const { fullAccessModalOpen, setFullAccessModalOpen, showToast } = useAppStore();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    if (confirmText.trim() !== 'FULL ACCESS') return;
    setLoading(true);
    try {
      await api.setPermissions({
        mode: 'autonomous',
        executionPolicy: 'full-access',
        confirmation: 'FULL ACCESS',
      });
      showToast(t('fa_activated'), 'warning');
      setFullAccessModalOpen(false);
      setConfirmText('');
      // The banner, the status bar and the lists read this state; without a refresh they would show the old one until the next poll.
      void queryClient.invalidateQueries({ queryKey: ['hubState'] });
    } catch (err: any) {
      showToast(err.message || t('fa_activate_failed'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setConfirmText('');
    setFullAccessModalOpen(false);
  };

  if (!fullAccessModalOpen) return null;
  return (
    <Modal
      open
      onOpenChange={(open) => { if (!open) handleClose(); }}
      role="alertdialog"
      title={t('fa_title')}
      description={t('fa_desc')}
      className="max-w-md border-danger/40 text-[13px] select-none [&_h3]:text-danger"
    >
      <div className="my-4 space-y-2 rounded-xl border border-danger/30 bg-danger/10 p-3.5 leading-5 text-muted">
        <div className="flex items-center gap-2 font-semibold text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{t('fa_warning_title')}</span>
        </div>
        <p className="text-[13px]">
          {t('fa_p1_a')}<strong className="text-fg">{t('fa_p1_edit')}</strong>, <strong className="text-fg">{t('fa_p1_shell')}</strong>{t('fa_p1_b')}<strong className="text-fg">{t('fa_p1_ask')}</strong>.
        </p>
        <p className="text-[13px]">
          {t('fa_p2_a')}<strong className="text-fg">{t('fa_p2_irreversible')}</strong>{t('fa_p2_b')}<strong className="text-fg">{t('fa_p2_delete')}</strong>, <strong className="text-fg">git push</strong>, <strong className="text-fg">merge pull request</strong>, <strong className="text-fg">{t('fa_p2_release')}</strong>{t('fa_p2_c')}
        </p>
        <p className="text-[13px]">
          {t('fa_p3')}
        </p>
      </div>

      <div className="my-4 space-y-1.5">
        <label htmlFor="full-access-confirm" className="block text-[13px] text-muted">
          {t('fa_confirm')}<strong className="font-mono text-danger">FULL ACCESS</strong>:
        </label>
        <input
          id="full-access-confirm"
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="FULL ACCESS"
          autoComplete="off"
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-[13px] text-fg placeholder:text-faint transition-colors focus:border-danger focus:outline-none focus:ring-2 focus:ring-danger/25"
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line-subtle pt-4">
        <Button variant="secondary" onClick={handleClose}>{t('fa_cancel')}</Button>
        <Button variant="danger" disabled={confirmText.trim() !== 'FULL ACCESS' || loading} onClick={handleConfirm} className="gap-1.5">
          <ShieldAlert className="h-3.5 w-3.5" />
          <span>{loading ? t('fa_activating') : t('fa_activate')}</span>
        </Button>
      </div>
    </Modal>
  );
}
