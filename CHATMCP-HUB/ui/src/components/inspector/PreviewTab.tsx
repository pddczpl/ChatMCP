import { useState, useEffect } from 'react';
import { Globe, RotateCw, Plus, X, AlertTriangle, MonitorPlay } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';

interface InAppTab {
  id: string;
  title: string;
  url: string;
}

export function PreviewTab() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<InAppTab[]>([
    { id: 'tab-1', title: 'Localhost:5173', url: 'http://localhost:5173' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const [inputUrl, setInputUrl] = useState('http://localhost:5173');
  const [key, setKey] = useState(0);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  useEffect(() => {
    if (activeTab) {
      setInputUrl(activeTab.url);
    }
  }, [activeTabId]);

  // Listen for in-app tab requests from WebView2 or components
  useEffect(() => {
    const handleOpenInAppTab = (e: any) => {
      const target = e.detail?.url;
      if (target) {
        const newId = `tab-${Date.now()}`;
        let title = 'Web Page';
        try {
          const parsed = new URL(target);
          title = parsed.host || 'Web Page';
        } catch {}
        setTabs((prev) => [...prev, { id: newId, title, url: target }]);
        setActiveTabId(newId);
        setInputUrl(target);
      }
    };
    window.addEventListener('chatmcp:open-in-app-tab', handleOpenInAppTab);
    return () => window.removeEventListener('chatmcp:open-in-app-tab', handleOpenInAppTab);
  }, []);

  const normalizeUrl = (raw: string): string => {
    let trimmed = raw.trim();
    if (!trimmed) return 'http://localhost:5173';
    if (!/^https?:\/\//i.test(trimmed)) {
      if (trimmed.startsWith(':')) {
        trimmed = `http://localhost${trimmed}`;
      } else if (/^(localhost|127\.0\.0\.1)/i.test(trimmed)) {
        trimmed = `http://${trimmed}`;
      } else if (/^[0-9]+$/.test(trimmed)) {
        trimmed = `http://localhost:${trimmed}`;
      } else {
        trimmed = `https://${trimmed}`;
      }
    }
    return trimmed;
  };

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizeUrl(inputUrl);
    let title = clean;
    try {
      const parsed = new URL(clean);
      title = parsed.host + (parsed.port ? `:${parsed.port}` : '');
    } catch {}

    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, url: clean, title } : t))
    );
    setKey((prev) => prev + 1);
  };

  const handleAddNewTab = () => {
    const newId = `tab-${Date.now()}`;
    const newTab: InAppTab = {
      id: newId,
      title: 'Localhost:3000',
      url: 'http://localhost:3000',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    setInputUrl('http://localhost:3000');
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining[remaining.length - 1].id);
    }
  };

  const setQuickPort = (port: number) => {
    const target = `http://localhost:${port}`;
    setInputUrl(target);
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, url: target, title: `:${port}` } : t))
    );
    setKey((prev) => prev + 1);
  };

  const isExternal = activeTab && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(activeTab.url);

  return (
    <div className="h-full flex flex-col bg-[var(--surface)] text-xs select-none">
      {/* In-App Tab Bar */}
      <div className="flex items-center bg-[var(--panel)] border-b border-[var(--line)] px-1 pt-1 gap-1 overflow-x-auto flex-shrink-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-[11px] font-mono cursor-pointer border-t border-l border-r transition-all max-w-[160px] ${
                isActive
                  ? 'bg-[var(--surface)] border-[var(--line)] text-sky-400 font-semibold'
                  : 'bg-[var(--surface-hover)]/40 border-transparent text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              <Globe className="w-3 h-3 flex-shrink-0" />
              <span className="truncate flex-1">{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  className="p-0.5 rounded hover:bg-[var(--line)] text-[var(--faint)] hover:text-[var(--text)] ml-1"
                  title={t('preview_tab_close')}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          );
        })}

        {/* Plus Tab Button */}
        <button
          type="button"
          onClick={handleAddNewTab}
          className="p-1.5 rounded-lg text-[var(--muted)] hover:text-sky-400 hover:bg-[var(--surface-hover)] transition-colors mb-0.5"
          title={t('preview_new_tab')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Address Bar */}
      <form
        onSubmit={handleNavigate}
        className="p-2 border-b border-[var(--line)] bg-[var(--surface)] flex items-center gap-2 flex-shrink-0"
      >
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder={t('preview_url_placeholder')}
          className="flex-1 bg-[var(--panel)] text-[var(--text)] font-mono text-[11px] rounded px-2.5 py-1 border border-[var(--line)] focus:outline-none focus:border-sky-500"
        />
        <Button
          type="button"
          size="icon"
          variant="quiet"
          onClick={() => setKey((k) => k + 1)}
          title={t('preview_reload')}
        >
          <RotateCw className="w-3.5 h-3.5" />
        </Button>
      </form>

      {/* Quick Ports Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--line-subtle)] bg-[var(--surface-hover)]/30 flex items-center justify-between text-[11px] text-[var(--faint)] flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <MonitorPlay className="w-3 h-3 text-sky-400" />
          <span>{t('preview_quick_ports')}</span>
          {[3000, 5173, 8000, 8080].map((port) => (
            <button
              key={port}
              type="button"
              onClick={() => setQuickPort(port)}
              className="px-1.5 py-0.5 rounded bg-[var(--panel)] border border-[var(--line)] text-[var(--muted)] hover:text-sky-400 hover:border-sky-500/40 font-mono text-[10px] transition-colors"
            >
              :{port}
            </button>
          ))}
        </div>
      </div>

      {/* External Notice */}
      {isExternal && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-[11px] flex items-start gap-2 flex-shrink-0 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-400" />
          <div className="flex-1">
            <span>{t('preview_external_note')}</span>
          </div>
        </div>
      )}

      {/* Embedded Iframe inside App */}
      <div className="flex-1 relative bg-white min-h-0">
        <iframe
          key={`${activeTab?.id}-${key}`}
          src={activeTab?.url}
          title={activeTab?.title || 'Preview'}
          className="w-full h-full border-none"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
}
