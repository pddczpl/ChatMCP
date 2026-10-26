import { useEffect, useRef } from 'react';
import { ArrowLeft, Code2, Cpu, Download, FolderOpen, Info, Link2, Palette, Puzzle, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useAppStore, type SettingsSection } from '@/store/useAppStore';
import { useTranslation, type TranslationKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { ToastContainer } from '@/components/ui/Toast';
import { IntelligenceTab } from '@/components/inspector/IntelligenceTab';
import { SkillsTab } from '@/components/inspector/SkillsTab';
import { WorkspaceSection } from './WorkspaceSection';
import { PermissionsSection } from './PermissionsSection';
import { AgentChannelSection } from './AgentChannelSection';
import { CodeIntelligenceSection } from './CodeIntelligenceSection';
import { AppearanceSection } from './AppearanceSection';
import { UpdatesSection } from './UpdatesSection';
import { AboutSection } from './AboutSection';

const SECTIONS: Array<{ id: SettingsSection; label: TranslationKey; icon: LucideIcon }> = [
  { id: 'workspace', label: 'sec_workspace', icon: FolderOpen },
  { id: 'model', label: 'sec_model', icon: Cpu },
  { id: 'permissions', label: 'sec_permissions', icon: ShieldCheck },
  { id: 'agent-channel', label: 'sec_agent_channel', icon: Link2 },
  { id: 'skills', label: 'sec_skills', icon: Puzzle },
  { id: 'code-intelligence', label: 'sec_code_intel', icon: Code2 },
  { id: 'appearance', label: 'sec_appearance', icon: Palette },
  { id: 'updates', label: 'sec_updates', icon: Download },
  { id: 'about', label: 'sec_about', icon: Info },
];

/** Settings is a place of its own, not a tab squeezed into the work panel: there is room for the real controls. */
export function SettingsView() {
  const open = useAppStore(state => state.settingsOpen);
  return open ? <SettingsDialog /> : null;
}

function SettingsDialog() {
  const { closeSettings, settingsSection, setSettingsSection } = useAppStore();
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);

  // A native modal dialog: focus stays inside, Escape closes, focus returns to what opened it.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const current = SECTIONS.find(section => section.id === settingsSection) ?? SECTIONS[0];

  return (
    <dialog ref={ref} aria-label={t('settings_title')}
      onCancel={(event) => { event.preventDefault(); closeSettings(); }}
      className="anim-rise fixed inset-0 m-0 h-full max-h-none w-full max-w-none select-none border-0 bg-bg p-0 text-fg backdrop:bg-transparent">
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-2.5">
          <Button variant="quiet" size="icon" onClick={closeSettings} aria-label={t('settings_close')} title={t('settings_close')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-sm font-semibold tracking-tight">{t('settings_title')}</h2>
          <span className="ml-auto hidden items-center gap-2 text-[12px] text-faint sm:flex">
            <Kbd>Esc</Kbd> {t('settings_close').toLowerCase()}
          </span>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t('settings_nav')} className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel p-3">
            <ul className="space-y-0.5">
              {SECTIONS.map(({ id, label, icon: Icon }) => {
                const selected = id === current.id;
                return (
                  <li key={id}>
                    <button type="button" aria-current={selected ? 'page' : undefined} onClick={() => setSettingsSection(id)}
                      className={cn('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors',
                        selected ? 'bg-primary/10 font-semibold text-primary' : 'text-muted hover:bg-hover hover:text-fg')}>
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{t(label)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-5 px-8 py-8 select-text">
              <h3 className="text-xl font-semibold tracking-tight">{t(current.label)}</h3>
              {current.id === 'workspace' && <WorkspaceSection />}
              {current.id === 'model' && <div className="-mx-3 -my-3"><IntelligenceTab /></div>}
              {current.id === 'permissions' && <PermissionsSection />}
              {current.id === 'agent-channel' && <AgentChannelSection />}
              {current.id === 'skills' && <div className="-mx-4 -my-4"><SkillsTab /></div>}
              {current.id === 'code-intelligence' && <CodeIntelligenceSection />}
              {current.id === 'appearance' && <AppearanceSection />}
              {current.id === 'updates' && <UpdatesSection />}
              {current.id === 'about' && <AboutSection />}
            </div>
          </main>
        </div>
      </div>
      {/* The page behind a modal dialog is covered by it, so messages must live inside it while it is open. */}
      <ToastContainer scope="settings" />
    </dialog>
  );
}
