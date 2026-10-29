// The small structured input that the events of a tool call carry (plan task ux-3): which file, which command.
//
// A page, or a client of the Hub that is not the page (an editor over ACP), reads it instead of picking the path out of the sentence of the event ("Đang gọi X"). It is made from an
// allow-list of the arguments, strings only, each cut at a fixed length, so the text of a file, an edit or a patch is never in it; the event itself goes through the Hub's redaction
// of secrets like everything else it publishes.

const PATH_CHARS = 300;
const COMMAND_CHARS = 500;
const PATHS_LISTED = 20;

const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * @param {unknown} args  the arguments of the call, as the tool receives them
 * @returns {{path?: string, paths?: string[], source?: string, destination?: string, command?: string, truncated?: true}}
 *          `truncated` is set when something was cut: a path or a command that was longer than its limit, or more paths than are listed.
 */
export function publicToolInput(args) {
  const input = {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return input;
  let truncated = false;
  const clip = (value, limit) => {
    if (value.length <= limit) return value;
    truncated = true;
    return value.slice(0, limit);
  };
  // The tools that edit one file call it `path`; the semantic ones (rename_symbol, format_document) call it `file`.
  const path = text(args.path) ?? text(args.file);
  if (path !== null) input.path = clip(path, PATH_CHARS);
  // Several files: write_files_batch carries {path, content} entries, git_add a list of paths.
  const many = Array.isArray(args.files) ? args.files.map((entry) => (entry !== null && typeof entry === 'object' ? entry.path : undefined)) : Array.isArray(args.paths) ? args.paths : null;
  if (many !== null) {
    const named = many.filter((value) => text(value) !== null);
    if (named.length > PATHS_LISTED) truncated = true;
    if (named.length > 0) input.paths = named.slice(0, PATHS_LISTED).map((value) => clip(value, PATH_CHARS));
  }
  const source = text(args.source);
  const destination = text(args.destination);
  if (source !== null) input.source = clip(source, PATH_CHARS);
  if (destination !== null) input.destination = clip(destination, PATH_CHARS);
  const command = text(args.command);
  if (command !== null) input.command = clip(command, COMMAND_CHARS);
  if (truncated) input.truncated = true;
  return input;
}
