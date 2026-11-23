// What `chatmcp verify` says, in English and in Vietnamese (--lang en|vi). One message per answer code (./codes.mjs); a message gets the
// answer's facts (`detail` and a few fields of `data`) and never decides anything: the code does.

const list = 'init, trust, snapshot, run, exec, check, show, pack';
const why = {
  en: (p) => (p.timedOut ? 'timed out' : p.cancelled ? 'cancelled' : p.signal ? `ended by signal ${p.signal}` : `exit ${p.exit}`),
  vi: (p) => (p.timedOut ? 'quá thời gian' : p.cancelled ? 'bị hủy' : p.signal ? `bị dừng bởi tín hiệu ${p.signal}` : `mã thoát ${p.exit}`),
};
const unsafe = {
  en: { double_quote: 'it holds a double quote', empty: 'it is empty', stop_parsing: 'it is the stop-parsing token of PowerShell', trailing_backslash: 'it holds white space and ends with a backslash' },
  vi: { double_quote: 'nó chứa dấu ngoặc kép', empty: 'nó rỗng', stop_parsing: 'đó là ký hiệu dừng phân tích của PowerShell', trailing_backslash: 'nó có khoảng trắng và kết thúc bằng dấu gạch ngược' },
};

export const MESSAGES = Object.freeze({
  help: { en: () => 'Usage of chatmcp verify.', vi: () => 'Cách dùng chatmcp verify.' },
  version: { en: (p) => `DatGold ${p.version}`, vi: (p) => `DatGold ${p.version}` },
  acceptance_written: {
    en: (p) => `Wrote ${p.file} with ${p.criteria} criteria. Review it, then trust it: chatmcp verify trust`,
    vi: (p) => `Đã ghi ${p.file} với ${p.criteria} tiêu chí. Hãy đọc lại, rồi tin cậy nó: chatmcp verify trust`,
  },
  acceptance_printed: {
    en: (p) => `The proposed ${p.file}, with ${p.criteria} criteria (nothing was written).`,
    vi: (p) => `Bản đề xuất ${p.file}, với ${p.criteria} tiêu chí (không ghi gì).`,
  },
  trusted: {
    en: (p) => `The acceptance file ${p.sha256} is trusted: its checks may run.`,
    vi: (p) => `Tệp tiêu chí ${p.sha256} được tin cậy: các lệnh kiểm tra của nó được phép chạy.`,
  },
  revoked: { en: (p) => `Trust in ${p.sha256} was revoked.`, vi: (p) => `Đã thu hồi sự tin cậy với ${p.sha256}.` },
  already_untrusted: {
    en: (p) => `${p.sha256} was not trusted; there was nothing to revoke.`,
    vi: (p) => `${p.sha256} chưa được tin cậy; không có gì để thu hồi.`,
  },
  snapshot_taken: {
    en: (p) => `Baseline ${p.baselineId} taken; proof session ${p.taskId} started.`,
    vi: (p) => `Đã chụp mốc ${p.baselineId}; đã bắt đầu phiên bằng chứng ${p.taskId}.`,
  },
  check_passed: {
    en: (p) => `The check passed (exit 0); receipt ${p.seq} recorded.`,
    vi: (p) => `Lệnh kiểm tra đạt (mã thoát 0); đã ghi biên nhận ${p.seq}.`,
  },
  session_intact: {
    en: (p) => `Proof session ${p.taskId}: the ledger and the baseline verify.`,
    vi: (p) => `Phiên bằng chứng ${p.taskId}: sổ cái và mốc đều khớp.`,
  },
  pack_evidenced: {
    en: (p) => `Every criterion (${p.total}) is evidenced; the statement is in ${p.file}.`,
    vi: (p) => `Mọi tiêu chí (${p.total}) đều có bằng chứng; statement nằm ở ${p.file}.`,
  },
  acceptance_exists: {
    en: (p) => `${p.file} already exists; init never overwrites it.`,
    vi: (p) => `${p.file} đã có; init không bao giờ ghi đè nó.`,
  },
  acceptance_missing: {
    en: (p) => `There is no ${p.file} in this workspace, or it is not a regular file.`,
    vi: (p) => `Workspace này không có ${p.file}, hoặc đó không phải một tệp thường.`,
  },
  acceptance_invalid: {
    en: (p) => `${p.file} does not read: line ${p.line}, ${p.reason}.`,
    vi: (p) => `Không đọc được ${p.file}: dòng ${p.line}, ${p.reason}.`,
  },
  not_trusted: {
    en: (p) => `The acceptance file ${p.sha256} is not trusted, so its checks do not count. To trust these exact bytes: ${p.trustCommand}`,
    vi: (p) => `Tệp tiêu chí ${p.sha256} chưa được tin cậy nên các lệnh kiểm tra của nó không được tính. Để tin cậy đúng các byte này: ${p.trustCommand}`,
  },
  check_failed: {
    en: (p) => `The check did not pass (${why.en(p)}); receipt ${p.seq} recorded.`,
    vi: (p) => `Lệnh kiểm tra không đạt (${why.vi(p)}); đã ghi biên nhận ${p.seq}.`,
  },
  pack_unverified: {
    en: (p) => (p.total ? `${p.notEvidenced} of ${p.total} criteria are not evidenced; the statement is in ${p.file}.` : `There is no criterion to evidence; the statement is in ${p.file}.`),
    vi: (p) => (p.total ? `${p.notEvidenced}/${p.total} tiêu chí chưa có bằng chứng; statement nằm ở ${p.file}.` : `Không có tiêu chí nào để chứng minh; statement nằm ở ${p.file}.`),
  },
  no_command: {
    en: () => `No command. Use: chatmcp verify <command>, one of ${list} (chatmcp verify --help).`,
    vi: () => `Thiếu lệnh. Dùng: chatmcp verify <lệnh>, một trong ${list} (chatmcp verify --help).`,
  },
  unknown_command: {
    en: (p) => `Unknown command "${p.command}". Use: chatmcp verify <command>, one of ${list}.`,
    vi: (p) => `Không có lệnh "${p.command}". Dùng: chatmcp verify <lệnh>, một trong ${list}.`,
  },
  unknown_option: {
    en: (p) => `Unknown option ${p.option}${p.command ? ` for ${p.command}` : ''} (chatmcp verify --help).`,
    vi: (p) => `Không có tùy chọn ${p.option}${p.command ? ` cho ${p.command}` : ''} (chatmcp verify --help).`,
  },
  unexpected_argument: { en: (p) => `Unexpected argument "${p.argument}".`, vi: (p) => `Đối số thừa: "${p.argument}".` },
  missing_value: { en: (p) => `${p.option} needs a value.`, vi: (p) => `${p.option} cần một giá trị.` },
  bad_value: {
    en: (p) => `${JSON.stringify(p.value)} is not a value of ${p.option}: ${p.expected}.`,
    vi: (p) => `Giá trị ${JSON.stringify(p.value)} của ${p.option} không hợp lệ: cần ${p.expected}.`,
  },
  repeated_option: { en: (p) => `${p.option} is given more than once.`, vi: (p) => `${p.option} được đưa nhiều hơn một lần.` },
  missing_command_text: {
    en: () => 'run needs the command after --: chatmcp verify run -- <command>',
    vi: () => 'run cần lệnh đặt sau --: chatmcp verify run -- <lệnh>',
  },
  bad_workspace: { en: (p) => `The workspace ${p.path} is not a folder.`, vi: (p) => `Workspace ${p.path} không phải một thư mục.` },
  bad_cwd: {
    en: (p) => `--cwd ${JSON.stringify(p.cwd)} is not a folder inside the workspace.`,
    vi: (p) => `--cwd ${JSON.stringify(p.cwd)} không phải một thư mục bên trong workspace.`,
  },
  no_session: {
    en: () => 'There is no proof session for this workspace; start one with: chatmcp verify snapshot',
    vi: () => 'Workspace này chưa có phiên bằng chứng; hãy bắt đầu bằng: chatmcp verify snapshot',
  },
  unsafe_argument: {
    en: (p) => `The word ${JSON.stringify(p.argument)} would reach the program changed through ${p.shell} (${unsafe.en[p.why]}); give the whole command as one word after --.`,
    vi: (p) => `Từ ${JSON.stringify(p.argument)} sẽ bị ${p.shell} làm thay đổi trên đường tới chương trình (${unsafe.vi[p.why]}); hãy đưa cả lệnh thành một từ sau --.`,
  },
  bad_command: {
    en: (p) => `The command text is longer than ${p.max} characters or holds a NUL character.`,
    vi: (p) => `Lệnh dài quá ${p.max} ký tự hoặc chứa ký tự NUL.`,
  },
  sha256_mismatch: {
    en: (p) => `The acceptance file is ${p.actual}, not ${p.expected}: these are not the bytes you reviewed, so nothing was trusted.`,
    vi: (p) => `Tệp tiêu chí hiện là ${p.actual}, không phải ${p.expected}: đây không phải các byte bạn đã xem, nên không tin cậy gì cả.`,
  },
  ledger_broken: {
    en: (p) => `The proof ledger of ${p.taskId} does not verify at line ${p.brokenAt} (${p.reason}).`,
    vi: (p) => `Sổ cái bằng chứng của ${p.taskId} không khớp từ dòng ${p.brokenAt} (${p.reason}).`,
  },
  session_broken: {
    en: (p) => `The proof session is not whole (${p.why}); start a new one with chatmcp verify snapshot.`,
    vi: (p) => `Phiên bằng chứng không còn nguyên vẹn (${p.why}); hãy bắt đầu phiên mới bằng chatmcp verify snapshot.`,
  },
  session_edited: {
    en: () => 'The session\'s copy of the acceptance file was changed after the snapshot.',
    vi: () => 'Bản sao tệp tiêu chí của phiên đã bị thay đổi sau lúc chụp mốc.',
  },
  baseline_missing: {
    en: (p) => `The baseline ${p.baselineId} is gone (pruned after 14 days, or deleted).`,
    vi: (p) => `Mốc ${p.baselineId} không còn nữa (bị dọn sau 14 ngày, hoặc bị xóa).`,
  },
  baseline_edited: {
    en: (p) => `The baseline ${p.baselineId} was changed: its own sha256 does not match.`,
    vi: (p) => `Mốc ${p.baselineId} đã bị sửa: sha256 của chính nó không khớp.`,
  },
  baseline_mismatch: {
    en: (p) => `The baseline ${p.baselineId} is not the one the ledger names: its sha256 is not the anchor.`,
    vi: (p) => `Mốc ${p.baselineId} không phải mốc mà sổ cái ghi: sha256 của nó khác mỏ neo.`,
  },
  baseline_bad_record: { en: (p) => `The baseline ${p.baselineId} is not a valid record.`, vi: (p) => `Mốc ${p.baselineId} không phải một bản ghi hợp lệ.` },
  baseline_wrong_workspace: {
    en: (p) => `The baseline ${p.baselineId} belongs to another workspace.`,
    vi: (p) => `Mốc ${p.baselineId} thuộc về một workspace khác.`,
  },
  baseline_objects_missing: {
    en: () => 'The private store of the baseline is missing objects; no patch can be made.',
    vi: () => 'Kho riêng của mốc thiếu đối tượng; không tạo được bản vá.',
  },
  baseline_objects_mismatch: {
    en: () => 'The private store of the baseline does not hold the baseline\'s tree; no patch can be made.',
    vi: () => 'Kho riêng của mốc không chứa đúng cây của mốc; không tạo được bản vá.',
  },
  baseline_objects_unreadable: {
    en: () => 'Git could not read the private store of the baseline; no patch can be made.',
    vi: () => 'Git không đọc được kho riêng của mốc; không tạo được bản vá.',
  },
  patch_does_not_reproduce: {
    en: () => 'The patch applied to the baseline tree does not give the final tree.',
    vi: () => 'Áp bản vá lên cây của mốc không cho ra cây hiện tại.',
  },
  store_object_mismatch: {
    en: (p) => `A blob of the baseline store does not hash to its id (${p.path}).`,
    vi: (p) => `Một blob trong kho của mốc không băm ra đúng id của nó (${p.path}).`,
  },
  not_built: {
    en: (p) => `chatmcp verify ${p.command} is not built yet (plan task ${p.plannedIn}); nothing was done.`,
    vi: (p) => `chatmcp verify ${p.command} chưa được xây dựng (việc ${p.plannedIn} của kế hoạch); không làm gì cả.`,
  },
  state_inside_workspace: {
    en: (p) => `The state folder ${p.stateFolder} and the workspace ${p.workspace} lie inside one another; set CHATMCP_STATE_DIR to a folder outside the workspace.`,
    vi: (p) => `Thư mục trạng thái ${p.stateFolder} và workspace ${p.workspace} nằm lồng vào nhau; hãy đặt CHATMCP_STATE_DIR ra một thư mục bên ngoài workspace.`,
  },
  acceptance_outside: {
    en: () => '.chatmcp/acceptance.yml leads outside the workspace (through a link); nothing was read or written.',
    vi: () => '.chatmcp/acceptance.yml dẫn ra ngoài workspace (qua một liên kết); không đọc hay ghi gì cả.',
  },
  not_a_repository: {
    en: () => 'The workspace is not a Git repository: there is no patch, so there is no pack (snapshot, run and show still work).',
    vi: () => 'Workspace không phải kho Git: không có bản vá nên không có gói bằng chứng (snapshot, run và show vẫn dùng được).',
  },
  repository_unreadable: {
    en: () => 'The .git of the workspace names no folder: there is no patch, so there is no pack.',
    vi: () => '.git của workspace không trỏ tới thư mục nào: không có bản vá nên không có gói bằng chứng.',
  },
  git_missing: {
    en: () => 'Git is not available: there is no patch, so there is no pack.',
    vi: () => 'Không có Git: không có bản vá nên không có gói bằng chứng.',
  },
  object_format_changed: {
    en: () => 'The repository moved between SHA-1 and SHA-256 since the baseline.',
    vi: () => 'Kho đã chuyển giữa SHA-1 và SHA-256 kể từ lúc chụp mốc.',
  },
  patch_too_large: { en: () => 'The patch is larger than 128 MiB.', vi: () => 'Bản vá lớn hơn 128 MiB.' },
  baseline_busy: {
    en: () => 'Another baseline or diff of this workspace is running; try again later.',
    vi: () => 'Đang có một lần chụp mốc hoặc so sánh khác của workspace này; hãy thử lại sau.',
  },
  workspace_too_large: {
    en: () => 'The workspace is over the snapshot limits (200,000 files or 2 GiB).',
    vi: () => 'Workspace vượt giới hạn chụp (200.000 tệp hoặc 2 GiB).',
  },
  workspace_changed: {
    en: () => 'A file changed while the snapshot was being taken; take it again.',
    vi: () => 'Có tệp thay đổi trong lúc đang chụp; hãy chụp lại.',
  },
  shell_unavailable: {
    en: (p) => (p.shell ? `The shell ${p.shell} is not available on this machine.` : 'No shell is available on this machine (bash, sh or PowerShell).'),
    vi: (p) => (p.shell ? `Máy này không có shell ${p.shell}.` : 'Máy này không có shell nào (bash, sh hoặc PowerShell).'),
  },
  io_error: { en: (p) => `The file system refused: ${p.message}`, vi: (p) => `Hệ thống tệp từ chối: ${p.message}` },
  internal_error: { en: (p) => `Unexpected error: ${p.message}`, vi: (p) => `Lỗi không lường trước: ${p.message}` },
});

const USAGE = {
  en: `chatmcp verify <command> [options]

Commands:
  init [--print]                     propose .chatmcp/acceptance.yml from the project's files and write it (--print: write nothing)
  trust [--sha256 <hex>] [--revoke]  show, trust or revoke the exact bytes of .chatmcp/acceptance.yml
  snapshot                           take a baseline of the workspace and start a proof session
  run [--shell bash|sh|powershell] [--cwd <folder>] [--timeout <seconds>] -- <command>
                                     run a check and record its receipt in the session's ledger
  exec                               not built yet (plan task pod-26)
  check                              not built yet (plan task pod-32)
  show                               the session: its baseline, ledger, receipts and acceptance trust
  pack [--agent <name>] [--agent-version <version>]
                                     build the proof pack (an in-toto statement) of the session

Options of every command: --json, --lang en|vi, --workspace <folder>, --help
Exit codes: 0 pass, 1 unverified or failed, 2 usage, 3 integrity failure, 4 environment
State folder: CHATMCP_STATE_DIR, else the Hub's data folder. The CLI makes no network calls. See docs/PROOF-CLI.md.
`,
  vi: `chatmcp verify <lệnh> [tùy chọn]

Các lệnh:
  init [--print]                     đề xuất .chatmcp/acceptance.yml từ các tệp của dự án và ghi nó (--print: không ghi gì)
  trust [--sha256 <hex>] [--revoke]  xem, tin cậy hoặc thu hồi tin cậy đúng các byte của .chatmcp/acceptance.yml
  snapshot                           chụp mốc của workspace và bắt đầu một phiên bằng chứng
  run [--shell bash|sh|powershell] [--cwd <thư mục>] [--timeout <giây>] -- <lệnh>
                                     chạy một lệnh kiểm tra và ghi biên nhận vào sổ cái của phiên
  exec                               chưa được xây dựng (việc pod-26 của kế hoạch)
  check                              chưa được xây dựng (việc pod-32 của kế hoạch)
  show                               phiên hiện tại: mốc, sổ cái, biên nhận và trạng thái tin cậy
  pack [--agent <tên>] [--agent-version <phiên bản>]
                                     tạo gói bằng chứng (một statement in-toto) của phiên

Tùy chọn của mọi lệnh: --json, --lang en|vi, --workspace <thư mục>, --help
Mã thoát: 0 đạt, 1 chưa được kiểm chứng hoặc không đạt, 2 sai cách dùng, 3 hỏng toàn vẹn, 4 môi trường
Thư mục trạng thái: CHATMCP_STATE_DIR, nếu không thì thư mục dữ liệu của Hub. CLI không gọi mạng. Xem docs/PROOF-CLI.md.
`,
};

/** The usage text in `lang`. */
export const usage = (lang) => USAGE[lang] ?? USAGE.en;

/** The message of `code` in `lang` with the facts `params`. */
export function messageOf(code, lang, params = {}) {
  const texts = MESSAGES[code];
  if (!texts) throw new TypeError(`no message for ${code}`);
  return (texts[lang] ?? texts.en)(params);
}
