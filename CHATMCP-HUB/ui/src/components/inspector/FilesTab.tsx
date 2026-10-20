import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { FileCode, Search } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyBlock, ErrorLine, LoadingLine, SectionHeading, TabBody } from './parts';

/** Git status letters in plain words: M modified, A added, D deleted, R renamed, ?? new and untracked. */
const statusLook = (code: string): { label: string; tone: string } => {
  const c = code.trim();
  if (c === '??') return { label: 'Mới', tone: 'text-primary' };
  if (c.includes('D')) return { label: 'Xóa', tone: 'text-danger' };
  if (c.includes('A')) return { label: 'Thêm', tone: 'text-success' };
  if (c.includes('R')) return { label: 'Đổi tên', tone: 'text-warning' };
  if (c.includes('M')) return { label: 'Sửa', tone: 'text-warning' };
  return { label: c || '·', tone: 'text-muted' };
};

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
    <TabBody label="Workspace files" className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
        <input aria-label={t('files_search')} type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('files_search')}
          className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-[13px] text-fg placeholder:text-faint transition-colors hover:border-line-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25" />
      </div>
      <SectionHeading title={t('files_modified')} count={`${filtered.length} ${t('files_count')}`} />
      {error ? <ErrorLine message={error.message} />
        : hubQuery.isLoading || gitQuery.isLoading ? <LoadingLine text={lang === 'vi' ? 'Đang tải tệp…' : 'Loading files…'} />
        : !workspace ? <p className="text-muted">{lang === 'vi' ? 'Chọn workspace để xem tệp.' : 'Select a workspace to view files.'}</p>
        : filtered.length === 0 ? (
          <EmptyBlock icon={FileCode} title={search ? (lang === 'vi' ? 'Không có tệp phù hợp.' : 'No matching files.') : (lang === 'vi' ? 'Không có thay đổi Git trong workspace.' : 'No Git changes in the workspace.')} />
        ) : (
          <ul className="divide-y divide-line-subtle overflow-hidden rounded-xl border border-line bg-surface">
            {filtered.map((entry, index) => {
              const look = statusLook(entry.slice(0, 2));
              return (
                <li key={`${entry}-${index}`} className="flex items-start gap-3 px-3 py-2">
                  {/* Preserve Git's quoted paths and rename notation; neither is a literal filesystem path. */}
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[12px] leading-5 text-fg"><span className={cn('font-semibold', look.tone)}>{entry.slice(0, 2)}</span>{' '}{entry.slice(3)}</code>
                  <span className={cn('shrink-0 text-[12px]', look.tone)}>{look.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      {gitQuery.data?.partial && <p className="text-warning">{lang === 'vi' ? 'Danh sách Git bị giới hạn; có thể còn tệp chưa hiển thị.' : 'Git results are limited; more files may exist.'}</p>}
    </TabBody>
  );
}
