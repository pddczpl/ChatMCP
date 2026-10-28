// DATGOLD-HUB/lib/attachment-limits.mjs
// What one message may carry, in one place. The Hub enforces it (lib/agent.mjs buildUserAttachmentParts, hub.mjs for the size of the request) and the page shrinks and refuses by the same
// numbers (ui/src/lib/image-fit.ts); a test of the page compares the two.
//
// A picture is limited by the request the provider takes, so its numbers are the strictest of the providers the Hub talks to (their documentation, read on 2026-10-28):
//   Anthropic Messages API   10 MB of base64 for one picture, 32 MB for a request, 100 pictures (models of 200k tokens)
//   Amazon Bedrock           5 MB of base64 for one picture, which is 3.75 MB of picture; lower limits for a request
//   Gemini                   20 MB for a whole request with the pictures inline: the text and the turns before it are in it
//   OpenAI                   512 MB for a request, 1,500 pictures
// A message of 12 MiB of files is 16 MiB of base64, and leaves Gemini's 20 MB room for the text. A text file is limited by the context window instead: 200,000 bytes are about 52,000 tokens,
// a quarter of the window of a 200,000-token model; the way for a bigger file is the project folder, where the agent reads it in pieces with its tools.
const MiB = 1024 * 1024;

export const ATTACHMENT_LIMITS = Object.freeze({
  files: 10,
  imageBytes: 3.75 * MiB,
  textBytes: 200_000,
  totalBytes: 12 * MiB,
});

/** The base64 of this many bytes. */
export const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

/** The body of a request that starts or continues a task: the base64 of all the files at most, a prompt of 100,000 characters and the rest of the JSON. */
export const ATTACHMENT_BODY_LIMIT = base64Length(ATTACHMENT_LIMITS.totalBytes) + MiB;

/** A limit as a person reads it: 3.75 MB, 12 MB, 200 KB. */
export function limitLabel(bytes) {
  return bytes >= MiB ? `${Number((bytes / MiB).toFixed(2))} MB` : `${Math.round(bytes / 1000)} KB`;
}

/** What follows every refusal of a file: the way that has no limit of this kind. */
export const PROJECT_FOLDER_ADVICE = 'Với tệp lớn hơn: đặt tệp vào thư mục dự án rồi nhắn tên hoặc đường dẫn tệp trong tin nhắn; agent đọc tệp bằng công cụ, không cần đính kèm.';
