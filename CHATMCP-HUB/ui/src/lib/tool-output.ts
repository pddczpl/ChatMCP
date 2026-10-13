/** Show MCP text blocks as readable text, retaining non-text/mixed payloads as JSON. */
export function formatToolOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  if (parsed && typeof parsed === 'object' && 'content' in parsed) {
    const content = (parsed as { content: unknown }).content;
    if (Array.isArray(content) && content.length && content.every(item => item?.type === 'text' && typeof item.text === 'string')) {
      return content.map(item => item.text).join('\n\n');
    }
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
