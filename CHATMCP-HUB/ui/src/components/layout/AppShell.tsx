import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useAppStore } from '@/store/useAppStore';
import { Header } from '@/components/layout/Header';
import { SessionSidebar } from '@/components/sessions/SessionSidebar';
import { ConversationView } from '@/components/conversation/ConversationView';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { FullAccessDialog } from '@/components/approval/FullAccessDialog';
import { OnboardingModal } from '@/components/onboarding/OnboardingModal';
import { ToastContainer } from '@/components/ui/Toast';
import { useTaskStream } from '@/lib/useTaskStream';

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
    setCommandPaletteOpen 
  } = useAppStore();

  // Keyboard shortcuts listener for Ctrl+B, Ctrl+J, Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'b') {
          e.preventDefault();
          toggleSidebar();
        } else if (e.key.toLowerCase() === 'j') {
          e.preventDefault();
          toggleInspector();
        } else if (e.key.toLowerCase() === 'k') {
          e.preventDefault();
          setCommandPaletteOpen(!commandPaletteOpen);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, inspectorOpen, commandPaletteOpen, toggleSidebar, toggleInspector, setCommandPaletteOpen]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg)] text-[var(--text)] overflow-hidden select-none">
      {/* Top Navigation Header */}
      <Header />

      {/* Main Resizable Workspace Area */}
      <div className="flex-1 min-h-0 relative">
        <PanelGroup direction="horizontal" autoSaveId="chatmcp-readable-layout">
          {/* Left Session Sidebar */}
          {sidebarOpen && !compact && (
            <>
              <Panel defaultSize={18} minSize={14} maxSize={30} id="panel-sidebar">
                <SessionSidebar />
              </Panel>
              <PanelResizeHandle className="w-[3px] hover:w-[4px] bg-[var(--line-subtle)] hover:bg-sky-500/60 transition-colors cursor-col-resize active:bg-sky-500" />
            </>
          )}

          {/* Center Main Conversation Area */}
          <Panel defaultSize={sidebarOpen && inspectorOpen ? 48 : sidebarOpen || inspectorOpen ? 66 : 100} minSize={35} id="panel-conversation">
            <ConversationView />
          </Panel>

          {/* Right Inspector Panel */}
          {inspectorOpen && !compact && (
            <>
              <PanelResizeHandle className="w-[3px] hover:w-[4px] bg-[var(--line-subtle)] hover:bg-sky-500/60 transition-colors cursor-col-resize active:bg-sky-500" />
              <Panel defaultSize={34} minSize={26} maxSize={50} id="panel-inspector">
                <InspectorPanel />
              </Panel>
            </>
          )}
        </PanelGroup>
        {compact && sidebarOpen && <div className="absolute inset-y-0 left-0 w-72 max-w-full z-30 shadow-xl"><SessionSidebar /></div>}
        {compact && inspectorOpen && <div id="panel-inspector" className="absolute inset-y-0 right-0 w-[440px] max-w-full z-40 shadow-xl"><InspectorPanel /></div>}
      </div>

      {/* Overlays & Dialogs */}
      <CommandPalette />
      <FullAccessDialog />
      <OnboardingModal />

      {/* Global Toast Container */}
      <ToastContainer />
    </div>
  );
}
