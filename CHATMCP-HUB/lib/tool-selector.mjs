// Task-aware tool schema selection. Only the directly advertised schemas are
// reduced: the complete catalog and PermissionGate-routed mcp_call remain intact.
const BASE=[
  'read_file','list_directory','find_files','search_files','file_info',
  'git_status','git_diff','get_plan','update_plan','checks_list','checks_run',
  'run_command','tasks_status','tasks_cancel','token_restore',
];
const GROUPS=[
  {re:/\b(fix|edit|write|implement|patch|refactor|rename|create|develop|feature|code)\b|sửa|viết|tạo|triển khai|lập trình/i,
   names:['edit_file','write_file','files_apply_patch','files_write_batch','make_directory','move_path','delete_path','rename_symbol','format_document','organize_imports']},
  {re:/\b(test|lint|verify|check|coverage|build|compile|ci)\b|kiểm thử|kiểm tra|biên dịch/i,
   names:['test_discover','test_run','test_results','test_coverage','test_impact_analysis','build_detect','build_run','code_diagnostics']},
  {re:/\b(browser|web ui|frontend|responsive|screenshot|playwright|css|html|accessibility)\b|giao diện|trình duyệt/i,
   names:['browser_launch','browser_navigate','browser_click','browser_fill','browser_screenshot','browser_console','browser_network','browser_close','responsive_check','accessibility_audit','screenshot_compare','visual_diff']},
  {re:/\b(lsp|symbol|reference|definition|dependency|type|ast|tree.?sitter)\b|định nghĩa|tham chiếu|ký hiệu/i,
   names:['repo_map','code_symbols','find_definition','find_references','dependency_graph','code_diagnostics','code_actions','find_implementations','type_hierarchy']},
  {re:/\b(debug|breakpoint|stack|inspect|exception)\b|gỡ lỗi/i,
   names:['debug_start','debug_breakpoint','debug_continue','debug_step','debug_stack','debug_variables','debug_evaluate','debug_stop']},
  {re:/\b(git|branch|commit|merge|worktree|conflict|pull request|github|release)\b|nhánh|hợp nhất/i,
   names:['git_log','git_add','git_commit','git_branch','git_checkout','git_merge','git_conflict_inspect','worktrees_list','worktrees_create','github_workflow_runs','github_pr_review']},
  {re:/\b(research|search web|documentation|docs|internet|dependency lookup)\b|tra cứu|tài liệu/i,
   names:['web_search','web_fetch','web_extract','docs_search','dependency_lookup','github_code_search']},
];
export function taskToolSelectionMode(env=process.env) {
  return env.CHATMCP_TOOL_SELECTION==='auto'?'auto':'full';
}
export function selectTaskToolNames(prompt,{cap=48}={}) {
  if(!Number.isInteger(cap)||cap<1||cap>124)throw new TypeError('Invalid schema budget');
  const set=new Set(BASE);
  for(const group of GROUPS)if(group.re.test(String(prompt)))for(const name of group.names)set.add(name);
  // Before opening files, baseline code navigation helps the agent gather evidence.
  for(const x of ['repo_map','code_symbols','find_definition'])set.add(x);
  return [...set].slice(0,cap);
}
export function selectTaskCatalog(catalog,prompt,{cap=48}={}) {
  const names=new Set(selectTaskToolNames(prompt,{cap}));
  return {...catalog,tools:catalog.tools.filter(x=>x.server==='local'&&names.has(x.originalName))};
}
