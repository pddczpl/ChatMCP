import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Loader2, Plus, Puzzle, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

type Skill = {
  id: string; name: string; description?: string; category?: string; author?: string;
  version?: string; enabled?: boolean; provenance?: string; tools?: string[];
  dependencies?: { unresolved?: string[] };
};
type RegistrySkill = Skill & { key: string; repo: string; revision?: string; license?: string };
const installedKey = ['pluginsInstalled'];
const fieldClass = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-fg focus:outline-none focus:ring-2 focus:ring-primary';

export function SkillsTab() {
  const showToast = useAppStore((state) => state.showToast);
  const { t, lang } = useTranslation();
  const copy = (vi: string, en: string) => lang === 'vi' ? vi : en;
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'discover' | 'installed'>('discover');
  const [category, setCategory] = useState('all');
  const [visibleCount, setVisibleCount] = useState(30);
  const [pending, setPending] = useState<{ id: string; action: string } | null>(null);
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryError, setRegistryError] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceRepo, setSourceRepo] = useState('');
  const [sourcePrefix, setSourcePrefix] = useState('skills');
  const [showAddModal, setShowAddModal] = useState(false);
  const [customError, setCustomError] = useState('');
  const [installMode, setInstallMode] = useState<'url' | 'manual'>('url');
  const [manifestUrl, setManifestUrl] = useState('');
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  // Discovery and the curated marketplace do not include all installed/custom
  // skills. Always use the unfiltered installed endpoint for lifecycle state.
  const installedQuery = useQuery({ queryKey: installedKey, queryFn: api.getInstalledPlugins, refetchInterval: 5000, retry: false });
  const marketplaceQuery = useQuery({ queryKey: ['pluginsMarketplace', 'all', ''], queryFn: () => api.getMarketplace(), retry: false });
  const registryQuery = useQuery({ queryKey: ['skillsRegistry', search], queryFn: () => api.getSkillRegistry(search), refetchInterval: 12000, retry: false });
  const installed: Skill[] = installedQuery.data?.plugins || [];
  const installedById = new Map(installed.map((skill) => [skill.id, skill]));
  const registry: RegistrySkill[] = registryQuery.data?.skills || [];
  const registryById = new Map<string, RegistrySkill>([...(registryQuery.data?.updates || []), ...registry].map((skill) => [skill.id, skill]));
  const updateKeys = new Set((registryQuery.data?.updates || []).map((skill) => skill.key));
  const catalog = new Map<string, Skill>();
  for (const skill of marketplaceQuery.data?.catalog || []) catalog.set(skill.id, skill);
  for (const skill of registry) catalog.set(skill.id, { ...skill, category: 'skills' });
  for (const skill of installed) catalog.set(skill.id, { ...catalog.get(skill.id), ...skill });
  const query = search.trim().toLowerCase();
  const filtered = [...catalog.values()].filter((skill) =>
    (view !== 'installed' || installedById.has(skill.id)) &&
    (category === 'all' || skill.category === category) &&
    (!query || [skill.name, skill.id, skill.description, registryById.get(skill.id)?.repo].join(' ').toLowerCase().includes(query))
  );
  const stateReady = installedQuery.isSuccess;
  const syncSkills = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: installedKey }),
      client.invalidateQueries({ queryKey: ['pluginsMarketplace'] }),
      client.invalidateQueries({ queryKey: ['skillsRegistry'] }),
      client.invalidateQueries({ queryKey: ['hubState'] }),
    ]);
  };
  const cacheInstalled = async (skill: Skill) => {
    // Cancel old polls before applying the server-confirmed result so Install
    // cannot flash back while the post-mutation refresh is in flight.
    await client.cancelQueries({ queryKey: installedKey });
    client.setQueryData<{ plugins: Skill[] }>(installedKey, (data) => ({
      ...data, plugins: [...(data?.plugins || []).filter((item) => item.id !== skill.id), skill],
    }));
  };
  const runAction = async (skill: Skill, action: 'install' | 'update' | 'toggle' | 'uninstall') => {
    if (pending) return;
    const labels = {
      install: copy('Đang cài…', 'Installing…'), update: copy('Đang cập nhật…', 'Updating…'),
      toggle: skill.enabled ? copy('Đang tắt…', 'Disabling…') : copy('Đang bật…', 'Enabling…'),
      uninstall: copy('Đang gỡ…', 'Removing…'),
    };
    setPending({ id: skill.id, action: labels[action] });
    try {
      if (action === 'install' || action === 'update') {
        const entry = registryById.get(skill.id);
        const response = entry ? await api.installRegistrySkill(entry.key, action === 'update') : await api.installPlugin(skill.id);
        await cacheInstalled(response.installed);
        showToast(`${action === 'update' ? copy('Đã cập nhật', 'Updated') : copy('Đã cài', 'Installed')} ${skill.name}${response.installed.enabled ? '' : copy('. Nhấn Bật để sử dụng.', '. Select Enable to use it.')}`, 'success');
        if (response.installed.missingDependencies?.length) showToast(copy('Kỹ năng có tài liệu tham chiếu chưa tải được. Xem chi tiết trước khi bật.', 'Some referenced files are missing. Review details before enabling.'), 'warning');
      } else if (action === 'toggle') {
        const response = await api.togglePlugin(skill.id, !skill.enabled);
        await cacheInstalled({ ...skill, enabled: response.enabled });
        showToast(`${response.enabled ? copy('Đã bật', 'Enabled') : copy('Đã tắt', 'Disabled')} ${skill.name}`, 'success');
      } else {
        await api.uninstallPlugin(skill.id);
        await client.cancelQueries({ queryKey: installedKey });
        client.setQueryData<{ plugins: Skill[] }>(installedKey, (data) => ({ ...data, plugins: (data?.plugins || []).filter((item) => item.id !== skill.id) }));
        showToast(`${copy('Đã gỡ cài đặt', 'Uninstalled')} ${skill.name}`, 'info');
      }
    } catch (error: any) { showToast(error.message || copy('Chưa thực hiện được. Vui lòng thử lại.', 'Could not complete the action. Please retry.'), 'error'); }
    finally { await syncSkills(); setPending(null); }
  };
  const refreshRegistry = async () => {
    setRegistryBusy(true); setRegistryError('');
    try {
      const result = await api.refreshSkillRegistry();
      await client.invalidateQueries({ queryKey: ['skillsRegistry'] });
      if (result.failures?.length) {
        setRegistryError(result.failures.map((failure: any) => `${failure.source}: ${failure.error}`).join('; '));
        showToast(copy('Một số nguồn chưa tải được. Danh sách đã lưu vẫn được giữ lại.', 'Some sources could not refresh. Saved results remain available.'), 'warning');
      } else showToast(copy(`Đã làm mới ${result.found} kỹ năng.`, `Refreshed ${result.found} skills.`), 'success');
    } catch (error: any) { setRegistryError(error.message); }
    finally { setRegistryBusy(false); }
  };
  const handleAddCustomSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setCustomError('');
    if (installMode === 'url' ? !/^https?:\/\//i.test(manifestUrl.trim()) : !customId.trim() || !customName.trim()) {
      setCustomError(installMode === 'url' ? copy('Nhập URL bắt đầu bằng http:// hoặc https://.', 'Enter a URL beginning with http:// or https://.') : copy('Nhập mã và tên kỹ năng trước khi cài.', 'Enter the skill ID and name before installing.'));
      return;
    }
    setPending({ id: 'custom', action: copy('Đang cài…', 'Installing…') });
    try {
      const response: any = await api.request('/api/plugins/install', { method: 'POST', body: JSON.stringify(installMode === 'url'
        ? { url: manifestUrl.trim() }
        : { id: customId.trim().toLowerCase(), custom: { name: customName.trim(), description: customDesc.trim(), category: 'custom', systemPrompt: customPrompt.trim(), tools: ['custom_online_tool'] } }) });
      await cacheInstalled(response.installed);
      showToast(`${copy('Đã cài', 'Installed')} ${response.installed.name}`, 'success');
      setShowAddModal(false); setView('installed'); setSearch(''); setCategory('all');
      setManifestUrl(''); setCustomId(''); setCustomName(''); setCustomDesc(''); setCustomPrompt('');
    } catch (error: any) {
      const message = error.message || copy('Không thể cài kỹ năng. Vui lòng thử lại.', 'Could not install skill. Please retry.');
      setCustomError(message);
      showToast(message, 'error');
    }
    finally { await syncSkills(); setPending(null); }
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-[13px] leading-relaxed text-fg">
      <header className="space-y-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold"><Puzzle className="h-4 w-4 text-primary" />{copy('Kỹ năng cho trợ lý', 'Assistant skills')}</h2>
        <p className="text-muted">{copy('Thêm hướng dẫn chuyên môn để trợ lý làm việc phù hợp hơn với bạn.', 'Add specialized instructions to help your assistant work your way.')}</p>
      </header>
      <div className="flex gap-1 rounded-lg bg-surface p-1" aria-label={copy('Danh sách kỹ năng', 'Skill lists')}>
        {(['discover', 'installed'] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => { setView(item); setCategory('all'); setVisibleCount(30); }}
          className={`min-h-9 flex-1 rounded-md px-2 py-1.5 font-medium focus-visible:outline-2 focus-visible:outline-primary ${view === item ? 'bg-panel text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>
          {item === 'discover' ? copy('Khám phá', 'Discover') : `${copy('Đã cài', 'Installed')}${stateReady ? ` (${installed.length})` : ''}`}
        </button>)}
      </div>
      <div className="space-y-2">
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted" />
          <input aria-label={copy('Tìm kỹ năng', 'Search skills')} value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(30); }} placeholder={copy('Tìm tên hoặc công việc cần hỗ trợ…', 'Search by name or task…')} className={`${fieldClass} pl-9`} />
        </div>
        <div className="flex items-center gap-2">
          <select aria-label={copy('Lọc theo loại kỹ năng', 'Filter skill category')} value={category} onChange={(event) => { setCategory(event.target.value); setVisibleCount(30); }} className={`${fieldClass} min-w-0 flex-1`}>
            <option value="all">{t('cat_all')}</option><option value="coding">{t('cat_coding')}</option><option value="devops">{t('cat_devops')}</option><option value="research">{t('cat_research')}</option><option value="governance">{t('cat_governance')}</option><option value="data">{t('cat_data')}</option><option value="skills">GitHub Skills</option><option value="custom">{copy('Tự thêm', 'Custom')}</option>
          </select>
          <Button disabled={registryBusy || Boolean(pending)} onClick={refreshRegistry} className="h-10 shrink-0 text-[13px]"><RefreshCw className={`h-4 w-4 ${registryBusy ? 'animate-spin' : ''}`} />{registryBusy ? copy('Đang tải…', 'Loading…') : copy('Làm mới', 'Refresh')}</Button>
        </div>
      </div>
      {(installedQuery.error || marketplaceQuery.error || registryQuery.error || registryError) && <div role="alert" className="rounded-lg border border-line bg-surface p-3 text-danger">
        <p>{copy('Chưa tải được đầy đủ danh sách kỹ năng.', 'Could not load the complete skills list.')}</p>
        <p className="mt-1 break-words text-muted">{installedQuery.error?.message || marketplaceQuery.error?.message || registryQuery.error?.message || registryError}</p>
        <Button className="mt-2 text-[13px]" onClick={registryError ? refreshRegistry : syncSkills}>{copy('Thử lại', 'Retry')}</Button>
      </div>}
      <section aria-label={copy('Kỹ năng', 'Skills')} className="space-y-3">
        {installedQuery.isLoading || marketplaceQuery.isLoading ? <p role="status" className="flex items-center gap-2 py-6 text-muted"><Loader2 className="h-4 w-4 animate-spin" />{copy('Đang tải kỹ năng…', 'Loading skills…')}</p>
          : filtered.length === 0 ? <div className="py-8 text-center text-muted"><Puzzle className="mx-auto mb-3 h-7 w-7" /><p>{view === 'installed' && !search ? copy('Bạn chưa cài kỹ năng nào.', 'No skills installed yet.') : copy('Không tìm thấy kỹ năng phù hợp.', 'No matching skills.')}</p>{view === 'installed' && <Button onClick={() => { setView('discover'); setSearch(''); setCategory('all'); }} className="mt-3 text-[13px]">{copy('Khám phá kỹ năng', 'Explore skills')}</Button>}</div>
          : filtered.slice(0, visibleCount).map((skill) => {
            const current = installedById.get(skill.id);
            const entry = registryById.get(skill.id);
            const hasUpdate = Boolean(current && entry && updateKeys.has(entry.key));
            const isBusy = pending?.id === skill.id;
            return <article key={skill.id} aria-label={skill.name} aria-busy={isBusy} className="rounded-lg border border-line bg-panel p-3 space-y-3">
              <div className="space-y-1">
                <h3 className="break-words text-[14px] font-semibold">{skill.name}</h3>
                <p className="break-words text-[12px] text-muted">{entry?.repo || (skill.author === 'ChatMCP Team' ? 'ChatMCP' : skill.author && skill.author !== 'unknown' ? skill.author : copy('Kỹ năng tự thêm', 'Custom skill'))}</p>
                {skill.description && <p className="text-muted">{skill.description}</p>}
              </div>
              <div className="space-y-2 border-t border-line-subtle pt-3">
                <p className={`flex flex-wrap items-center gap-1.5 font-medium ${current?.enabled ? 'text-success' : 'text-muted'}`}>
                  {current && <Check className="h-4 w-4" />}
                  {current ? (current.enabled ? copy('Đã cài · Đang bật', 'Installed · Enabled') : copy('Đã cài · Đang tắt', 'Installed · Disabled')) : stateReady ? copy('Chưa cài', 'Not installed') : copy('Chưa xác định trạng thái cài đặt', 'Installation state unavailable')}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {isBusy ? <span role="status" className="inline-flex min-h-9 items-center gap-2 text-muted"><Loader2 className="h-4 w-4 animate-spin" />{pending.action}</span> : current ? <>
                    <Button disabled={Boolean(pending) || !stateReady} onClick={() => runAction(current, 'toggle')} className="h-9 text-[13px]" variant={current.enabled ? 'outline' : 'primary'}>{current.enabled ? copy('Tắt', 'Disable') : copy('Bật', 'Enable')}</Button>
                    {hasUpdate && <Button disabled={Boolean(pending) || registryBusy || !stateReady} onClick={() => runAction(current, 'update')} className="h-9 text-[13px]"><RefreshCw className="h-3.5 w-3.5" />{copy('Cập nhật', 'Update')}</Button>}
                    <Button disabled={Boolean(pending) || !stateReady} onClick={() => runAction(current, 'uninstall')} variant="quiet" className="h-9 text-[13px] text-danger hover:text-danger"><Trash2 className="h-3.5 w-3.5" />{copy('Gỡ cài đặt', 'Uninstall')}</Button>
                  </> : <Button disabled={Boolean(pending) || registryBusy || !stateReady} onClick={() => runAction(skill, 'install')} variant="primary" className="h-9 text-[13px]"><Download className="h-3.5 w-3.5" />{copy('Cài đặt', 'Install')}</Button>}
                </div>
                {current && !current.enabled && <p className="text-[12px] text-muted">{copy('Nhấn Bật để trợ lý dùng kỹ năng này.', 'Enable this skill to let your assistant use it.')}</p>}
                {hasUpdate && <p className="text-[12px] text-muted">{copy('Có bản mới. Sau khi cập nhật, hãy kiểm tra rồi bật lại.', 'Update available. Review and re-enable after updating.')}</p>}
              </div>
              {(skill.tools?.length || entry || skill.version || current?.dependencies?.unresolved?.length) ? <details className="text-[12px] text-muted"><summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-primary">{copy('Chi tiết kỹ năng', 'Skill details')}</summary><div className="mt-2 space-y-1 break-words">
                {skill.version && <p>{copy('Phiên bản', 'Version')}: {skill.version}</p>}
                {skill.tools?.length ? <p>{copy('Công cụ', 'Tools')}: {skill.tools.join(', ')}</p> : null}
                {entry && <><p>{copy('Nguồn', 'Source')}: {entry.repo}</p><p>{copy('Giấy phép khai báo', 'Declared license')}: {entry.license || 'unknown'}</p><p>{copy('Chỉ tải hướng dẫn và tệp đi kèm; không tự chạy mã khi cài.', 'Installation downloads instructions and supporting files; it does not execute their scripts.')}</p></>}
                {current?.dependencies?.unresolved?.length ? <p className="text-warning">{copy('Thiếu tệp tham chiếu', 'Missing referenced files')}: {current.dependencies.unresolved.join(', ')}</p> : null}
              </div></details> : null}
            </article>;
          })}
        {filtered.length > visibleCount && <Button className="h-9 w-full text-[13px]" onClick={() => setVisibleCount((count) => count + 30)}>{copy(`Xem thêm (${filtered.length - visibleCount})`, `Show more (${filtered.length - visibleCount})`)}</Button>}
        {!search && view === 'discover' && registry.length === 0 && !registryQuery.isLoading && <p className="text-muted">{copy('Nhấn Làm mới để khám phá thêm kỹ năng từ GitHub.', 'Select Refresh to discover more skills from GitHub.')}</p>}
      </section>
      <details className="border-t border-line pt-3 text-muted">
        <summary className="cursor-pointer py-1 font-medium focus-visible:outline-2 focus-visible:outline-primary">{copy('Nguồn kỹ năng & tùy chỉnh', 'Skill sources & customization')}</summary>
        <div className="mt-3 space-y-3">
          <p>{copy('Các nguồn GitHub được phép. Nguồn bên ngoài cần được bạn tin cậy trước khi thêm.', 'Allowed GitHub sources. Only add third-party sources you trust.')}</p>
          <ul className="space-y-2">{(registryQuery.data?.sources || []).map((source: any) => <li key={source.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{source.repo}</span>{!source.official && <Button size="sm" disabled={registryBusy} onClick={async () => {
            if (prompt(copy(`Nhập REMOVE GITHUB SOURCE để gỡ nguồn ${source.repo}`, `Type REMOVE GITHUB SOURCE to remove ${source.repo}`)) !== 'REMOVE GITHUB SOURCE') return;
            setRegistryBusy(true);
            try { await api.removeRegistrySource(source.id); await client.invalidateQueries({ queryKey: ['skillsRegistry'] }); showToast(copy('Đã gỡ nguồn.', 'Source removed.'), 'info'); }
            catch (error: any) { showToast(error.message, 'error'); }
            finally { setRegistryBusy(false); }
          }} className="text-[13px]">{copy('Gỡ nguồn', 'Remove source')}</Button>}</li>)}</ul>
          <form className="space-y-2" onSubmit={async (event) => {
            event.preventDefault();
            if (prompt(copy('Chỉ thêm kho mã bạn tin cậy. Nhập TRUST GITHUB SOURCE để xác nhận.', 'Only add a repository you trust. Type TRUST GITHUB SOURCE to confirm.')) !== 'TRUST GITHUB SOURCE') return;
            setRegistryBusy(true);
            try { await api.addRegistrySource(sourceId.trim(), sourceRepo.trim(), sourcePrefix.trim()); await client.invalidateQueries({ queryKey: ['skillsRegistry'] }); showToast(copy('Đã thêm nguồn. Nhấn Làm mới để tải kỹ năng.', 'Source added. Select Refresh to load its skills.'), 'success'); setSourceId(''); setSourceRepo(''); }
            catch (error: any) { showToast(error.message, 'error'); }
            finally { setRegistryBusy(false); }
          }}>
            <label className="block">{copy('Mã định danh nguồn', 'Source ID')}<input required value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="my-skills" className={fieldClass} /></label>
            <label className="block">{copy('Kho mã GitHub', 'GitHub repository')}<input required value={sourceRepo} onChange={(event) => setSourceRepo(event.target.value)} placeholder="owner/repository" className={fieldClass} /></label>
            <label className="block">{copy('Thư mục kỹ năng', 'Skills folder')}<input required value={sourcePrefix} onChange={(event) => setSourcePrefix(event.target.value)} placeholder="skills" className={fieldClass} /></label>
            <Button type="submit" disabled={registryBusy} className="h-9 text-[13px]"><Plus className="h-4 w-4" />{copy('Thêm nguồn GitHub', 'Add GitHub source')}</Button>
          </form>
          <Button onClick={() => { setCustomError(''); setShowAddModal(true); }} className="h-9 text-[13px]"><Plus className="h-4 w-4" />{copy('Thêm kỹ năng từ URL hoặc tự viết', 'Add a skill from URL or write your own')}</Button>
        </div>
      </details>
      <Modal open={showAddModal} onOpenChange={setShowAddModal} title={copy('Thêm kỹ năng', 'Add skill')} description={copy('Cài từ đường dẫn đến tệp hướng dẫn hoặc tự viết hướng dẫn cho trợ lý.', 'Install from an instruction file URL or write instructions for your assistant.')} className="text-[13px]">
          <form onSubmit={handleAddCustomSkill} onInvalid={() => setCustomError(copy('Kiểm tra các trường bắt buộc và định dạng URL trước khi cài.', 'Check the required fields and URL format before installing.'))} className="space-y-3">
            <div className="flex gap-2">{(['url', 'manual'] as const).map((mode) => <Button type="button" key={mode} aria-pressed={installMode === mode} variant={installMode === mode ? 'primary' : 'outline'} onClick={() => setInstallMode(mode)} className="h-9 flex-1 text-[13px]">{mode === 'url' ? copy('Từ URL', 'From URL') : copy('Tự viết', 'Write your own')}</Button>)}</div>
            {installMode === 'url' ? <label className="block">{copy('URL tệp kỹ năng', 'Skill file URL')}<input type="url" required pattern="https?://.*" value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} placeholder="https://…/SKILL.md" className={fieldClass} /></label> : <>
              <label className="block">{copy('Mã kỹ năng', 'Skill ID')}<input required value={customId} onChange={(event) => setCustomId(event.target.value)} placeholder="my-skill" className={fieldClass} /></label>
              <label className="block">{copy('Tên kỹ năng', 'Skill name')}<input required value={customName} onChange={(event) => setCustomName(event.target.value)} className={fieldClass} /></label>
              <label className="block">{copy('Mô tả ngắn', 'Short description')}<input value={customDesc} onChange={(event) => setCustomDesc(event.target.value)} className={fieldClass} /></label>
              <label className="block">{copy('Hướng dẫn cho trợ lý', 'Assistant instructions')}<textarea rows={4} value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} className={fieldClass} /></label>
            </>}
            {customError && <p role="alert" className="rounded-lg border border-danger bg-danger/10 p-3 text-danger">{customError}</p>}
            <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="quiet" className="h-9 text-[13px]" onClick={() => setShowAddModal(false)}>{copy('Hủy', 'Cancel')}</Button><Button type="submit" disabled={Boolean(pending)} variant="primary" className="h-9 text-[13px]">{pending?.id === 'custom' && <Loader2 className="h-4 w-4 animate-spin" />}{pending?.id === 'custom' ? copy('Đang cài…', 'Installing…') : copy('Cài kỹ năng', 'Install skill')}</Button></div>
          </form>
      </Modal>
    </div>
  );
}
