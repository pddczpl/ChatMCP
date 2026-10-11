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
import { SettingsTab } from './SettingsTab';

export function InspectorPanel() {
  const { activeTab, setActiveTab, setInspectorOpen } = useAppStore();

  const tabs: { id: InspectorTab; label: string; icon: any }[] = [
    { id: 'activity', label: 'Hoạt động', icon: Activity },
    { id: 'files', label: 'Tệp', icon: FileCode },
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'terminal', label: 'Terminal', icon: Terminal },
    { id: 'plan', label: 'Kế hoạch', icon: ListTodo },
    { id: 'preview', label: 'Preview', icon: Globe },
    { id: 'intelligence', label: 'AI Model', icon: Cpu },
    { id: 'skills', label: 'Skills', icon: Puzzle },
    { id: 'settings', label: 'Cài đặt', icon: Settings },
  ];

  return (
    <aside className="w-full h-full flex flex-col bg-[var(--panel)] border-l border-[var(--line)] select-none min-w-0">
      {/* Tab Navigation Header */}
      <div className="h-10 border-b border-[var(--line)] flex items-center justify-between px-2 bg-[var(--surface)] flex-shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar flex-1 py-1">
          {tabs.map((t) => {
            const Icon = t.icon;
            const isCurrent = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                  isCurrent
                    ? 'bg-[var(--panel)] text-sky-400 border border-[var(--line)] shadow-sm'
                    : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]'
                }`}
                title={t.label}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">{t.label}</span>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setInspectorOpen(false)}
          className="p-1 rounded text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] ml-1 flex-shrink-0"
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
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </aside>
  );
}
