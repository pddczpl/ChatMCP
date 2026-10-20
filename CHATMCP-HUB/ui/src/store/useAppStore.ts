import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'system';
export type Language = 'vi' | 'en';
/** The tabs of the right-hand work panel. Model, skills, permissions and the rest live in the Settings view. */
export type InspectorTab = 'plan' | 'changes' | 'files' | 'terminal' | 'activity' | 'agents' | 'preview';
export type SettingsSection = 'workspace' | 'model' | 'permissions' | 'agent-channel' | 'skills' | 'code-intelligence' | 'appearance' | 'about';

interface ToastState {
  message: string;
  type?: 'info' | 'success' | 'error' | 'warning';
}

interface AppStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  lang: Language;
  setLang: (lang: Language) => void;
  selectedTaskId: string;
  setSelectedTaskId: (id: string) => void;
  selectedWorkspacePath: string;
  setSelectedWorkspacePath: (path: string) => void;
  inspectorOpen: boolean;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  activeTab: InspectorTab;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  selectedBaseRef: string;
  setSelectedBaseRef: (ref: string) => void;
  setActiveTab: (tab: InspectorTab) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  fullAccessModalOpen: boolean;
  setFullAccessModalOpen: (open: boolean) => void;
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  toast: ToastState | null;
  showToast: (message: string, type?: ToastState['type']) => void;
  clearToast: () => void;
  streamingToken: string;
  streamingTaskId: string;
  streamConnected: boolean;
  setStreamConnected: (connected: boolean) => void;
  appendTaskToken: (taskId: string, token: string) => void;
  appendStreamingToken: (token: string) => void;
  clearStreamingToken: () => void;
}

const initialTheme = (typeof window !== 'undefined' && (localStorage.getItem('chatmcp:theme') as Theme)) || 'dark';
const initialLang = (typeof window !== 'undefined' && (localStorage.getItem('chatmcp:language') as Language)) || 'vi';
const initialTask = (typeof window !== 'undefined' && localStorage.getItem('chatmcp:selected-conversation')) || '';

export const useAppStore = create<AppStore>((set) => ({
  theme: initialTheme,
  setTheme: (theme) => {
    localStorage.setItem('chatmcp:theme', theme);
    const resolved = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : theme;
    document.documentElement.setAttribute('data-theme', resolved);
    set({ theme });
  },
  lang: initialLang,
  setLang: (lang) => {
    localStorage.setItem('chatmcp:language', lang);
    set({ lang });
  },
  selectedTaskId: initialTask,
  selectedWorkspacePath: (typeof window !== 'undefined' && localStorage.getItem('chatmcp:selected-workspace')) || '',
  setSelectedWorkspacePath: (folder) => {
    if (folder) localStorage.setItem('chatmcp:selected-workspace', folder);
    else localStorage.removeItem('chatmcp:selected-workspace');
    set({selectedWorkspacePath:folder,selectedBaseRef:''});
  },
  setSelectedTaskId: (id) => {
    if (id) localStorage.setItem('chatmcp:selected-conversation', id);
    else localStorage.removeItem('chatmcp:selected-conversation');
    set({ selectedTaskId: id, streamingToken: '', streamingTaskId: '' });
  },
  inspectorOpen: true,
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  activeTab: 'plan',
  settingsOpen: false,
  settingsSection: 'workspace',
  openSettings: (section) => set((state) => ({ settingsOpen: true, settingsSection: section ?? state.settingsSection })),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  selectedBaseRef: '',
  setSelectedBaseRef: (selectedBaseRef) => set({selectedBaseRef}),
  setActiveTab: (tab) => set({ activeTab: tab, inspectorOpen: true }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  fullAccessModalOpen: false,
  setFullAccessModalOpen: (open) => set({ fullAccessModalOpen: open }),
  onboardingOpen: false,
  setOnboardingOpen: (open) => set({ onboardingOpen: open }),
  toast: null,
  showToast: (message, type = 'info') => {
    set({ toast: { message, type } });
    if (type !== 'error') {
      setTimeout(() => {
        set((s) => (s.toast?.message === message ? { toast: null } : {}));
      }, 5000);
    }
  },
  clearToast: () => set({ toast: null }),
  streamingToken: '',
  streamingTaskId: '',
  streamConnected: false,
  setStreamConnected: (streamConnected) => set({ streamConnected }),
  appendTaskToken: (taskId, token) => set((s) => taskId === s.selectedTaskId
    ? { streamingTaskId: taskId, streamingToken: (s.streamingTaskId === taskId ? s.streamingToken : '') + token }
    : {}),
  appendStreamingToken: (token) => set((s) => ({ streamingToken: s.streamingToken + token })),
  clearStreamingToken: () => set({ streamingToken: '', streamingTaskId: '' }),
}));
