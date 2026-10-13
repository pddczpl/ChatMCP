const roles: Record<string, string> = {
  planner: 'Lập kế hoạch',
  researcher: 'Tìm hiểu',
  tester: 'Kiểm thử',
  reviewer: 'Rà soát',
  security: 'Kiểm tra bảo mật',
  summarizer: 'Tổng hợp',
};

const statuses: Record<string, string> = {
  pending: 'Đang chờ', queued: 'Đang chờ', preparing: 'Đang chuẩn bị', planning: 'Đang lập kế hoạch',
  running: 'Đang thực hiện', completed: 'Đã hoàn tất', failed: 'Không hoàn tất',
  cancelled: 'Đã dừng', interrupted: 'Bị gián đoạn', needs_attention: 'Cần bạn kiểm tra',
  ready_for_review: 'Chờ bạn duyệt', awaiting_test_grant: 'Chờ cho phép kiểm thử',
  testing: 'Đang kiểm thử', blocked: 'Chưa thể tiếp tục', skipped: 'Đã bỏ qua',
  no_changes: 'Không có thay đổi', conflict: 'Cần xử lý xung đột',
  partial_failure: 'Một số công việc chưa hoàn tất',
  published: 'Đã tạo yêu cầu duyệt', draft_pr_created: 'Đã tạo yêu cầu duyệt bản nháp', verified: 'Đã xác minh',
};

export const agentRoleLabel = (role: string) => roles[role] || role;
export const agentStatusLabel = (status?: string) => status ? statuses[status] || status : 'Đang chờ';
