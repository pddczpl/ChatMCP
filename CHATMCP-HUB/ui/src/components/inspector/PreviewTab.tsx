import { useState } from 'react';
import { Globe, RotateCw, ExternalLink, Play } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function PreviewTab() {
  const [url, setUrl] = useState('http://localhost:5173');
  const [activeUrl, setActiveUrl] = useState('http://localhost:5173');
  const [key, setKey] = useState(0);

  const handleReload = () => {
    setKey((prev) => prev + 1);
  };

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveUrl(url);
  };

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
          placeholder="http://localhost:3000"
          className="flex-1 bg-[var(--surface)] text-[var(--text)] font-mono text-[11px] rounded px-2.5 py-1 border border-[var(--line)] focus:outline-none focus:border-sky-500"
        />
        <Button
          type="button"
          size="icon"
          variant="quiet"
          onClick={handleReload}
          title="Làm mới xem trước"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </Button>
        <a
          href={activeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
          title="Mở tab mới"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </form>

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
