import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message } from '@/types';
import { CopyButton } from '@/components/ui/CopyButton';
import { useTranslation } from '@/lib/i18n';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface MessageItemProps {
  message: Message;
}

/**
 * A request is a quiet block; the answer is plain text on the page, like a document. Neither has an avatar: the author is a
 * label, and copy appears on hover or focus.
 */
export function MessageItem({ message }: MessageItemProps) {
  const { lang, t } = useTranslation();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const author = isUser ? t('agents_msg_you') : isSystem ? t('agents_msg_system') : 'DatGold';

  return (
    <article
      data-testid="conversation-message"
      data-role={message.role}
      className={cn('group relative py-3', isUser && 'pt-5')}
    >
      <div className={cn(isUser && 'rounded-2xl border border-line bg-surface px-4 py-3', isSystem && 'rounded-2xl border border-warning/30 bg-warning/[0.06] px-4 py-3')}>
        <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
          <span className={cn('font-semibold', isUser ? 'text-fg' : isSystem ? 'text-warning' : 'text-primary')}>{author}</span>
          {message.timestamp && <span className="tabular-nums text-faint">{formatTime(message.timestamp, lang)}</span>}
          <span className="ml-auto opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <CopyButton text={message.content} label={t('agents_msg_copy_message')} />
          </span>
        </div>

        {isUser || isSystem ? (
          <div className="conversation-copy whitespace-pre-wrap text-fg">{message.content}</div>
        ) : (
          <div className="conversation-copy max-w-none text-fg">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" />
                ),
                code: ({ node, className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match && !String(children).includes('\n');
                  if (isInline) {
                    return (
                      <code className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.86em] text-fg" {...props}>
                        {children}
                      </code>
                    );
                  }
                  return <CodeBlock language={match?.[1] || 'text'}>{String(children).replace(/\n$/, '')}</CodeBlock>;
                },
                pre: ({ children }) => <>{children}</>,
                p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 marker:text-faint">{children}</ul>,
                ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 marker:text-faint">{children}</ol>,
                li: ({ children }) => <li className="pl-0.5">{children}</li>,
                h1: ({ children }) => <h1 className="mb-2 mt-5 text-xl font-semibold tracking-tight text-fg">{children}</h1>,
                h2: ({ children }) => <h2 className="mb-2 mt-5 text-[17px] font-semibold tracking-tight text-fg">{children}</h2>,
                h3: ({ children }) => <h3 className="mb-1 mt-4 text-[15px] font-semibold text-fg">{children}</h3>,
                hr: () => <hr className="my-4 border-line" />,
                blockquote: ({ children }) => (
                  <blockquote className="my-3 border-l-2 border-primary/50 pl-4 text-muted">{children}</blockquote>
                ),
                table: ({ children }) => (
                  <div className="my-3 overflow-x-auto rounded-xl border border-line">
                    <table className="w-full border-collapse text-left text-[13px]">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border-b border-line bg-surface px-3 py-2 font-semibold text-muted">{children}</th>
                ),
                td: ({ children }) => (
                  <td className="border-b border-line-subtle px-3 py-2 text-fg">{children}</td>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </article>
  );
}

function CodeBlock({ language, children }: { language: string; children: string }) {
  const { t } = useTranslation();
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-line bg-bg text-[13px]" data-testid="message-code">
      <div className="flex items-center justify-between border-b border-line bg-surface px-3 py-1 text-[12px] text-muted">
        <span className="font-medium">{language}</span>
        <CopyButton text={children} label={t('agents_msg_copy_code')} />
      </div>
      <pre className="overflow-x-auto p-3 leading-6 text-fg" tabIndex={0}>
        <code>{children}</code>
      </pre>
    </div>
  );
}
