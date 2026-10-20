import { Bot, CheckCircle2, FolderSearch, Settings, ShieldAlert, Zap, type LucideIcon } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import type { HubState } from '@/types';

type Starter = { title: string; desc: string; prompt: string; icon: LucideIcon; tone: string };

/** The first screen of a new conversation: what this is, what to do first, and anything that would make sending fail. */
export function EmptyState({ hub, sending, onPick }: { hub?: HubState; sending: boolean; onPick: (prompt: string) => void }) {
  const { t } = useTranslation();
  const openSettings = useAppStore(state => state.openSettings);

  const starters: Starter[] = [
    {
      title: t('starter_1_title'), desc: t('starter_1_desc'), icon: FolderSearch, tone: 'text-primary',
      prompt: 'Hãy quét cấu trúc thư mục hiện tại của workspace, phân tích kiến trúc dự án và chỉ ra các module chính.',
    },
    {
      title: t('starter_2_title'), desc: t('starter_2_desc'), icon: CheckCircle2, tone: 'text-success',
      prompt: 'Hãy tìm các file logic hoặc module quan trọng chưa có test và viết unit test bao phủ đầy đủ.',
    },
    {
      title: t('starter_3_title'), desc: t('starter_3_desc'), icon: ShieldAlert, tone: 'text-danger',
      prompt: 'Hãy rà soát toàn bộ cấu hình CSP, các endpoint API và sanitize input để phát hiện rủi ro bảo mật.',
    },
    {
      title: t('starter_4_title'), desc: t('starter_4_desc'), icon: Zap, tone: 'text-warning',
      prompt: 'Hãy phân tích các file code có kích thước lớn hoặc nợ kỹ thuật để thực hiện refactor tối ưu.',
    },
  ];

  const apiMode = (hub?.agent?.mode || 'api') === 'api';
  const modelMissing = !!hub && apiMode && hub.ai?.configured === false;
  const workspaceMissing = !!hub && !hub.workspace?.path && !hub.workspaces?.activePath;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-1 select-none flex-col items-center justify-center px-6 py-10">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary">
        <Bot className="h-7 w-7" strokeWidth={2} />
      </div>
      <h1 className="text-center text-2xl font-semibold tracking-tight text-fg">{t('welcome_title')}</h1>
      <p className="mb-7 mt-2 max-w-md text-center text-[14px] leading-6 text-muted">{t('welcome_desc')}</p>

      {(modelMissing || workspaceMissing) && (
        <div role="status" className="mb-6 flex w-full items-center gap-3 rounded-xl border border-warning/40 bg-warning/[0.08] px-4 py-3 text-[13px]">
          <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-fg">
            {workspaceMissing ? 'Chưa chọn thư mục dự án cho agent.' : 'Chưa kết nối mô hình AI nên agent chưa thể trả lời.'}
          </span>
          <Button size="sm" variant="secondary" onClick={() => openSettings(workspaceMissing ? 'workspace' : 'model')} className="shrink-0 gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            {workspaceMissing ? 'Chọn thư mục' : 'Kết nối mô hình'}
          </Button>
        </div>
      )}

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {starters.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.title}
              type="button"
              disabled={sending}
              onClick={() => onPick(item.prompt)}
              className="group flex items-start gap-3 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-primary/50 hover:bg-hover disabled:opacity-60"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface transition-colors group-hover:border-primary/30">
                <Icon className={`h-4 w-4 ${item.tone}`} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-fg">{item.title}</span>
                <span className="mt-0.5 block text-[12px] leading-4 text-muted">{item.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
