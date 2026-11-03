import type { AcceptPlan, RejectPlan } from '@/lib/review-rules';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

export type ConfirmKind = 'accept' | 'reject';

/**
 * The question before "accept all" and "reject all", with what each would do in numbers. It is the project's own modal (a native <dialog> with the alertdialog role): Radix's
 * AlertDialog adds a <style> element for its scroll lock, which the Hub's Content-Security-Policy blocks (style-src 'self'), so it cannot be used here. Cancel comes first, so
 * that it is the button that has the focus when the dialog opens, and Escape closes it.
 */
export function ReviewConfirm({ kind, accept, reject, busy, onCancel, onConfirm }: { kind: ConfirmKind | null; accept: AcceptPlan; reject: RejectPlan; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const rejecting = kind === 'reject';
  return (
    <Modal open={kind !== null} onOpenChange={(open) => { if (!open) onCancel(); }} role="alertdialog"
      title={rejecting ? t('review_confirm_reject_title') : t('review_confirm_accept_title')}
      description={rejecting ? t('review_confirm_reject_body', { ...reject }) : t('review_confirm_accept_body', { ...accept })}>
      {kind !== null && (
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>{t('review_confirm_cancel')}</Button>
          <Button variant={rejecting ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>{rejecting ? t('review_reject_all') : t('review_accept_all')}</Button>
        </div>
      )}
    </Modal>
  );
}
