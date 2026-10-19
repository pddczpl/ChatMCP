// Task-aware tool schema selection. Only the directly advertised schemas are
// reduced: the complete catalog and PermissionGate-routed mcp_call remain intact.
const BASE=[
  'read_file','list_directory','find_files','search_files','file_info',
  'git_status','git_diff','get_plan','update_plan','checks_list','checks_run',
  'run_command','tasks_status','tasks_cancel','token_restore',
];
// Whole words only, and Unicode-aware: \b does not see where a Vietnamese word that starts or ends with an accented letter begins. A space in
// a pattern stands for any run of whitespace. The alternations are flat on purpose: the prompt is user text.
const words=(...parts)=>new RegExp('(?<![\\p{L}\\p{N}_])(?:'+parts.map(part=>part.source).join('|').replace(/ /g,'\\s+')+')(?![\\p{L}\\p{N}_])','iu');
// Verbs that move code or files about. They offer the tools that shape the file tree on top of the ones every change verb offers.
const SHAPE_VERBS=/move|moving|extract|split|convert|converting|migrate|migrating|scaffold|generate|bootstrap|restructure|reorgani[sz]e|combine|tách|gộp|chuyển/;
// A report of a failure asks for the fix without saying so: "the CLI crashes when the config is missing", "TypeError: ...", "build báo lỗi".
const FAILURE_WORDS=/bugs?|errors?|\w*error|exceptions?|crash(?:es|ed|ing)?|broken|fail(?:s|ed|ing|ure|ures)?|wrong|incorrect|stuck|hangs?|freez(?:e|es|ing)|regression/;
const FAILURE_PHRASES=/tracebacks?|stack\s*traces?|warnings?|deprecated|typos?|twice|nothing happens|does nothing|stopped working|no longer works?|not (?:working|showing|saving|updating|loading)/;
const FAILURE_CLAUSES=/(?:doesn.t|does not) (?:work|show|load|save|update|respond|render|appear|start|run)|enoent|eacces|eaddrinuse|econnrefused|etimedout/;
const FAILURE_VI=/lỗi|treo|đơ|hỏng|sai|văng|(?<!khoảng )trắng|không (?:chạy|hoạt động|hiển thị|lưu|load|mở được|vào được|kết nối được)/;
// Code that repeats itself asks to be refactored, whether or not the prompt says "refactor".
const DUPLICATION=/duplicat(?:e|ed|es|ion)|copy.?paste|trùng lặp|tái cấu trúc|rút gọn/;
// A group offers its names to a prompt that matches `re`, the original triggers, which stay as they were. `more` are triggers added later:
// plurals and inflections ("tests", "commits"), the words ordinary prompts use ("update", "mobile", "who calls") and the Vietnamese ones. A group
// with only `more` offers tools that no original group had, or a cheaper part of one. `plus` are tools a group gained later: they follow the
// ones it always had. Order matters twice: the cap cuts from the end, and selectTaskToolNames puts everything `more` and `plus` select after
// everything `re` selected, in this order, so the tools a prompt most needs come first.
const GROUPS=[
  {re:/\b(fix|edit|write|implement|patch|refactor|rename|create|develop|feature|code)\b|sửa|viết|tạo|triển khai|lập trình/i,
   names:['edit_file','write_file','files_apply_patch','files_write_batch','make_directory','move_path','delete_path','rename_symbol','format_document','organize_imports']},
  // The general change verbs ("update the version", "remove the helper", "bump it") are a long, open list, so they offer only the four tools that
  // change a file (about 0.8k tokens): a question that happens to use one of them costs little. The tools that shape the tree, the LSP
  // refactoring tools and the rest wait for a word that is about them. A verb outside the list still reaches every tool through mcp_describe
  // and mcp_call, and the prompt can say "edit" or "fix".
  {more:words(
     /add|adding|update|updating|change|changing|modify|alter|adjust|tweak|apply/,
     /remove|removing|delete|deleting|drop|get rid of|clean up|cleanup|tidy up|comment out|uncomment/,
     /replace|replacing|swap|switch|upgrade|upgrading|downgrade|bump|instead of/,
     /make(?! sure)|set|enable|disable|toggle|turn on|turn off|hook up|wire up|introduce|inline|insert|append|prepend|wrap|unwrap/,
     /increase|decrease|reduce|improve|optimi[sz]e|simplify|rewrite|handle|resolve|allow|prevent|ensure|validate|sanitize|throw|translate|localize|reword|proofread/,
     /cập nhật|thêm|xóa|xoá|bỏ|thay(?! đổi)|(?<!thay )đổi|(?<!(?:các|những|mọi|nhiều|tất cả|vài) )thay đổi|nâng cấp|hạ cấp|bổ sung|chỉnh/,
     /tăng|giảm|cải thiện|tối ưu|dọn dẹp|làm cho|bật|tắt|(?<!cài )đặt|thiết lập|chèn|áp dụng|ngăn|cho phép|đảm bảo|xác thực/,
     SHAPE_VERBS,FAILURE_WORDS,FAILURE_PHRASES,FAILURE_CLAUSES,FAILURE_VI,DUPLICATION),
   names:['edit_file','write_file','delete_path','files_apply_patch']},
  {more:words(SHAPE_VERBS),
   names:['move_path','make_directory','files_write_batch']},
  // Refactoring starts with who uses the code: its references and the modules that import it.
  {more:words(/refactor|refactoring|rename|renaming|extract|inline|split|move|moving|restructure|reorgani[sz]e|dedupe|deduplicate|đổi tên|tách|gộp|di chuyển/,DUPLICATION),
   names:['find_references','dependency_graph']},
  {more:words(/format|formatting|formatter|reformat|prettier|organi[sz]e|imports?|đổi tên|định dạng/),
   names:['rename_symbol','format_document','organize_imports']},
  {more:words(/bump|upgrad(?:e|es|ing)|downgrad(?:e|es|ing)|outdated|dependencies|(?:latest|newest|current) (?:versions?|releases?)|nâng cấp|hạ cấp|(?:phiên )?bản mới nhất|thư viện/),
   names:['dependency_lookup','docs_search']},
  // tasks_status and tasks_cancel are always offered, but the call that starts a task was not.
  {more:words(/dev server|development server|start (?:the )?(?:app|server|dev)|(?:in|into) the background|background (?:tasks?|process|jobs?)|watch mode|long.running|npm run dev|chạy nền|khởi động (?:app|server|ứng dụng)/),
   names:['tasks_run','tasks_list']},
  {re:/\b(test|lint|verify|check|coverage|build|compile|ci)\b|kiểm thử|kiểm tra|biên dịch/i,
   more:words(/tests|testing|lints|linting|linters?|verif(?:ies|ying|ication)|checks|checking|builds|building|compil(?:es|ing|ation)/,/e2e|jest|vitest|mocha|pytest|regression|độ phủ|chạy thử/),
   names:['test_discover','test_run','test_results','test_coverage','test_impact_analysis','build_detect','build_run','code_diagnostics']},
  {re:/\b(browser|web ui|frontend|responsive|screenshot|playwright|css|html|accessibility)\b|giao diện|trình duyệt/i,
   more:words(/mobile|viewports?|breakpoints?|layouts?|ui|ux|localhost|127\.0\.0\.1|(?:small|narrow|wide|big|large) screens?|screen\s*sizes?|dark mode|renders?|rendering/,
     /looks? (?:broken|wrong|off|weird|bad)|console errors?|màn hình|điện thoại|di động|bố cục|trang web/),
   names:['browser_launch','browser_navigate','browser_click','browser_fill','browser_screenshot','browser_console','browser_network','browser_close','responsive_check','accessibility_audit','screenshot_compare','visual_diff'],
   plus:['browser_dom_snapshot','browser_assert','screenshot_capture']},
  {re:/\b(lsp|symbol|reference|definition|dependency|type|ast|tree.?sitter)\b|định nghĩa|tham chiếu|ký hiệu/i,
   more:words(/symbols|references|definitions|usages|find usages|callers?|callees?|call (?:sites?|graph|hierarchy)|who (?:calls|uses|imports)/,
     /(?:called|used|imported|referenced) (?:by|from)|which (?:files|modules) import|importers?|blast radius|dependents?|dependencies|depend(?:s|ing)? on/,
     /implementations?|implemented by|implementers?|implementors?|(?:classes|types|structs|objects) (?:that |which )?(?:implement|extend)s?|subclass(?:es)?|inherit(?:s|ance)?|hierarch(?:y|ies)/,
     /module not found|cannot find module|can.t resolve|unresolved (?:imports?|references?)|is not exported/,
     /được gọi|đang gọi|gọi từ|gọi đến|gọi tới|ai gọi|nơi gọi|chỗ gọi|được dùng|dùng ở đâu|chỗ nào dùng|phụ thuộc|kế thừa|lớp con|class con/),
   names:['repo_map','code_symbols','find_definition','find_references','dependency_graph','code_diagnostics','code_actions','find_implementations','type_hierarchy']},
  {re:/\b(debug|breakpoint|stacktrace|call stack|runtime exception)\b|gỡ lỗi/i,
   more:words(/debugging|debugger|breakpoints|stack\s*traces?|step through/),
   names:['debug_start','debug_breakpoint','debug_continue','debug_step','debug_stack','debug_variables','debug_evaluate','debug_stop']},
  {re:/\b(git|branch|commit|merge|worktree|conflict|pull request|github|release)\b|nhánh|hợp nhất/i,
   more:words(/commits|branches|merges|worktrees|conflicts|prs?|pull requests|rebas(?:e|ing)|stash|cherry.?pick|revert|squash|amend|xung đột|hoàn tác|lịch sử/),
   names:['git_log','git_add','git_commit','git_branch','git_checkout','git_merge','git_conflict_inspect','worktrees_list','worktrees_create','github_workflow_runs','github_pr_review']},
  {re:/\b(research|search web|documentation|docs|internet|dependency lookup)\b|tra cứu|tài liệu/i,
   names:['web_search','web_fetch','web_extract','docs_search','dependency_lookup','github_code_search']},
  // The GitHub CLI tools no group had: reading and opening pull requests and issues, and the run, status and failed-step logs of a CI run.
  {more:words(/github|gh|ci|prs?|pull requests?|merge requests?|workflow runs?|pipelines?|issue #?\d+|(?:open|create|file) (?:an? )?issues?/),
   names:['github_read','github_action','github_workflow_runs','github_workflow_status','github_job_logs','github_pr_review','github_rerun_failed','github_pr_merge','github_release_create']},
];
export function taskToolSelectionMode(env=process.env) {
  return env.CHATMCP_TOOL_SELECTION==='auto'?'auto':'full';
}
// The foreground chat (the hub's primary runner) used to offer all 103 schemas, about 15.4k tokens, to every model. Against an unknown or
// small window that is most of the room there is: the task-selected subset (about 3-7k tokens) leaves the history the space. A window of
// this size or more keeps the full list, as before. CHATMCP_TOOL_SELECTION=full|auto overrides the choice either way.
export const LARGE_WINDOW_TOKENS=65536;
export function windowToolSelectionMode(contextWindowTokens,env=process.env) {
  if(env.CHATMCP_TOOL_SELECTION==='full'||env.CHATMCP_TOOL_SELECTION==='auto')return env.CHATMCP_TOOL_SELECTION;
  return Number.isFinite(contextWindowTokens)&&contextWindowTokens>=LARGE_WINDOW_TOKENS?'full':'auto';
}
// Make runner.toolSelectionMode follow the context window of the provider the runner has when a task starts (ConcurrentApiAgent sets
// runner.provider to the task's profile before it starts the task). Assigning a mode still wins; assigning null hands the choice back.
export function followProviderWindow(runner,env=process.env) {
  let explicit=runner.toolSelectionMode??null;
  Object.defineProperty(runner,'toolSelectionMode',{configurable:true,enumerable:true,
    get() {
      if(explicit!==null)return explicit;
      let window=null;
      try{window=this.provider?.state?.()?.contextWindowTokens??null;}catch{/* a provider that cannot say counts as unknown */}
      return windowToolSelectionMode(window,env);
    },
    set(value) {explicit=value??null;}});
  return runner;
}
export function selectTaskToolNames(prompt,{cap=48}={}) {
  if(!Number.isInteger(cap)||cap<1||cap>124)throw new TypeError('Invalid schema budget');
  // NFC first: a decomposed Vietnamese prompt (some editors and PDF copies produce one) would miss every literal with an accent.
  const text=String(prompt).normalize('NFC');
  const set=new Set(BASE);
  for(const group of GROUPS)if(group.re?.test(text))for(const name of group.names)set.add(name);
  // Before opening files, baseline code navigation helps the agent gather evidence.
  for(const x of ['repo_map','code_symbols','find_definition'])set.add(x);
  // What the later triggers add goes last, so the cap can cut only that: a prompt the original triggers matched is offered at least what it was.
  for(const group of GROUPS)if(group.re?.test(text)||group.more?.test(text))for(const name of [...group.names,...(group.plus??[])])set.add(name);
  return [...set].slice(0,cap);
}
export function selectTaskCatalog(catalog,prompt,{cap=48}={}) {
  const names=new Set(selectTaskToolNames(prompt,{cap}));
  return {...catalog,tools:catalog.tools.filter(x=>x.server==='local'&&names.has(x.originalName))};
}
