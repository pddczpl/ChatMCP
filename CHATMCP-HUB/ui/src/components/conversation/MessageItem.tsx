import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Check, Copy, Terminal } from 'lucide-react';
import { Message } from '@/types';

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div
      className={`py-3.5 px-4 flex gap-3 text-xs leading-relaxed transition-colors ${
        isUser
          ? 'bg-[var(--surface)]/40 border-b border-[var(--line-subtle)]'
          : 'border-b border-[var(--line-subtle)] hover:bg-[var(--surface)]/20'
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
        <div className="flex items-center justify-between text-[11px] text-[var(--faint)]">
          <span className="font-semibold text-[var(--text)]">
            {isUser ? 'Bạn' : isSystem ? 'Hệ thống' : 'ChatMCP Agent'}
          </span>
          {message.timestamp && (
            <span>
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {/* Message Body */}
        {isUser ? (
          <div className="whitespace-pre-wrap text-[var(--text)] font-sans text-[13px]">
            {message.content}
          </div>
        ) : (
          <div className="text-[var(--text)] prose-invert max-w-none text-[13px] leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => (
                  <a
                    {...props}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-400 hover:underline font-medium"
                  />
                ),
                code: ({ node, className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match && !String(children).includes('\n');

                  if (isInline) {
                    return (
                      <code
                        className="px-1.5 py-0.5 rounded bg-[var(--surface)] text-sky-300 font-mono text-[12px] border border-[var(--line)]"
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
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="pl-0.5">{children}</li>,
                h1: ({ children }) => <h1 className="text-base font-bold text-sky-400 mt-3 mb-1.5">{children}</h1>,
                h2: ({ children }) => <h2 className="text-sm font-bold text-sky-400 mt-2.5 mb-1">{children}</h2>,
                h3: ({ children }) => <h3 className="text-xs font-bold text-[var(--text)] mt-2 mb-1">{children}</h3>,
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
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2.5 rounded-lg border border-[var(--line)] bg-[#0b0f14] overflow-hidden text-xs font-mono shadow-sm">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--surface)]/70 border-b border-[var(--line)] text-[11px] text-[var(--muted)]">
        <span className="font-semibold uppercase tracking-wider text-[10px] text-sky-400">
          {language}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--surface-hover)] text-[var(--muted)] hover:text-[var(--text)] transition-colors"
          title="Sao chép mã"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400 text-[10px]">Đã chép</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span className="text-[10px]">Sao chép</span>
            </>
          )}
        </button>
      </div>
      <div className="p-3 overflow-x-auto leading-relaxed text-[var(--text)]">
        <code>{children}</code>
      </div>
    </div>
  );
}
