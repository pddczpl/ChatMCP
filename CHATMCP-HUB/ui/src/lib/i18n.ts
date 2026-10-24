import { useAppStore } from '@/store/useAppStore';
import { agentsVi, agentsEn } from './i18n-agents.ts';
import type { sectionsVi } from './i18n-agents-sections.ts';

export const translations = {
  vi: {
    // Header
    hub_connected: 'Hub kết nối',
    refresh: 'Làm mới',
    theme_dark: 'Tối',
    theme_light: 'Sáng',
    theme_system: 'Hệ thống',
    new_conversation_btn: 'Hội thoại mới',

    // Sessions Sidebar
    search_sessions: 'Tìm kiếm phiên...',
    delete: 'Xóa phiên',

    // Welcome Screen
    welcome_title: 'ChatMCP Studio',
    welcome_desc: 'AI Coding Agent chuyên nghiệp chạy trực tiếp trên workspace của bạn. Chọn gợi ý bên dưới hoặc nhập yêu cầu trực tiếp.',
    starter_1_title: 'Phân tích kiến trúc codebase',
    starter_1_desc: 'Quét toàn bộ cấu trúc dự án và lập tài liệu tổng quan.',
    starter_2_title: 'Tạo unit test cho các module',
    starter_2_desc: 'Viết test tự động và chạy xác minh ngay trong workspace.',
    starter_3_title: 'Rà soát bảo mật & CSP',
    starter_3_desc: 'Kiểm tra Content Security Policy, sanitize dữ liệu và an toàn runtime.',
    starter_4_title: 'Tối ưu hóa & Refactor',
    starter_4_desc: 'Cải thiện hiệu năng, giảm duplicate code và làm sạch logic.',

    // Composer
    composer_placeholder: 'Bạn muốn làm gì với dự án này?',
    send: 'Gửi',
    stop: 'Dừng',
    enter_to_send: 'Enter để gửi · Shift+Enter xuống dòng',
    perm_read_only: 'Chỉ đọc (Read-only)',
    perm_read_only_desc: 'Agent chỉ đọc file và tìm kiếm, không sửa đổi.',
    perm_review: 'Review (Mặc định)',
    perm_review_desc: 'Yêu cầu phê duyệt trước khi ghi file hoặc chạy lệnh shell.',
    perm_auto: 'Tự động (Autonomous)',
    perm_auto_desc: 'Tự động chạy các tool trong workspace mà không hỏi lại.',
    perm_full_access: 'FULL ACCESS ⚠️',
    perm_full_access_desc: 'Bỏ qua xác nhận cho việc thường ngày; xóa dữ liệu, git push, merge PR, tạo/xóa release hoặc repo vẫn hỏi lại.',

    // Inspector Tabs
    tab_activity: 'Hoạt động',
    tab_files: 'Tệp',
    tab_terminal: 'Terminal',
    tab_preview: 'Xem trước',

    // Agents tab: the strings the first screen asks for (the sections' own are in i18n-agents-sections.ts and join these when the sections load)
    ...agentsVi,

    // Settings Tab
    agent_exec_mode: 'Chế độ quyền thực thi của Agent',
    theme_label: 'Giao diện (Theme)',
    lang_label: 'Ngôn ngữ (Language)',
    lang_vi: 'Tiếng Việt (Mặc định)',
    lang_en: 'English',
    export_data: 'Xuất dữ liệu',
    backend_status: 'ChatMCP Hub Backend',
    workspace_setting_title: 'Thư mục dự án (Workspace)',
    workspace_setting_desc: 'Thư mục mã nguồn mà Agent thao tác và kiểm tra trực tiếp.',
    workspace_browse_btn: 'Duyệt...',
    workspace_apply_btn: 'Áp dụng',
    workspace_reopen_onboarding: 'Mở lại hướng dẫn khởi động',
    workspace_changed_toast: 'Đã đổi thư mục làm việc thành công',
    sandbox_title: 'Môi trường thực thi & Cách ly OS',
    sandbox_desc: 'Xác thực backend thực thi và mức độ cách ly hệ điều hành thực tế.',
    sandbox_probing: 'Đang kiểm tra...',
    sandbox_isolated: 'Đã cách ly OS',
    sandbox_unisolated: 'Không cách ly OS (Host)',
    sandbox_backend: 'Backend thực thi',
    sandbox_os_isolation: 'Cách ly hệ điều hành',
    sandbox_isolation_active: 'Bật (Separate kernel)',
    sandbox_isolation_none: 'Tắt (Chạy trên host, quyền tài khoản Windows)',
    sandbox_enforced: 'Giới hạn đã áp dụng',
    sandbox_unsupported: 'Giới hạn chưa hỗ trợ',
    sandbox_unenforced_hint: 'chưa được OS thực thi',

    // AI Model Tab
    ai_status_ready: 'Sẵn sàng',
    ai_status_unconfigured: 'Chưa thiết lập',
    ai_provider_title: 'Chọn nhà cung cấp mô hình (Provider)',
    ai_model_id: 'Tên mô hình (Model ID)',
    ai_base_url: 'Base URL (API Endpoint)',
    ai_base_url_hint: 'vd: https://api.openai.com/v1 hoặc http://127.0.0.1:11434/v1 hoặc endpoint OpenAI-compatible',
    ai_api_key: 'API Key / Access Token',
    ai_api_key_hint: 'Để trống nếu dùng biến môi trường hoặc máy chủ local',
    ai_test_conn: 'Kiểm tra kết nối',
    ai_testing: 'Đang kiểm tra...',
    ai_save_config: 'Lưu cấu hình',
    ai_test_success: 'Kết nối thành công!',
    ai_test_fail: 'Kiểm tra kết nối thất bại',
    ai_save_success: 'Đã lưu cấu hình AI',

    // Skills Marketplace Tab
    cat_all: 'Tất cả',
    cat_coding: 'Lập trình',
    cat_devops: 'DevOps',
    cat_research: 'Nghiên cứu & Web',
    cat_governance: 'Bảo mật & Quản trị',
    cat_data: 'Dữ liệu',

    // Preview Tab
    preview_url_placeholder: 'http://localhost:3000 hoặc http://localhost:5173...',
    preview_reload: 'Làm mới xem trước',
    preview_new_tab: 'Tab mới trong App',
    preview_tab_close: 'Đóng tab',
    preview_external_note: 'Các trang bên ngoài (như Google) gửi header X-Frame-Options cấm nhúng iframe. Ứng dụng dev cục bộ (localhost) hoạt động 100% không bị chặn.',
    preview_quick_ports: 'Cổng nhanh:',

    // Activity, Files, Git, Terminal, Plan
    activity_title: 'Nhật ký hoạt động',
    activity_empty: 'Chưa có hoạt động nào được ghi lại',
    activity_events: 'sự kiện',
    files_search: 'Lọc tệp tin...',
    files_modified: 'Tệp đã sửa đổi',
    files_count: 'tệp',
    git_clean: 'Workspace sạch',
    git_dirty: 'Có thay đổi chưa commit',
    git_checkpoint_create: 'Tạo điểm an toàn (Checkpoint)',
    git_checkpoint_placeholder: 'Tên checkpoint (vd: Trước khi refactor)...',
    git_checkpoint_save: 'Lưu',
    git_checkpoint_history: 'Lịch sử Checkpoints',
    git_checkpoint_empty: 'Chưa có checkpoint nào được tạo',
    git_checkpoint_revert: 'Khôi phục',
    terminal_title: 'Terminal Output',
    terminal_autoscroll: 'Tự động cuộn',
    terminal_empty: 'Không có nhật ký terminal nào đang chạy',
    plan_steps: 'Các bước thực thi',

    // UI refresh
    header_search: 'Tìm kiếm hoặc chạy lệnh…',
    header_settings: 'Cài đặt',
    header_theme_toggle: 'Chuyển theme sáng / tối',
    hub_connecting: 'Đang kết nối Hub',
    hub_lost: 'Mất kết nối Hub',
    sidebar_workspaces: 'Workspace',
    sidebar_add_workspace: 'Thêm workspace',
    sidebar_empty_workspaces: 'Chưa có workspace. Bấm dấu + để chọn thư mục trên máy.',
    sidebar_empty_chats: 'Chưa có hội thoại. Tạo chat mới để giao việc.',
    tab_progress: 'Tiến độ',
    tab_changes: 'Thay đổi',
    tab_agents: 'Tác nhân',
    tab_more: 'Thêm',
    inspector_nav: 'Công cụ làm việc',
    settings_title: 'Cài đặt',
    settings_close: 'Đóng cài đặt',
    settings_nav: 'Các mục cài đặt',
    sec_workspace: 'Dự án',
    sec_model: 'Mô hình AI',
    sec_permissions: 'Quyền & thực thi',
    sec_agent_channel: 'Kênh agent',
    sec_skills: 'Kỹ năng',
    sec_code_intel: 'Phân tích mã',
    sec_appearance: 'Giao diện & ngôn ngữ',
    sec_about: 'Thông tin & dữ liệu',
    status_context: 'Ngữ cảnh',
    status_no_model: 'Chưa kết nối AI',
    status_companion_connected: 'Companion đã kết nối',
    status_companion_paired: 'Companion đã ghép, chờ tab ChatGPT',
    status_companion_missing: 'Chưa ghép Companion',
    status_mode: 'Chế độ quyền',
    status_model: 'Mô hình',
    full_access_banner: 'FULL ACCESS đang bật: agent có thể thao tác ngoài workspace. Việc nguy hiểm (xóa dữ liệu, push, merge, release) vẫn hỏi lại.',
    full_access_turn_off: 'Quay về Review',

    // Settings → Dự án: the owner's switch for AGENTS.md / CLAUDE.md
    pi_title: 'Hướng dẫn của dự án',
    pi_desc: 'Đầu mỗi lượt chạy, Hub đọc AGENTS.md và CLAUDE.md ở thư mục gốc dự án và đưa vào chỉ dẫn của agent.',
    pi_label: 'Nạp AGENTS.md / CLAUDE.md vào chỉ dẫn của agent',
    pi_point_untrusted: 'Đây là văn bản không tin cậy do người viết dự án đặt. Hub chỉ nạp tối đa 8.192 byte (phần dư bị cắt và được ghi rõ), và chúng không thể nâng quyền hay bỏ qua bước duyệt.',
    pi_point_off: 'Tắt chỉ có nghĩa là Hub không tự nạp; agent vẫn có thể mở các tệp này bằng công cụ đọc tệp như mọi tệp khác.',
    pi_point_next: 'Thay đổi áp dụng từ lượt chạy kế tiếp; lượt đang chạy giữ nguyên những gì đã nạp.',
    pi_point_scope: 'Chỉ kênh Model API dùng tính năng này; kênh ChatGPT Web thì không.',
    pi_status_unknown: 'Hub chưa báo trạng thái của cài đặt này.',
    pi_status_default_on: 'Đang bật (mặc định).',
    pi_status_config_on: 'Đang bật (bạn đã chọn).',
    pi_status_config_off: 'Đang tắt (bạn đã chọn).',
    pi_status_env_on: 'Đang bật do biến môi trường của Hub:',
    pi_status_env_off: 'Đang tắt do biến môi trường của Hub:',
    pi_locked: 'Không đổi được ở đây. Bỏ biến môi trường rồi khởi động lại Hub để dùng lựa chọn của bạn.',
    pi_saved_on: 'Lựa chọn đã lưu của bạn: bật.',
    pi_saved_off: 'Lựa chọn đã lưu của bạn: tắt.',
    pi_running: 'Có tác vụ đang chạy: thay đổi áp dụng từ lượt chạy kế tiếp.',
    pi_toast_on: 'Đã bật nạp AGENTS.md / CLAUDE.md từ lượt chạy kế tiếp.',
    pi_toast_off: 'Đã tắt nạp AGENTS.md / CLAUDE.md từ lượt chạy kế tiếp.',
    pi_error: 'Không lưu được cài đặt hướng dẫn dự án.',
    mode_readonly: 'Chỉ đọc',
    mode_review: 'Review',
    mode_autonomous: 'Tự động',
    mode_full_access: 'FULL ACCESS',
  },
  en: {
    // Header
    hub_connected: 'Hub Connected',
    refresh: 'Refresh',
    theme_dark: 'Dark',
    theme_light: 'Light',
    theme_system: 'System',
    new_conversation_btn: 'New Session',

    // Sessions Sidebar
    search_sessions: 'Search sessions...',
    delete: 'Delete session',

    // Welcome Screen
    welcome_title: 'ChatMCP Studio',
    welcome_desc: 'Autonomous AI Coding Agent running directly on your workspace. Select a starter below or enter a prompt.',
    starter_1_title: 'Analyze Codebase Architecture',
    starter_1_desc: 'Scan repository structure and generate an architectural overview.',
    starter_2_title: 'Generate Module Unit Tests',
    starter_2_desc: 'Scaffold automated unit tests and execute validation inside workspace.',
    starter_3_title: 'Security & CSP Audit',
    starter_3_desc: 'Audit Content Security Policy, sanitize inputs, and verify runtime safety.',
    starter_4_title: 'Optimize & Refactor',
    starter_4_desc: 'Enhance performance, eliminate duplicate code, and clean architecture.',

    // Composer
    composer_placeholder: 'What would you like to do with this project?',
    send: 'Send',
    stop: 'Stop',
    enter_to_send: 'Enter to send · Shift+Enter for newline',
    perm_read_only: 'Read-only',
    perm_read_only_desc: 'Agent only inspects code and git, no modifications allowed.',
    perm_review: 'Review (Default)',
    perm_review_desc: 'Requires approval diff before modifying files or executing shell commands.',
    perm_auto: 'Autonomous',
    perm_auto_desc: 'Automatically executes workspace tools without prompts.',
    perm_full_access: 'FULL ACCESS ⚠️',
    perm_full_access_desc: 'Skips confirmations for everyday work; deleting data, git push, merging PRs and creating/deleting releases or repos still ask.',

    // Inspector Tabs
    tab_activity: 'Activity',
    tab_files: 'Files',
    tab_terminal: 'Terminal',
    tab_preview: 'Preview',

    // Agents tab: the strings the first screen asks for (the sections' own are in i18n-agents-sections.ts and join these when the sections load)
    ...agentsEn,

    // Settings Tab
    agent_exec_mode: 'Agent Execution Mode',
    theme_label: 'Theme',
    lang_label: 'Language',
    lang_vi: 'Tiếng Việt (Vietnamese)',
    lang_en: 'English (Current)',
    export_data: 'Export Data',
    backend_status: 'ChatMCP Hub Backend',
    workspace_setting_title: 'Project Workspace Directory',
    workspace_setting_desc: 'Source code folder that Agent directly edits and tests on.',
    workspace_browse_btn: 'Browse...',
    workspace_apply_btn: 'Apply',
    workspace_reopen_onboarding: 'Reopen Onboarding Walkthrough',
    workspace_changed_toast: 'Workspace directory changed successfully',
    sandbox_title: 'Execution Backend & OS Isolation',
    sandbox_desc: 'Verifies actual runtime execution backend and OS isolation boundaries.',
    sandbox_probing: 'Probing...',
    sandbox_isolated: 'OS Isolated',
    sandbox_unisolated: 'Host Unisolated',
    sandbox_backend: 'Execution Backend',
    sandbox_os_isolation: 'OS Isolation',
    sandbox_isolation_active: 'Enabled (Separate kernel)',
    sandbox_isolation_none: 'Disabled (Runs on host, user account privileges)',
    sandbox_enforced: 'Enforced Limits',
    sandbox_unsupported: 'Unsupported Limits',
    sandbox_unenforced_hint: 'not enforced by OS',

    // AI Model Tab
    ai_status_ready: 'Ready',
    ai_status_unconfigured: 'Unconfigured',
    ai_provider_title: 'Model Provider',
    ai_model_id: 'Model ID',
    ai_base_url: 'Base URL (API Endpoint)',
    ai_base_url_hint: 'e.g. https://api.openai.com/v1, http://127.0.0.1:11434/v1, or another OpenAI-compatible API',
    ai_api_key: 'API Key / Access Token',
    ai_api_key_hint: 'Leave blank to use environment variables or local server',
    ai_test_conn: 'Test Connection',
    ai_testing: 'Testing...',
    ai_save_config: 'Save Configuration',
    ai_test_success: 'Connection successful!',
    ai_test_fail: 'Connection test failed',
    ai_save_success: 'AI configuration saved successfully',

    // Skills Marketplace Tab
    cat_all: 'All',
    cat_coding: 'Coding',
    cat_devops: 'DevOps',
    cat_research: 'Research & Web',
    cat_governance: 'Security & Governance',
    cat_data: 'Data',

    // Preview Tab
    preview_url_placeholder: 'http://localhost:3000 or http://localhost:5173...',
    preview_reload: 'Reload Preview',
    preview_new_tab: 'New In-App Tab',
    preview_tab_close: 'Close tab',
    preview_external_note: 'External secured websites (like Google) send X-Frame-Options headers blocking iframes. Localhost dev apps run 100% unrestricted.',
    preview_quick_ports: 'Quick ports:',

    // Activity, Files, Git, Terminal, Plan
    activity_title: 'Activity Log',
    activity_empty: 'No activities recorded yet',
    activity_events: 'events',
    files_search: 'Filter files...',
    files_modified: 'Modified files',
    files_count: 'files',
    git_clean: 'Working tree clean',
    git_dirty: 'Uncommitted changes',
    git_checkpoint_create: 'Create Safe Checkpoint',
    git_checkpoint_placeholder: 'Checkpoint name (e.g. Before refactor)...',
    git_checkpoint_save: 'Save',
    git_checkpoint_history: 'Checkpoints History',
    git_checkpoint_empty: 'No checkpoints created yet',
    git_checkpoint_revert: 'Restore',
    terminal_title: 'Terminal Output',
    terminal_autoscroll: 'Auto-scroll',
    terminal_empty: 'No active terminal output',
    plan_steps: 'Execution Steps',

    // UI refresh
    header_search: 'Search or run a command…',
    header_settings: 'Settings',
    header_theme_toggle: 'Switch light / dark theme',
    hub_connecting: 'Connecting to Hub',
    hub_lost: 'Hub disconnected',
    sidebar_workspaces: 'Workspaces',
    sidebar_add_workspace: 'Add workspace',
    sidebar_empty_workspaces: 'No workspace yet. Press + to choose a folder on this computer.',
    sidebar_empty_chats: 'No conversations yet. Start a new chat to hand off work.',
    tab_progress: 'Progress',
    tab_changes: 'Changes',
    tab_agents: 'Agents',
    tab_more: 'More',
    inspector_nav: 'Work tools',
    settings_title: 'Settings',
    settings_close: 'Close settings',
    settings_nav: 'Settings sections',
    sec_workspace: 'Project',
    sec_model: 'AI model',
    sec_permissions: 'Permissions & execution',
    sec_agent_channel: 'Agent channel',
    sec_skills: 'Skills',
    sec_code_intel: 'Code intelligence',
    sec_appearance: 'Appearance & language',
    sec_about: 'About & data',
    status_context: 'Context',
    status_no_model: 'No AI configured',
    status_companion_connected: 'Companion connected',
    status_companion_paired: 'Companion paired, waiting for a ChatGPT tab',
    status_companion_missing: 'Companion not paired',
    status_mode: 'Permission mode',
    status_model: 'Model',
    full_access_banner: 'FULL ACCESS is on: the agent can act outside the workspace. Dangerous actions (deleting data, push, merge, release) still ask.',
    full_access_turn_off: 'Back to Review',

    // Settings → Project: the owner's switch for AGENTS.md / CLAUDE.md
    pi_title: 'Project instructions',
    pi_desc: "At the start of each run the Hub reads AGENTS.md and CLAUDE.md from the project root and puts them into the agent's instructions.",
    pi_label: "Load AGENTS.md / CLAUDE.md into the agent's instructions",
    pi_point_untrusted: 'This is untrusted text written by whoever owns the project. The Hub loads at most 8,192 bytes (the rest is cut, and says so), and it cannot raise permissions or skip an approval.',
    pi_point_off: 'Off only means the Hub does not load them itself; the agent can still open these files with its file-reading tool like any other file.',
    pi_point_next: 'A change applies from the next run; a run that is going keeps what it loaded.',
    pi_point_scope: 'Only the Model API channel uses this; the ChatGPT Web channel does not.',
    pi_status_unknown: 'The Hub has not reported the state of this setting.',
    pi_status_default_on: 'On (default).',
    pi_status_config_on: 'On (your choice).',
    pi_status_config_off: 'Off (your choice).',
    pi_status_env_on: "On because of the Hub's environment variable:",
    pi_status_env_off: "Off because of the Hub's environment variable:",
    pi_locked: 'It cannot be changed here. Remove the environment variable and restart the Hub to use your own choice.',
    pi_saved_on: 'Your saved choice: on.',
    pi_saved_off: 'Your saved choice: off.',
    pi_running: 'A task is running: the change applies from the next run.',
    pi_toast_on: 'AGENTS.md / CLAUDE.md will be loaded from the next run.',
    pi_toast_off: 'AGENTS.md / CLAUDE.md will not be loaded from the next run.',
    pi_error: 'Could not save the project instructions setting.',
    mode_readonly: 'Read-only',
    mode_review: 'Review',
    mode_autonomous: 'Autonomous',
    mode_full_access: 'FULL ACCESS',
  },
};

export type TranslationKey = keyof typeof translations.vi | keyof typeof sectionsVi;
/** Values for the {name} placeholders of a string: t('agents_works_on', { folder }). */
export type TranslationParams = Record<string, string | number>;
export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/**
 * Strings that come with a script fetched after the first screen (lib/i18n-agents-sections.ts). The script adds them as it is evaluated, which is
 * before any component of that script renders, so a component finds its words at its first render.
 */
export function addTranslations(vi: Record<string, string>, en: Record<string, string>) {
  Object.assign(translations.vi, vi);
  Object.assign(translations.en, en);
}

/** For a key built at run time (a status, a role) that may not have a string: ask first, fall back to the raw value. */
export const hasTranslation = (key: string): key is TranslationKey => Object.hasOwn(translations.vi, key);

/**
 * A string in the language asked for, else in Vietnamese, else the key itself. {name} is replaced by params.name; a placeholder with no
 * value is left as written, so a missing value is visible instead of turning into "undefined".
 */
export function translate(lang: string, key: string, params?: TranslationParams): string {
  const dict = (translations as Record<string, Record<string, string>>)[lang] || translations.vi;
  const text = dict[key] || (translations.vi as Record<string, string>)[key] || key;
  return params ? text.replace(/\{(\w+)\}/g, (placeholder, name) => (Object.hasOwn(params, name) ? String(params[name]) : placeholder)) : text;
}

export function useTranslation() {
  const lang = useAppStore((state) => state.lang);
  const t: Translate = (key, params) => translate(lang, key, params);
  return { t, lang };
}
