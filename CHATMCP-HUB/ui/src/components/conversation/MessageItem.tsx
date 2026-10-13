import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Terminal } from 'lucide-react';
import { Message } from '@/types';
import { CopyButton } from '@/components/ui/CopyButton';

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div
      data-testid="conversation-message"
      className={`py-4 px-4 flex gap-3 text-sm leading-relaxed ${
        isUser
          ? 'bg-[var(--surface)]/40 border-b border-[var(--line-subtle)]'
          : 'border-b border-[var(--line-subtle)]'
      }`}
    >
      {/* Avatar Icon */}
      <div className="flex-shrink-0 mt-0.5">
        {isUser ? (
          <div className="w-6 h-6 rounded-full bg-sky-500/20 text-sky-400 border border-sky-500/30 flex items-center justify-center">
            <User className="w-3.5 h-3.5" />
          </div>
        ) : isSystem ? (
          <div className="w-6 h-6 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center">
            <Terminal className="w-3.5 h-3.5" />
          </div>
        ) : (
          <div className="w-6 h-6 rounded-full bg-teal-500/20 text-teal-400 border border-teal-500/30 flex items-center justify-center">
            <Bot className="w-3.5 h-3.5" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        {/* Role & Timestamp */}
        <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)] mb-1">
          <span className="font-semibold text-[var(--text)]">
            {isUser ? 'Bạn' : isSystem ? 'Hệ thống' : 'ChatMCP'}
          </span>
          <div className="flex items-center gap-2">
          {message.timestamp && (
            <span className="tabular-nums">
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <CopyButton text={message.content} label="Sao chép tin nhắn" />
          </div>
        </div>

        {/* Message Body */}
        {isUser ? (
          <div className="conversation-copy whitespace-pre-wrap text-[var(--text)]">
            {message.content}
          </div>
        ) : (
          <div className="conversation-copy text-[var(--text)] max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => (
                  <a
                    {...props}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--primary)] underline underline-offset-2 font-medium"
                  />
                ),
                code: ({ node, className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match && !String(children).includes('\n');

                  if (isInline) {
                    return (
                      <code
                        className="px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--text)] font-mono text-xs border border-[var(--line)]"
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  }

                  return (
                    <CodeBlock language={match?.[1] || 'text'}>
                      {String(children).replace(/\n$/, '')}
                    </CodeBlock>
                  );
                },
                pre: ({ children }) => <>{children}</>,
                p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="pl-0.5">{children}</li>,
                h1: ({ children }) => <h1 className="text-xl font-semibold text-[var(--text)] mt-5 mb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-semibold text-[var(--text)] mt-4 mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold text-[var(--text)] mt-3 mb-1">{children}</h3>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-sky-500/50 pl-3 italic text-[var(--muted)] my-2">
                    {children}
                  </blockquote>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2 border border-[var(--line)] rounded-lg">
                    <table className="w-full text-left border-collapse text-xs">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="bg-[var(--surface)] px-2.5 py-1.5 font-semibold border-b border-[var(--line)] text-[var(--muted)]">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="px-2.5 py-1.5 border-b border-[var(--line-subtle)] text-[var(--text)]">
                    {children}
                  </td>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function CodeBlock({ language, children }: { language: string; children: string }) {
  return (
    <div className="my-3 rounded-lg border border-[var(--line)] bg-[var(--bg)] overflow-hidden text-xs" data-testid="message-code">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--surface)] border-b border-[var(--line)] text-xs text-[var(--muted)]">
        <span className="font-medium">
          {language}
        </span>
        <CopyButton text={children} label="Sao chép mã" />
      </div>
      <pre className="p-3 overflow-x-auto leading-7 text-[var(--text)]" tabIndex={0}>
        <code>{children}</code>
      </pre>
    </div>
  );
}
