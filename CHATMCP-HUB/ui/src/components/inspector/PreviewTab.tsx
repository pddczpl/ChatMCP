import { useState } from 'react';
import { Globe, RotateCw, ExternalLink, AlertTriangle, MonitorPlay } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';

export function PreviewTab() {
  const { t } = useTranslation();
  const [url, setUrl] = useState('http://localhost:5173');
  const [activeUrl, setActiveUrl] = useState('http://localhost:5173');
  const [key, setKey] = useState(0);

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

  const handleReload = () => {
    setKey((prev) => prev + 1);
  };

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizeUrl(url);
    setUrl(clean);
    setActiveUrl(clean);
  };

  const setQuickPort = (port: number) => {
    const target = `http://localhost:${port}`;
    setUrl(target);
    setActiveUrl(target);
  };

  const isExternal = !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(activeUrl);

  return (
    <div className="h-full flex flex-col bg-[var(--surface)] text-xs select-none">
      {/* Top Address Bar */}
      <form
        onSubmit={handleNavigate}
        className="p-2 border-b border-[var(--line)] bg-[var(--panel)] flex items-center gap-2 flex-shrink-0"
      >
        <Globe className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('preview_url_placeholder')}
          className="flex-1 bg-[var(--surface)] text-[var(--text)] font-mono text-[11px] rounded px-2.5 py-1 border border-[var(--line)] focus:outline-none focus:border-sky-500"
        />
        <Button
          type="button"
          size="icon"
          variant="quiet"
          onClick={handleReload}
          title={t('preview_reload')}
        >
          <RotateCw className="w-3.5 h-3.5" />
        </Button>
        <a
          href={activeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] flex items-center gap-1 font-sans text-xs"
          title={t('preview_new_tab')}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('preview_new_tab')}</span>
        </a>
      </form>

      {/* Quick Ports Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--line-subtle)] bg-[var(--surface-hover)]/40 flex items-center justify-between text-[11px] text-[var(--faint)] flex-shrink-0">
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

      {/* External Warning Banner */}
      {isExternal && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-[11px] flex items-start gap-2 flex-shrink-0 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-400" />
          <div className="flex-1">
            <span>{t('preview_external_note')} </span>
            <a
              href={activeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold hover:text-amber-200 inline-flex items-center gap-1 ml-1"
            >
              {t('preview_new_tab')} <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}

      {/* Embedded Iframe */}
      <div className="flex-1 relative bg-white min-h-0">
        <iframe
          key={key}
          src={activeUrl}
          title="Web Preview"
          className="w-full h-full border-none"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
}
