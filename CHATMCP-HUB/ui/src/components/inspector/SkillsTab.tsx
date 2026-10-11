import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { 
  Puzzle, 
  Search, 
  Check, 
  Download, 
  Trash2, 
  ShieldCheck, 
  Sparkles, 
  Plus, 
  Loader2, 
  Wrench, 
  ToggleLeft, 
  ToggleRight 
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export function SkillsTab() {
  const { showToast } = useAppStore();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  // Form for custom/online skill
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  // Fetch real marketplace & installed plugins from Hub backend
  const { data: marketplaceData, isLoading, refetch } = useQuery({
    queryKey: ['pluginsMarketplace', activeCategory, search],
    queryFn: () => api.getMarketplace(activeCategory === 'all' ? '' : activeCategory, search),
    refetchInterval: 5000,
  });

  const catalog = marketplaceData?.catalog || [];

  const categories = [
    { id: 'all', label: t('cat_all') },
    { id: 'coding', label: t('cat_coding') },
    { id: 'devops', label: t('cat_devops') },
    { id: 'research', label: t('cat_research') },
    { id: 'governance', label: t('cat_governance') },
    { id: 'mcp-servers', label: t('cat_mcp') },
  ];

  const handleInstall = async (id: string) => {
    setActionLoading(id);
    try {
      await api.installPlugin(id);
      showToast(`${t('skill_installed')}: ${id}`, 'success');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi cài đặt plugin', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleUninstall = async (id: string) => {
    setActionLoading(id);
    try {
      await api.uninstallPlugin(id);
      showToast(`Đã gỡ cài đặt: ${id}`, 'info');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi gỡ plugin', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    setActionLoading(id);
    try {
      await api.togglePlugin(id, !currentEnabled);
      showToast(!currentEnabled ? `Đã kích hoạt ${id}` : `Đã tắt ${id}`, 'info');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi bật/tắt plugin', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleAddCustomSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customId.trim() || !customName.trim()) {
      showToast('Vui lòng nhập ID và tên skill', 'warning');
      return;
    }
    setActionLoading('custom');
    try {
      await api.request('/api/plugins/install', {
        method: 'POST',
        body: JSON.stringify({
          id: customId.trim().toLowerCase(),
          custom: {
            name: customName.trim(),
            description: customDesc.trim(),
            category: 'custom',
            systemPrompt: customPrompt.trim(),
            tools: ['custom_online_tool'],
          },
        }),
      });
      showToast(`Đã cài đặt skill online: ${customName}`, 'success');
      setShowAddModal(false);
      setCustomId('');
      setCustomName('');
      setCustomDesc('');
      setCustomPrompt('');
      refetch();
    } catch (err: any) {
      showToast(err.message || 'Lỗi cài đặt skill online', 'error');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-3 select-none text-xs">
      {/* Header and Search */}
      <div className="space-y-2 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Puzzle className="w-4 h-4 text-sky-400" />
            <span className="font-semibold text-xs text-[var(--text)]">{t('skills_title')}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAddModal(true)}
            className="h-6 px-2 text-[10px] gap-1"
          >
            <Plus className="w-3 h-3" />
            <span>{t('skill_add_online')}</span>
          </Button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('skills_search_placeholder')}
            className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded-md pl-8 pr-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* Categories Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                activeCategory === c.id
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] border border-[var(--line-subtle)]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Skills Grid */}
      <div className="space-y-2.5 flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center p-8 text-[var(--muted)] gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
            <span>Đang tải chợ kỹ năng...</span>
          </div>
        ) : catalog.length === 0 ? (
          <div className="p-8 text-center text-[var(--muted)] border border-dashed border-[var(--line)] rounded-lg">
            Không tìm thấy kỹ năng phù hợp.
          </div>
        ) : (
          catalog.map((s: any) => {
            const isInstalled = Boolean(s.isInstalled);
            const isEnabled = Boolean(s.isEnabled);
            const isBusy = actionLoading === s.id;

            return (
              <div
                key={s.id}
                className="p-3 bg-[var(--panel)] border border-[var(--line)] hover:border-sky-500/40 rounded-lg transition-all flex flex-col justify-between gap-2.5 shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-xs text-[var(--text)]">
                        {s.name}
                      </span>
                      {s.author === 'ChatMCP Team' && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase tracking-wider bg-teal-500/20 text-teal-300 border border-teal-500/30 flex items-center gap-1">
                          <ShieldCheck className="w-2.5 h-2.5" />
                          Official
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--faint)]">v{s.version}</span>
                    </div>

                    <span className="text-[10px] text-[var(--faint)]">
                      {t('skill_by')} {s.author}
                    </span>
                  </div>

                  <p className="text-[11px] text-[var(--muted)] mt-1.5 leading-relaxed">
                    {s.description}
                  </p>

                  {s.tools && s.tools.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      <Wrench className="w-3 h-3 text-[var(--faint)]" />
                      {s.tools.map((tool: string) => (
                        <span
                          key={tool}
                          className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--surface)] border border-[var(--line-subtle)] text-[var(--muted)]"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Card Actions Footer */}
                <div className="flex items-center justify-between pt-2 border-t border-[var(--line-subtle)]">
                  <div className="flex items-center gap-2">
                    {isInstalled ? (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                        <Check className="w-3.5 h-3.5" />
                        <span>{t('skill_installed')}</span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-[var(--faint)]">Sẵn sàng cài đặt</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {isInstalled ? (
                      <>
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={isBusy}
                          onClick={() => handleToggle(s.id, isEnabled)}
                          className="h-7 px-2 text-[11px] gap-1"
                        >
                          {isEnabled ? (
                            <>
                              <ToggleRight className="w-4 h-4 text-emerald-400" />
                              <span className="text-emerald-400">{t('skill_enable')}</span>
                            </>
                          ) : (
                            <>
                              <ToggleLeft className="w-4 h-4 text-[var(--muted)]" />
                              <span className="text-[var(--muted)]">{t('skill_disable')}</span>
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={isBusy}
                          onClick={() => handleUninstall(s.id)}
                          className="h-7 px-2 text-[11px] gap-1"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>{t('skill_uninstall')}</span>
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isBusy}
                        onClick={() => handleInstall(s.id)}
                        className="h-7 px-2.5 text-[11px] gap-1"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Download className="w-3 h-3" />
                        )}
                        <span>{t('skill_install')}</span>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Custom / Online Skill Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[var(--panel)] border border-[var(--line)] rounded-xl p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between border-b border-[var(--line)] pb-2">
              <div className="font-semibold text-xs text-[var(--text)] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-sky-400" />
                <span>{t('skill_add_online')}</span>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-[var(--muted)] hover:text-white text-xs px-1"
              >
                ✕
              </button>
            </div>

            <p className="text-[11px] text-[var(--muted)]">
              {t('skill_add_online_desc')}
            </p>

            <form onSubmit={handleAddCustomSkill} className="space-y-2.5 text-xs">
              <div>
                <label className="text-[11px] text-[var(--muted)] block mb-1">
                  {t('skill_manifest_id')}
                </label>
                <input
                  type="text"
                  required
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  placeholder="vd: online-web-scraper"
                  className="w-full bg-[var(--surface)] text-[var(--text)] font-mono text-xs rounded px-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-[var(--muted)] block mb-1">
                  {t('skill_manifest_name')}
                </label>
                <input
                  type="text"
                  required
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="vd: Web Scraping Pro"
                  className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded px-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-[var(--muted)] block mb-1">
                  {t('skill_manifest_desc')}
                </label>
                <input
                  type="text"
                  value={customDesc}
                  onChange={(e) => setCustomDesc(e.target.value)}
                  placeholder="vd: Tự động trích xuất nội dung web từ URL..."
                  className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded px-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="text-[11px] text-[var(--muted)] block mb-1">
                  {t('skill_manifest_prompt')}
                </label>
                <textarea
                  rows={3}
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Hướng dẫn cho AI khi kích hoạt kỹ năng này..."
                  className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded px-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--line-subtle)]">
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => setShowAddModal(false)}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={actionLoading === 'custom'}
                  className="gap-1.5"
                >
                  {actionLoading === 'custom' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{t('skill_btn_install')}</span>
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
