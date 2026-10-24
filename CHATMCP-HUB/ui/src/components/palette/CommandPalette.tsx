import { useEffect } from 'react';
import { Command } from 'cmdk';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Bot, Code2, Cpu, Eye, FileCode, Folder, GitBranch, Globe, Link2, ListTodo, Monitor, Moon, Palette, Plus, Puzzle,
  Search, Settings, ShieldAlert, ShieldCheck, Sun, Terminal, Users, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore, type InspectorTab, type SettingsSection } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Kbd } from '@/components/ui/Kbd';
import { cn } from '@/lib/utils';

function Item({ icon: Icon, label, hint, tone, onSelect, keywords }: {
  icon: LucideIcon; label: string; hint?: string; tone?: 'danger'; onSelect: () => void; keywords?: string[];
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors',
        'data-[selected=true]:bg-hover',
        tone === 'danger' ? 'text-danger data-[selected=true]:bg-danger/10' : 'text-fg',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', tone === 'danger' ? 'text-danger' : 'text-muted')} />
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[12px] text-faint">{hint}</span>}
    </Command.Item>
  );
}

export function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    setSelectedTaskId,
    setActiveTab,
    setInspectorOpen,
    openSettings,
    setTheme,
    setFullAccessModalOpen,
    showToast,
  } = useAppStore();
  const { t } = useTranslation();

  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState });

  // Escape closes the palette (Ctrl+K toggles it from the shell).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && commandPaletteOpen) setCommandPaletteOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  if (!commandPaletteOpen) return null;

  const runAction = (fn: () => void) => {
    fn();
    setCommandPaletteOpen(false);
  };

  const handleSelectMode = async (mode: string) => {
    if (mode === 'full-access') {
      setFullAccessModalOpen(true);
      return;
    }
    try {
      await api.configurePermissions({ mode, ...(hub?.studio?.permissions?.executionPolicy === 'full-access' ? { executionPolicy: 'host-review' } : {}) });
      showToast(t('cmd_mode_changed', { mode }), 'info');
    } catch (err: any) {
      showToast(err.message || t('cmd_mode_failed'), 'error');
    }
  };

  const handleBrowseWorkspace = async () => {
    try {
      const res = await api.browseWorkspace();
      if (res.path) {
        await api.selectWorkspace(res.path);
        showToast(t('cmd_ws_selected', { path: res.path }), 'success');
      }
    } catch {
      // The native folder picker may be unavailable; Settings has a manual path field.
      openSettings('workspace');
    }
  };

  const go = (tab: InspectorTab) => runAction(() => { setInspectorOpen(true); setActiveTab(tab); });
  const settings = (section: SettingsSection) => runAction(() => openSettings(section));

  const group = 'px-1 py-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint';

  return (
    <div
      onClick={() => setCommandPaletteOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-4 pt-[12vh]"
    >
      <div
        role="dialog"
        aria-label={t('cmd_label')}
        onClick={(e) => e.stopPropagation()}
        className="anim-pop w-full max-w-xl select-none overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow-pop)]"
      >
        <Command className="flex flex-col" loop>
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-faint" />
            <Command.Input
              autoFocus
              placeholder={t('cmd_placeholder')}
              className="w-full bg-transparent text-[14px] text-fg placeholder:text-faint focus:outline-none"
            />
            <Kbd>Esc</Kbd>
          </div>

          <Command.List className="max-h-[min(26rem,60vh)] overflow-y-auto p-2">
            <Command.Empty className="py-8 text-center text-[13px] text-faint">{t('cmd_empty')}</Command.Empty>

            <Command.Group heading={t('cmd_g_chats')} className={group}>
              <Item icon={Plus} label={t('cmd_new_chat')} keywords={['new', 'chat', 'session']} onSelect={() => runAction(() => setSelectedTaskId(''))} />
              <Item icon={Folder} label={t('cmd_change_ws')} keywords={['open', 'folder', 'workspace']} onSelect={() => runAction(() => void handleBrowseWorkspace())} />
            </Command.Group>

            <Command.Group heading={t('cmd_g_modes')} className={group}>
              <Item icon={Eye} label={t('cmd_readonly')} hint={t('cmd_readonly_hint')} onSelect={() => runAction(() => void handleSelectMode('readonly'))} />
              <Item icon={ShieldCheck} label="Review" hint={t('cmd_review_hint')} onSelect={() => runAction(() => void handleSelectMode('review'))} />
              <Item icon={Bot} label={t('cmd_auto')} hint={t('cmd_auto_hint')} onSelect={() => runAction(() => void handleSelectMode('autonomous'))} />
              <Item icon={ShieldAlert} tone="danger" label="FULL ACCESS" hint={t('cmd_full_hint')} onSelect={() => runAction(() => void handleSelectMode('full-access'))} />
            </Command.Group>

            <Command.Group heading={t('cmd_g_go')} className={group}>
              <Item icon={ListTodo} label={t('tab_progress')} hint={t('cmd_h_plan')} keywords={['plan', 'evidence', 'kế hoạch']} onSelect={() => go('plan')} />
              <Item icon={GitBranch} label={t('tab_changes')} hint={t('cmd_h_changes')} keywords={['git', 'diff', 'checkpoint']} onSelect={() => go('changes')} />
              <Item icon={FileCode} label={t('tab_files')} keywords={['files']} onSelect={() => go('files')} />
              <Item icon={Terminal} label={t('tab_terminal')} onSelect={() => go('terminal')} />
              <Item icon={Activity} label={t('tab_activity')} keywords={['log', 'nhật ký']} onSelect={() => go('activity')} />
              <Item icon={Users} label={t('tab_agents')} hint={t('cmd_h_agents')} keywords={['background', 'subagent']} onSelect={() => go('agents')} />
              <Item icon={Globe} label={t('tab_preview')} onSelect={() => go('preview')} />
            </Command.Group>

            <Command.Group heading={t('cmd_g_settings')} className={group}>
              <Item icon={Cpu} label={t('cmd_s_model')} keywords={['model', 'provider', 'api']} onSelect={() => settings('model')} />
              <Item icon={Puzzle} label={t('cmd_s_skills')} keywords={['skills']} onSelect={() => settings('skills')} />
              <Item icon={Link2} label={t('cmd_s_channel')} keywords={['companion', 'chatgpt']} onSelect={() => settings('agent-channel')} />
              <Item icon={ShieldCheck} label={t('cmd_s_perms')} keywords={['permissions', 'execution', 'isolation']} onSelect={() => settings('permissions')} />
              <Item icon={Code2} label={t('cmd_s_code')} keywords={['lsp', 'intelligence']} onSelect={() => settings('code-intelligence')} />
              <Item icon={Settings} label={t('settings_open')} hint="Ctrl ," onSelect={() => runAction(() => openSettings())} />
            </Command.Group>

            <Command.Group heading={t('cmd_g_appearance')} className={group}>
              <Item icon={Moon} label={t('theme_dark')} keywords={['dark', 'theme']} onSelect={() => runAction(() => setTheme('dark'))} />
              <Item icon={Sun} label={t('theme_light')} keywords={['light', 'theme']} onSelect={() => runAction(() => setTheme('light'))} />
              <Item icon={Monitor} label={t('cmd_theme_system')} keywords={['system', 'theme']} onSelect={() => runAction(() => setTheme('system'))} />
              <Item icon={Palette} label={t('cmd_s_appearance')} onSelect={() => settings('appearance')} />
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
