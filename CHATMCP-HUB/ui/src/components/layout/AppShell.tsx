import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useAppStore } from '@/store/useAppStore';
import { Header } from '@/components/layout/Header';
import { StatusBar } from '@/components/layout/StatusBar';
import { FullAccessBanner } from '@/components/layout/FullAccessBanner';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { ConversationView } from '@/components/conversation/ConversationView';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { SettingsView } from '@/components/settings/SettingsView';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { FullAccessDialog } from '@/components/approval/FullAccessDialog';
import { OnboardingModal } from '@/components/onboarding/OnboardingModal';
import { ToastContainer } from '@/components/ui/Toast';
import { useTaskStream } from '@/lib/useTaskStream';

const resizeHandle = 'relative w-px bg-line transition-colors before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""] hover:bg-primary/60 data-[resize-handle-active]:bg-primary';

export function AppShell() {
  useTaskStream();
  const [compact, setCompact] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    if (compact) {
      useAppStore.getState().setSidebarOpen(false);
      useAppStore.getState().setInspectorOpen(false);
    }
  }, [compact]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1099px)');
    const sync = () => setCompact(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const {
    sidebarOpen,
    toggleSidebar,
    inspectorOpen,
    toggleInspector,
    commandPaletteOpen,
    setCommandPaletteOpen,
    openSettings,
  } = useAppStore();

  // Keyboard shortcuts: Ctrl+B sessions, Ctrl+J work panel, Ctrl+K commands, Ctrl+, settings.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Settings covers the page: its own shortcuts are for the page behind it.
      if (useAppStore.getState().settingsOpen) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (key === 'j') {
        e.preventDefault();
        toggleInspector();
      } else if (key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      } else if (key === ',') {
        e.preventDefault();
        openSettings();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, inspectorOpen, commandPaletteOpen, toggleSidebar, toggleInspector, setCommandPaletteOpen, openSettings]);

  return (
    <div className="flex h-screen w-screen select-none flex-col overflow-hidden bg-bg text-fg">
      <Header />
      <FullAccessBanner />

      {/* Main resizable workspace area */}
      <div className="relative min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="chatmcp-layout-v2">
          {sidebarOpen && !compact && (
            <>
              <Panel defaultSize={17} minSize={14} maxSize={28} id="panel-sidebar" order={1}>
                <SessionSidebar />
              </Panel>
              <PanelResizeHandle className={resizeHandle} />
            </>
          )}

          <Panel defaultSize={sidebarOpen && inspectorOpen ? 50 : sidebarOpen || inspectorOpen ? 67 : 100} minSize={36} id="panel-conversation" order={2}>
            <ConversationView />
          </Panel>

          {inspectorOpen && !compact && (
            <>
              <PanelResizeHandle className={resizeHandle} />
              <Panel defaultSize={33} minSize={24} maxSize={48} id="panel-inspector" order={3}>
                <InspectorPanel />
              </Panel>
            </>
          )}
        </PanelGroup>
        {compact && sidebarOpen && <div className="absolute inset-y-0 left-0 z-30 w-72 max-w-full shadow-[var(--shadow-pop)]"><SessionSidebar /></div>}
        {compact && inspectorOpen && <div id="panel-inspector" className="absolute inset-y-0 right-0 z-40 w-[440px] max-w-full shadow-[var(--shadow-pop)]"><InspectorPanel /></div>}
      </div>

      <StatusBar />

      {/* Overlays & dialogs */}
      <SettingsView />
      <CommandPalette />
      <FullAccessDialog />
      <OnboardingModal />
      <ToastContainer />
    </div>
  );
}
