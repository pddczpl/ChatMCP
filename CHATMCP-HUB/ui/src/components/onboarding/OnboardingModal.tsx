import { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { ArrowRight, Bot, Check, CheckCircle2, Eye, Folder, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { IntelligenceTab } from '@/components/inspector/IntelligenceTab';
import { useQueryClient } from '@tanstack/react-query';

export function OnboardingModal() {
  const { onboardingOpen, setOnboardingOpen, showToast } = useAppStore();
  const [step, setStep] = useState(1);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [permMode, setPermMode] = useState('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [appliedFolder, setAppliedFolder] = useState('');
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  if (!onboardingOpen) return null;

  const handleBrowseFolder = async () => {
    setError('');
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        setSelectedFolder(res.path);
        await api.selectWorkspace(res.path);
        setAppliedFolder(res.path);
        await queryClient.invalidateQueries();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onb_select_failed'));
    }
  };

  const handleApplyFolder = async () => {
    setBusy(true); setError('');
    try {
      await api.selectWorkspace(selectedFolder.trim());
      setAppliedFolder(selectedFolder.trim());
      await queryClient.invalidateQueries();
    } catch (err) { setError(err instanceof Error ? err.message : t('onb_select_failed')); }
    finally { setBusy(false); }
  };

  const handleDismiss = () => {
    try {
      localStorage.setItem('chatmcp:onboarding-completed', 'true');
    } catch {
      // Ignored
    }
    setOnboardingOpen(false);
    showToast(t('onb_dismissed'), 'info');
  };

  const handleFinish = async () => {
    setBusy(true); setError('');
    try {
      // Choosing a permission mode does not grant permission to lower sandbox-only.
      const current = await api.getState();
      await api.configurePermissions({ mode: permMode, ...(current.studio?.permissions?.executionPolicy === 'full-access' ? { executionPolicy: 'host-review' } : {}) });
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      localStorage.setItem('chatmcp:onboarding-completed', 'true');
      setOnboardingOpen(false);
      showToast(t('onb_welcome_toast'), 'success');
    } catch (err) { setError(err instanceof Error ? err.message : t('onb_save_failed')); }
    finally { setBusy(false); }
  };

  const steps = [
    { num: 1, label: t('onb_step_folder') },
    { num: 2, label: t('onb_step_model') },
    { num: 3, label: t('onb_step_perms') },
  ];
  const modes = [
    { id: 'review', label: t('onb_m_review'), desc: t('onb_m_review_desc'), icon: ShieldCheck },
    { id: 'readonly', label: t('mode_readonly'), desc: t('onb_m_readonly_desc'), icon: Eye },
    { id: 'autonomous', label: t('mode_autonomous'), desc: t('onb_m_auto_desc'), icon: Bot },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] p-4">
      <div role="dialog" aria-label={t('onb_dialog')} className="anim-pop flex max-h-[94vh] w-full max-w-xl select-none flex-col overflow-hidden rounded-2xl border border-line bg-panel text-[13px] shadow-[var(--shadow-pop)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent text-primary-fg">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight text-fg">{t('onb_title')}</h2>
              <p className="text-[13px] text-muted">{t('onb_subtitle')}</p>
            </div>
          </div>
          <button aria-label={t('onb_close')} onClick={handleDismiss}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-hover hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Steps */}
        <ol className="flex items-center gap-2 px-6 pt-5" aria-label={t('onb_steps')}>
          {steps.map((s, index) => (
            <li key={s.num} className="flex flex-1 items-center gap-2" aria-current={step === s.num ? 'step' : undefined}>
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold transition-colors',
                step === s.num ? 'bg-primary text-primary-fg' : step > s.num ? 'border border-success/40 bg-success/15 text-success' : 'border border-line bg-surface text-faint')}>
                {step > s.num ? <Check className="h-3.5 w-3.5" /> : s.num}
              </span>
              <span className={cn('whitespace-nowrap text-[13px]', step === s.num ? 'font-semibold text-fg' : 'text-faint')}>{s.label}</span>
              {index < steps.length - 1 && <span aria-hidden="true" className={cn('h-px flex-1', step > s.num ? 'bg-success/40' : 'bg-line')} />}
            </li>
          ))}
        </ol>

        {/* Step content */}
        <div className="min-h-[200px] flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-[13px] leading-5 text-muted">{t('onb_pick_folder')}</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label={t('onb_path_aria')}
                  placeholder={t('onb_path_placeholder')}
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  className="h-10 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-[12px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
                />
                <Button variant="secondary" size="lg" onClick={handleBrowseFolder} className="gap-1.5">
                  <Folder className="h-4 w-4 text-primary" />
                  <span>{t('onb_browse')}</span>
                </Button>
              </div>
              <Button onClick={handleApplyFolder} disabled={busy || !selectedFolder.trim()}>{t('onb_apply')}</Button>
              {appliedFolder && (
                <p role="status" className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[13px] text-success">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-all">{t('onb_chosen', { path: appliedFolder })}</span>
                </p>
              )}
              <p className="text-[12px] leading-4 text-faint">{t('ws_protected')}</p>
            </div>
          )}

          {step === 2 && <div className="-mx-3 -my-3"><IntelligenceTab /></div>}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-[13px] leading-5 text-muted">{t('onb_pick_mode')}</p>
              <div className="space-y-2">
                {modes.map((m) => {
                  const Icon = m.icon;
                  const selected = permMode === m.id;
                  return (
                    <button key={m.id} type="button" aria-pressed={selected} onClick={() => setPermMode(m.id)}
                      className={cn('flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors',
                        selected ? 'border-primary bg-primary/10' : 'border-line bg-surface hover:border-line-strong hover:bg-hover')}>
                      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', selected ? 'text-primary' : 'text-muted')} />
                      <span className="min-w-0">
                        <span className={cn('block text-[13px] font-semibold', selected && 'text-primary')}>{m.label}</span>
                        <span className="mt-0.5 block text-[12px] leading-4 text-muted">{m.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {error && <p role="alert" className="mx-6 mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p>}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line px-6 py-4">
          <button onClick={handleDismiss} className="text-[13px] text-faint transition-colors hover:text-fg">{t('onb_skip')}</button>
          <div className="flex items-center gap-2">
            {step > 1 && <Button variant="secondary" onClick={() => setStep(step - 1)}>{t('onb_back')}</Button>}
            {step < 3 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)} className="gap-1.5">
                <span>{t('onb_next')}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button variant="primary" onClick={handleFinish} disabled={busy} className="gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>{t('onb_finish')}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
