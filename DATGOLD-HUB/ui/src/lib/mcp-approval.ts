// What the approval request of a tool of an external MCP server carries (lib/permissions.mjs, mcpCard): the server and the tool, how the server is
// reached when the Hub knows it (the transport, the command that starts a stdio server, the origin of an HTTP one) and the arguments, as the JSON text the
// Hub masked. It arrives as JSON, so this reads it defensively: the card must never throw on a shape it does not know.

export interface McpApprovalView {
  server: string;
  tool: string;
  transport: string;
  launch: string;
  origin: string;
  /** The arguments as the Hub masked them, indented when they are whole JSON (a cut preview is shown as it is). */
  arguments: string;
}

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '');

/** The arguments, indented when the text is whole JSON: the Hub cuts a long preview, and a cut one is shown as the Hub sent it. */
function readable(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** The call the request describes, or null when the request is not one of a tool of an external MCP server. */
export function parseMcpDetail(detail: unknown): McpApprovalView | null {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const raw = detail as Record<string, unknown>;
  if (raw.kind !== 'mcp') return null;
  return {
    server: text(raw.server, 200),
    tool: text(raw.tool, 300),
    transport: text(raw.transport, 40),
    launch: text(raw.launch, 2000),
    origin: text(raw.origin, 300),
    arguments: readable(text(raw.arguments, 4000)),
  };
}
