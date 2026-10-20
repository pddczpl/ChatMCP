import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, FolderOpen, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SettingsCard } from './SettingsCard';
import { ProjectInstructionsCard } from './ProjectInstructionsCard';

/** The folder the agent works in. */
export function WorkspaceSection() {
  const { showToast, setOnboardingOpen, selectedWorkspacePath, setSelectedWorkspacePath, closeSettings } = useAppStore();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });

  const currentWs = (hub?.workspaces?.items?.some(w => w.path === selectedWorkspacePath) ? selectedWorkspacePath :
    hub?.workspaces?.activePath) || hub?.workspace?.path || '';
  const [wsInput, setWsInput] = useState(currentWs);
  const [applyingWs, setApplyingWs] = useState(false);

  useEffect(() => {
    if (currentWs && !wsInput) setWsInput(currentWs);
  }, [currentWs]);

  const handleBrowseWs = async () => {
    try {
      const res = await api.browseWorkspace(currentWs || null);
      if (res.path) {
        const added = await api.addWorkspace(res.path);
        await api.activateWorkspace(added.workspace.path);
        setWsInput(added.workspace.path);
        setSelectedWorkspacePath(added.workspace.path);
        await queryClient.invalidateQueries({ queryKey: ['hubState'] });
        showToast(`${t('workspace_changed_toast')}: ${added.workspace.path}`, 'success');
      }
    } catch (err: any) {
      showToast(err.message || 'Lỗi duyệt thư mục', 'error');
    }
  };

  const handleApplyWs = async () => {
    if (!wsInput.trim()) return;
    setApplyingWs(true);
    try {
      const added = await api.addWorkspace(wsInput.trim());
      await api.activateWorkspace(added.workspace.path);
      setWsInput(added.workspace.path);
      setSelectedWorkspacePath(added.workspace.path);
      await queryClient.invalidateQueries({ queryKey: ['hubState'] });
      showToast(`${t('workspace_changed_toast')}: ${added.workspace.path}`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Lỗi thay đổi thư mục', 'error');
    } finally {
      setApplyingWs(false);
    }
  };

  return (
    <div className="space-y-5">
      <SettingsCard icon={FolderOpen} title={t('workspace_setting_title')} description={t('workspace_setting_desc')}>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            aria-label="Đường dẫn thư mục dự án"
            value={wsInput}
            onChange={(e) => setWsInput(e.target.value)}
            placeholder="Đường dẫn thư mục dự án…"
            className="flex-1 font-mono text-[12px]"
          />
          <Button variant="secondary" onClick={handleBrowseWs} className="gap-1.5">
            <Folder className="h-3.5 w-3.5 text-primary" />
            <span>{t('workspace_browse_btn')}</span>
          </Button>
          <Button variant="primary" onClick={handleApplyWs} disabled={applyingWs || !wsInput.trim() || wsInput === currentWs}>
            {t('workspace_apply_btn')}
          </Button>
        </div>
        {currentWs && (
          <p className="truncate font-mono text-[12px] text-muted" title={currentWs}>
            <span className="text-faint">Đang dùng: </span>
            <span className="font-semibold text-success">{currentWs}</span>
          </p>
        )}
        <p className="text-[12px] leading-4 text-faint">
          File nhạy cảm (.env, khóa riêng, thư mục .git) luôn được bảo vệ khỏi agent, kể cả ở chế độ Tự động.
        </p>
      </SettingsCard>

      <ProjectInstructionsCard />

      <SettingsCard icon={Sparkles} title="Hướng dẫn khởi động" description="Chạy lại các bước chọn thư mục, kết nối AI và chọn quyền.">
        <Button variant="secondary" onClick={() => { closeSettings(); setOnboardingOpen(true); }} title={t('workspace_reopen_onboarding')}>
          {t('workspace_reopen_onboarding')}
        </Button>
      </SettingsCard>
    </div>
  );
}
