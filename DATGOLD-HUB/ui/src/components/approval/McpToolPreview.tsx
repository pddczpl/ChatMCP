import { Plug } from 'lucide-react';
import { useTranslation } from '@/lib/i18n';
import { parseMcpDetail } from '@/lib/mcp-approval';

/**
 * The part of the approval card that is specific to a tool of an external MCP server: which server and which tool, how the server is reached when the
 * Hub knows it, and the arguments the model wrote (masked by the Hub). Renders nothing for a request that is not one of those.
 */
export function McpToolPreview({ detail }: { detail: unknown }) {
  const { t } = useTranslation();
  const call = parseMcpDetail(detail);
  if (!call) return null;
  return (
    <section data-testid="mcp-preview" aria-label={t('agents_apr_mcp_title')} className="space-y-2.5 rounded-lg border border-line bg-surface px-3 py-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-medium text-fg"><Plug className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('agents_apr_mcp_title')}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">{t('agents_apr_mcp_server')}</dt>
        <dd className="break-all font-mono text-[12px]" data-testid="mcp-server">{call.server}</dd>
        <dt className="text-muted">{t('agents_apr_mcp_tool')}</dt>
        <dd className="break-all font-mono text-[12px]" data-testid="mcp-tool">{call.tool}</dd>
        {call.transport && (
          <>
            <dt className="text-muted">{t('agents_apr_mcp_transport')}</dt>
            <dd className="break-all font-mono text-[12px]" data-testid="mcp-transport">{call.transport}</dd>
          </>
        )}
        {call.launch && (
          <>
            <dt className="text-muted">{t('agents_apr_mcp_launch')}</dt>
            <dd className="break-all font-mono text-[12px]" data-testid="mcp-launch">{call.launch}</dd>
          </>
        )}
        {call.origin && (
          <>
            <dt className="text-muted">{t('agents_apr_mcp_origin')}</dt>
            <dd className="break-all font-mono text-[12px]" data-testid="mcp-origin">{call.origin}</dd>
          </>
        )}
      </dl>
      <p className="font-medium text-fg">{t('agents_apr_mcp_arguments')}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2 font-mono text-[12px] leading-5" data-testid="mcp-arguments">{call.arguments}</pre>
      <p className="text-[12px] text-faint">{t('agents_apr_mcp_note')}</p>
    </section>
  );
}
