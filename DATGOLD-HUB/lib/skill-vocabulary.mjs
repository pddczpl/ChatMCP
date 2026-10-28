// Which skill a request is about is decided by words (lib/plugins.mjs: selectSkillsForTask), and the words of the skills are English. A Vietnamese request used to be read
// as the few ASCII fragments of its words ("tạo nhánh mới" gave nothing), so it named no skill however clearly it asked for one. This is the short table that closes that
// gap: a Vietnamese phrase counts as the English words a translation of it would use, and the scorer then treats those like words the person typed. It is a table and not
// a translator: a phrase that is not here counts for nothing, as before, and the note under the turn says what was read (the scorer reports it).
//
// What the rows follow:
//   * A row says what an English request would say. "nhánh" is "branch" (an explicit trigger of the Git skill); "cơ sở dữ liệu" is "database" and "databases", words of two
//     descriptions (+1 each). A Vietnamese request is never easier to select than its English twin: "test", "workflow" (a word of the Git skill's id that is not about Git)
//     and "docs" are not rows, and "tài liệu" (documents) alone is nothing.
//   * `strict`: the phrase without its diacritics is another everyday phrase, so it is read only as written ("nhánh" a branch, "nhanh" fast; "bí mật" a secret, "bi mat"
//     "bị mất", lost). Typed without diacritics (a phone keyboard, a hurry) every row that is not strict is still read.
//   * The older place of a tone mark ("khoá", "khoẻ") needs no row of its own: both spellings fold to the same letters, and a row that is not strict is read folded too.
//     (A strict row that needs a second spelling lists it as a second phrase.)
const row = (phrases, words, strict = false) => Object.freeze({ phrases: Object.freeze(phrases), words: Object.freeze(words), strict });

export const CONCEPTS = Object.freeze([
  // Explicit triggers of the skills the Hub ships.
  row(['nhánh'], ['branch'], true),
  row(['bảo mật'], ['security']),
  row(['bí mật'], ['secret'], true),
  // Words of their descriptions (+1 each: they select with company, or with a project of that kind).
  row(['yêu cầu kéo'], ['pull', 'request']),
  row(['cơ sở dữ liệu'], ['database', 'databases']),
  row(['truy vấn'], ['queries']),
  row(['lược đồ'], ['schemas']),
  row(['chỉ mục'], ['indexes']),
  row(['thành phần'], ['component']),
  row(['khả năng truy cập'], ['accessible']),
  row(['khóa riêng'], ['private', 'keys']),
  row(['tài liệu chính thức'], ['official', 'documentation']),
  row(['tích hợp liên tục'], ['workflows', 'automated']),
  row(['triển khai liên tục'], ['workflows', 'automated']),
  row(['quy trình làm việc'], ['workflows']),
  row(['phát hành'], ['release']),
  row(['nhật ký'], ['logs']),
  row(['kiểm tra sức khỏe'], ['health', 'checks']),
]);

/** "Đường dẫn" -> "duong dan": lower case, no diacritics, đ as d. */
export function foldVietnamese(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd');
}

// A text as the words it is read in: letters and digits of any script, in one Unicode form (some keyboards and some pasted text carry the letter and its marks apart).
const syllables = (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const written = (phrase) => syllables(phrase.normalize('NFC').toLowerCase());

const READ = CONCEPTS.map((entry) => ({
  entry,
  asWritten: entry.phrases.map(written),
  bare: entry.strict ? [] : entry.phrases.map((phrase) => syllables(foldVietnamese(phrase))),
}));

// Whether `run` (the words of a phrase) stands in `words` unbroken.
function contains(words, run) {
  for (let at = 0; at + run.length <= words.length; at += 1) {
    if (run.every((word, offset) => words[at + offset] === word)) return true;
  }
  return false;
}

/**
 * The rows of the table that a text contains. `found`: [{ phrase, words }] in the order of the table; `words`: Map of each English word to the phrase it was read from.
 * A text that is not a string holds nothing.
 */
export function conceptsIn(text) {
  const found = [];
  const words = new Map();
  if (typeof text !== 'string' || !text) return { found, words };
  const asWritten = syllables(text.normalize('NFC').toLowerCase());
  const bare = syllables(foldVietnamese(text));
  for (const item of READ) {
    if (!item.asWritten.some((run) => contains(asWritten, run)) && !item.bare.some((run) => contains(bare, run))) continue;
    const phrase = item.entry.phrases[0];
    found.push({ phrase, words: [...item.entry.words] });
    for (const word of item.entry.words) if (!words.has(word)) words.set(word, phrase);
  }
  return { found, words };
}
