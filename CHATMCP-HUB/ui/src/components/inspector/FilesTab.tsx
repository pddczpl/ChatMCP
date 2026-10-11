import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { FileCode, Search, FileEdit, Check, Copy, Folder } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

export function FilesTab() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const { data: hub } = useQuery({ queryKey: ['hubState'], queryFn: api.getState, refetchInterval: 3000 });
  const modifiedFiles = hub?.workspace?.modifiedFiles || hub?.recentFiles || [];

  const filtered = modifiedFiles.filter((f: any) => {
    const p = typeof f === 'string' ? f : f.path || '';
    return p.toLowerCase().includes(search.toLowerCase());
  });

  const handleCopy = (path: string) => {
    navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 2000);
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto space-y-3 select-none text-xs">
      {/* Search */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('files_search')}
          className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded-md pl-8 pr-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500"
        />
      </div>

      <div className="flex items-center justify-between pb-1 text-[var(--muted)] border-b border-[var(--line-subtle)]">
        <span className="font-semibold uppercase tracking-wider text-[10px]">{t('files_modified')}</span>
        <span className="text-[10px] font-mono">{filtered.length} {t('files_count')}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center text-[var(--faint)] flex flex-col items-center gap-2">
          <FileCode className="w-8 h-8 opacity-40" />
          <p className="text-xs">{t('files_empty')}</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((item: any, idx: number) => {
            const path = typeof item === 'string' ? item : item.path;
            const filename = path.split(/[\\/]/).pop() || path;
            const dir = path.substring(0, path.length - filename.length);

            return (
              <div
                key={idx}
                className="group p-2 rounded-lg bg-[var(--surface)] hover:bg-[var(--surface-hover)] border border-[var(--line-subtle)] flex items-center justify-between gap-2 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileEdit className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                  <div className="min-w-0 font-mono text-[11px]">
                    <span className="text-[var(--text)] font-medium">{filename}</span>
                    {dir && <span className="text-[var(--faint)] text-[10px] ml-1.5 truncate">({dir})</span>}
                  </div>
                </div>

                <button
                  onClick={() => handleCopy(path)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--line)] text-[var(--faint)] hover:text-[var(--text)] transition-opacity"
                  title={t('files_copy_path')}
                >
                  {copiedPath === path ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
