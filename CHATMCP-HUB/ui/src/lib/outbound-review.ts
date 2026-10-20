// Wording and small pure helpers for the ChatGPT Web Companion privacy notes and the "review before send" card.
//
// The wording is one place so that Settings, the task view, the README and docs/COMPANION-PRIVACY.md say the same thing, and so that a
// test can pin it: this mode automates the consumer ChatGPT page, it may conflict with OpenAI's Terms of Use, and it sends workspace
// content into the person's own ChatGPT history. Nothing here may describe the mode as official, supported or approved.

export type RiskCopy = { title: string; summary: string; points: string[] };

export const CHATGPT_WEB_RISK: Record<'vi' | 'en', RiskCopy> = {
  vi: {
    title: 'ChatGPT Web: rủi ro cần biết',
    summary: 'Chế độ này tự động hóa trang ChatGPT dành cho người dùng cuối (chatgpt.com), có thể vi phạm Điều khoản sử dụng của OpenAI và có thể khiến tài khoản bị cảnh báo hoặc đình chỉ.',
    points: [
      'Đây không phải API hay kênh do OpenAI cung cấp, hỗ trợ hoặc cho phép; ChatMCP không liên kết với OpenAI. Một Companion điều khiển ô chat của tab chatgpt.com mà bạn đã đăng nhập.',
      'Nội dung workspace (kết quả công cụ, đoạn file, prompt) được gửi vào cuộc chat và nằm trong lịch sử ChatGPT của bạn, theo chính sách của OpenAI.',
      'ChatMCP che các chuỗi giống bí mật (khóa, token, mật khẩu) và giữ lại nội dung file .env, khóa riêng, credentials khi lời gọi hoặc kết quả nêu tên chúng. Việc này chỉ là nỗ lực tối đa, không bảo đảm phát hiện hết và không biết nội dung nào là bí mật của khách hàng.',
      'Bật "Xem lại trước khi gửi" nếu workspace chứa thông tin nhạy cảm hoặc của khách hàng. Dùng Model API nếu cần một kênh có điều khoản rõ ràng.',
    ],
  },
  en: {
    title: 'ChatGPT Web: risks to know',
    summary: 'This mode automates the consumer ChatGPT page (chatgpt.com). It may conflict with OpenAI\'s Terms of Use and can lead to a warning or suspension of your account.',
    points: [
      'It is not an API or a channel that OpenAI provides, supports or permits, and ChatMCP is not affiliated with OpenAI. A Companion drives the chat box of the chatgpt.com tab you are signed in to.',
      'Workspace content (tool results, file excerpts, prompts) is sent into the chat and stays in your ChatGPT history, under OpenAI\'s policies.',
      'ChatMCP masks text shaped like a secret (keys, tokens, passwords) and withholds the content of .env files, private keys and credentials when the call or its result names them. This is best effort: it will miss some secrets and cannot know what is confidential for a client.',
      'Turn on "Review before send" when the workspace holds sensitive or client material. Use the Model API when you need a channel with clear terms.',
    ],
  },
};

/** One string per line, trimmed, at least 3 characters, no duplicates, at most 20: what the Hub accepts for "Redact more". */
export function parseRedactionInput(text: string): string[] {
  const seen = new Set<string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const value = line.trim();
    if (value.length >= 3 && value.length <= 200) seen.add(value);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

/** "aws-access-key-id ×1, env-secret ×3" - labels and counts, never a match. */
export function describeRedactions(labels: Record<string, number> | null | undefined): string {
  return Object.entries(labels ?? {}).filter(([, count]) => count > 0).map(([label, count]) => `${label} ×${count}`).join(', ');
}

/** Seconds left of the hold, never negative; null when there is no expiry. */
export function secondsLeft(expiresAt: string | null | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  return Number.isFinite(end) ? Math.max(0, Math.round((end - now) / 1000)) : null;
}

export function formatCountdown(seconds: number | null): string {
  if (seconds === null) return '';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
