import { create } from 'zustand';

export type Theme = 'dark' | 'light' | 'system';
export type InspectorTab = 'activity' | 'files' | 'git' | 'terminal' | 'intelligence' | 'preview' | 'plan' | 'skills' | 'settings';

interface ToastState {
  message: string;
  type?: 'info' | 'success' | 'error' | 'warning';
}

interface AppStore {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  selectedTaskId: string;
  setSelectedTaskId: (id: string) => void;
  inspectorOpen: boolean;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  activeTab: InspectorTab;
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
  appendStreamingToken: (token: string) => void;
  clearStreamingToken: () => void;
}

const initialTheme = (typeof window !== 'undefined' && (localStorage.getItem('chatmcp:theme') as Theme)) || 'dark';
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
  selectedTaskId: initialTask,
  setSelectedTaskId: (id) => {
    if (id) localStorage.setItem('chatmcp:selected-conversation', id);
    else localStorage.removeItem('chatmcp:selected-conversation');
    set({ selectedTaskId: id, streamingToken: '' });
  },
  inspectorOpen: true,
  toggleInspector: () => set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  activeTab: 'activity',
  setActiveTab: (tab) => set({ activeTab: tab }),
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
  appendStreamingToken: (token) => set((s) => ({ streamingToken: s.streamingToken + token })),
  clearStreamingToken: () => set({ streamingToken: '' }),
}));
