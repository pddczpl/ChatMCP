import { useAppStore } from '@/store/useAppStore';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ChevronDown, Folder, PanelLeft, PanelRightClose, PanelRightOpen, Search, Settings, Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { StatusDot } from '@/components/ui/StatusDot';
import { useTranslation } from '@/lib/i18n';
import { BrandMark } from './BrandMark';
import { GitWorkspacePicker } from './GitWorkspacePicker';

/**
 * The top bar holds only what a person uses all the time: panels, where they are (workspace and branch), search, theme and
 * settings. Everything that is a state (connection, permission mode, model, context) lives in the status bar below.
 */
export function Header() {
  const queryClient = useQueryClient();
  const { data: hub, error } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 2500 });
  const { t } = useTranslation();
  const {
    theme,
    sidebarOpen,
    toggleSidebar,
    setTheme,
    inspectorOpen,
    toggleInspector,
    setCommandPaletteOpen,
    openSettings,
    showToast,
    selectedWorkspacePath,
    setSelectedWorkspacePath,
    setSelectedTaskId,
  } = useAppStore();

  const registered = hub?.workspaces?.items || [];
  const chosenPath = (selectedWorkspacePath && registered.some(x => x.path === selectedWorkspacePath)
    ? selectedWorkspacePath : hub?.workspaces
      ? hub.workspaces.activePath
      : hub?.workspace?.path) || '';
  const noWorkspace = !chosenPath;
  const workspacePath = chosenPath || t('agents_hdr_no_workspace');
  const shortWs = workspacePath.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';

  const handleBrowseWorkspace = async () => {
    try {
      const res = await api.browseWorkspace(noWorkspace ? null : workspacePath);
      if (res.path) {
        const added = await api.addWorkspace(res.path);
        await api.activateWorkspace(added.workspace.path);
        setSelectedWorkspacePath(added.workspace.path);
        setSelectedTaskId('');
        await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('agents_side_pick_failed'), 'error');
      // A disabled WinForms desktop/session must not block project selection.
      // Settings has a manual absolute-path input that needs no GUI process.
      openSettings('workspace');
    }
  };

  const isLight = theme === 'light';
  const connectionProblem = error ? t('hub_lost') : !hub ? t('hub_connecting') : '';

  return (
    <header className="z-20 flex h-12 shrink-0 select-none items-center gap-2 border-b border-line bg-panel px-2.5">
      {/* Where am I */}
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2">
        <Button variant="quiet" size="icon" onClick={toggleSidebar}
          aria-label={sidebarOpen ? t('agents_hdr_sidebar_close') : t('agents_hdr_sidebar_open')} title={`${t('agents_hdr_sidebar_list')} (Ctrl+B)`}>
          <PanelLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <BrandMark className="h-6 w-6 shrink-0" />
          <span className="hidden whitespace-nowrap sm:inline">DatGold<span className="hidden font-normal text-muted xl:inline"> Studio</span></span>
        </div>
        <span aria-hidden="true" className="hidden h-4 w-px bg-line md:block" />
        <button
          onClick={handleBrowseWorkspace}
          className="hidden h-8 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] font-medium transition-colors hover:border-line-strong hover:bg-hover md:flex"
          title={t('agents_hdr_folder_title', { path: workspacePath })}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="max-w-[160px] truncate">{shortWs}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-faint" />
        </button>
        <GitWorkspacePicker workspace={noWorkspace ? '' : workspacePath} />
      </div>

      {/* Search / commands */}
      <button
        onClick={() => setCommandPaletteOpen(true)}
        aria-label={t('agents_hdr_search_label')}
        className="flex h-8 w-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-line bg-surface text-[13px] text-muted transition-colors hover:border-line-strong hover:bg-hover hover:text-fg lg:w-full lg:max-w-[420px] lg:justify-start lg:px-3"
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-faint" />
        <span className="hidden flex-1 text-left lg:block">{t('header_search')}</span>
        <Kbd className="hidden lg:inline-flex">Ctrl K</Kbd>
      </button>

      {/* Quick controls */}
      <div className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-1">
        {connectionProblem && (
          <span role="status" className={`mr-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${error ? 'border-danger/40 bg-danger/10 text-danger' : 'border-warning/40 bg-warning/10 text-warning'}`}>
            <StatusDot tone={error ? 'danger' : 'warning'} pulse={!error} />
            <span title={error?.message}>{connectionProblem}</span>
          </span>
        )}
        <Button variant="quiet" size="icon" onClick={() => setTheme(isLight ? 'dark' : 'light')} title={t('header_theme_toggle')} aria-label={t('header_theme_toggle')}>
          {isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
        <Button variant="quiet" size="icon" onClick={() => openSettings()} title={`${t('header_settings')} (Ctrl+,)`} aria-label={t('header_settings')}>
          <Settings className="h-4 w-4" />
        </Button>
        <Button variant="quiet" size="icon" onClick={toggleInspector} aria-label={inspectorOpen ? t('agents_hdr_inspector_close') : t('agents_hdr_inspector_open')}
          title={`${inspectorOpen ? t('agents_hdr_inspector_close') : t('agents_hdr_inspector_open')} (Ctrl+J)`}>
          {inspectorOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
