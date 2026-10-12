import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { FileCode, Search, FileEdit } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';

export function FilesTab() {
  const { t, lang } = useTranslation();
  const [search, setSearch] = useState('');
  const hubQuery = useQuery({ queryKey: ['hubState'], queryFn: api.getState });
  const workspace = hubQuery.data?.workspace?.path ?? '';
  const gitQuery = useQuery({ queryKey: ['gitStatus', workspace], queryFn: api.getGitStatus, enabled: Boolean(workspace), refetchInterval: 3000 });
  const entries = gitQuery.data?.entries ?? [];
  const filtered = entries.filter((entry) => entry.toLowerCase().includes(search.toLowerCase()));
  const error = hubQuery.error || gitQuery.error;

  return (
    <section aria-label="Workspace files" className="h-full flex flex-col p-3 overflow-y-auto space-y-3 text-xs">
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input aria-label={t('files_search')} type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('files_search')} className="w-full bg-[var(--surface)] text-[var(--text)] text-xs rounded-md pl-8 pr-2.5 py-1.5 border border-[var(--line)] focus:outline-none focus:border-sky-500" />
      </div>
      <div className="flex items-center justify-between pb-1 text-[var(--muted)] border-b border-[var(--line-subtle)]">
        <span className="font-semibold uppercase tracking-wider text-[10px]">{t('files_modified')}</span>
        <span className="text-[10px] font-mono">{filtered.length} {t('files_count')}</span>
      </div>
      {error ? <p role="alert" className="text-rose-400">{error.message}</p>
        : hubQuery.isLoading || gitQuery.isLoading ? <p role="status">{lang === 'vi' ? 'Đang tải tệp…' : 'Loading files…'}</p>
        : !workspace ? <p className="text-[var(--muted)]">{lang === 'vi' ? 'Chọn workspace để xem tệp.' : 'Select a workspace to view files.'}</p>
        : filtered.length === 0 ? (
          <div className="py-12 text-center text-[var(--faint)] flex flex-col items-center gap-2">
            <FileCode className="w-8 h-8 opacity-40" />
            <p>{search ? (lang === 'vi' ? 'Không có tệp phù hợp.' : 'No matching files.') : (lang === 'vi' ? 'Không có thay đổi Git trong workspace.' : 'No Git changes in the workspace.')}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((entry, index) => (
              <div key={`${entry}-${index}`} className="p-2 rounded-lg bg-[var(--surface)] border border-[var(--line-subtle)] flex items-start gap-2">
                <FileEdit className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />
                {/* Preserve Git's quoted paths and rename notation; neither is a literal filesystem path. */}
                <code className="text-[11px] whitespace-pre-wrap break-all"><span className="text-sky-400">{entry.slice(0, 2)}</span>{' '}{entry.slice(3)}</code>
              </div>
            ))}
          </div>
        )}
      {gitQuery.data?.partial && <p className="text-amber-400">{lang === 'vi' ? 'Danh sách Git bị giới hạn; có thể còn tệp chưa hiển thị.' : 'Git results are limited; more files may exist.'}</p>}
    </section>
  );
}
