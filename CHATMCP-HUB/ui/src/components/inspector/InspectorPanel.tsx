import { useAppStore, InspectorTab } from '@/store/useAppStore';
import { 
  Activity, 
  FileCode, 
  GitBranch, 
  Terminal, 
  ListTodo, 
  Globe, 
  Cpu, 
  Puzzle, 
  Network, 
  Settings, 
  X 
} from 'lucide-react';
import { ActivityTab } from './ActivityTab';
import { FilesTab } from './FilesTab';
import { GitTab } from './GitTab';
import { TerminalTab } from './TerminalTab';
import { PlanTab } from './PlanTab';
import { PreviewTab } from './PreviewTab';
import { IntelligenceTab } from './IntelligenceTab';
import { SkillsTab } from './SkillsTab';
import { OrchestratorTab } from './OrchestratorTab';
import { SettingsTab } from './SettingsTab';
import { useTranslation } from '@/lib/i18n';

export function InspectorPanel() {
  const { activeTab, setActiveTab, setInspectorOpen } = useAppStore();
  const { t, lang } = useTranslation();

  const tabs: { id: InspectorTab; label: string; icon: any }[] = [
    { id: 'activity', label: t('tab_activity'), icon: Activity },
    { id: 'files', label: t('tab_files'), icon: FileCode },
    { id: 'git', label: t('tab_git'), icon: GitBranch },
    { id: 'terminal', label: t('tab_terminal'), icon: Terminal },
    { id: 'plan', label: t('tab_plan'), icon: ListTodo },
    { id: 'preview', label: t('tab_preview'), icon: Globe },
    { id: 'intelligence', label: t('tab_ai_model'), icon: Cpu },
    { id: 'skills', label: t('tab_skills'), icon: Puzzle },
    { id: 'orchestrator', label: lang === 'vi' ? 'Trợ lý' : 'Agents', icon: Network },
    { id: 'settings', label: t('tab_settings'), icon: Settings },
  ];

  return (
    <aside className="w-full h-full flex flex-col bg-[var(--panel)] border-l border-[var(--line)] select-none min-w-0">
      {/* Tab Navigation Header */}
      <div className="border-b border-[var(--line)] flex items-start justify-between px-2 bg-[var(--panel)] flex-shrink-0">
        <nav aria-label="Công cụ làm việc" className="flex flex-wrap items-center gap-1 flex-1 py-2">
          {tabs.map((t) => {
            const Icon = t.icon;
            const isCurrent = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  isCurrent
                    ? 'bg-[var(--primary-bg)] text-[var(--primary)] border border-[var(--line)]'
                    : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]'
                }`}
                title={t.label}
                aria-pressed={isCurrent}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>

        <button
          onClick={() => setInspectorOpen(false)}
          className="p-1 mt-3 rounded text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] ml-1 flex-shrink-0"
          title="Đóng Inspector (Ctrl+J)"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tab Content Body */}
      <div className="flex-1 overflow-hidden min-h-0">
        {activeTab === 'activity' && <ActivityTab />}
        {activeTab === 'files' && <FilesTab />}
        {activeTab === 'git' && <GitTab />}
        {activeTab === 'terminal' && <TerminalTab />}
        {activeTab === 'plan' && <PlanTab />}
        {activeTab === 'preview' && <PreviewTab />}
        {activeTab === 'intelligence' && <IntelligenceTab />}
        {activeTab === 'skills' && <SkillsTab />}
        {activeTab === 'orchestrator' && <OrchestratorTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </aside>
  );
}
