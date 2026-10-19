import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAppStore } from '@/store/useAppStore';
import { agentRoleLabel, agentStatusLabel } from './agentLabels';

const suggestions = [
  { label: 'Tìm hiểu dự án', goal: 'Tìm hiểu cấu trúc dự án, các chức năng chính và những tệp tôi nên đọc trước.' },
  { label: 'Rà soát vấn đề', goal: 'Rà soát mã nguồn để tìm những vấn đề đáng chú ý và đề xuất thứ tự xử lý, kèm bằng chứng.' },
  { label: 'Lập kế hoạch', goal: 'Đánh giá tình trạng dự án và đề xuất kế hoạch cải thiện theo mức độ ưu tiên.' },
];

export function DynamicSubagents() {
  const { showToast } = useAppStore();
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data, refetch, error } = useQuery({
    queryKey: ['dynamic-delegates'], queryFn: api.getDynamicDelegates,
    refetchInterval: 3000,
  });
  const active = Boolean(data?.activeRunId);
  const last = data?.last;
  const startAnalysis = async () => {
    if (active || busy || !goal.trim()) return;
    setConfirmOpen(false);
    setBusy(true);
    try {
      const value = await api.runDynamicDelegates(goal);
      await refetch();
      showToast(agentStatusLabel(value.status), value.status === 'completed' ? 'success' : 'warning');
    } catch (e: any) { showToast(e?.message || 'Chưa thể bắt đầu phân tích. Hãy kiểm tra cấu hình AI.', 'error'); }
    finally { setBusy(false); }
  };

  return <section aria-labelledby="agent-goal-heading" className="space-y-4">
    <div className="space-y-1.5">
      <h3 id="agent-goal-heading" className="font-semibold text-base">Bạn muốn tìm hiểu điều gì?</h3>
      <p className="text-muted leading-relaxed">Mô tả mục tiêu, AI sẽ chia việc cho các trợ lý và trả kết quả để bạn xem.</p>
    </div>
    <div className="space-y-2">
      <label htmlFor="agent-goal" className="block font-medium">Yêu cầu của bạn</label>
      <textarea id="agent-goal" rows={4} maxLength={2000}
        aria-describedby="agent-goal-help"
        placeholder="Ví dụ: Tìm nguyên nhân trang tải chậm và đề xuất cách cải thiện."
        className="w-full min-w-0 resize-y p-3 rounded-lg border border-line bg-surface leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        value={goal} onChange={e => setGoal(e.target.value)} disabled={active || busy} />
      <div className="flex flex-wrap gap-2" aria-label="Gợi ý yêu cầu">
        {suggestions.map(suggestion => <Button key={suggestion.label} size="sm" variant="outline"
          disabled={active || busy} onClick={() => setGoal(suggestion.goal)}>{suggestion.label}</Button>)}
      </div>
      <p id="agent-goal-help" className="text-xs leading-relaxed text-muted">Chỉ đọc và phân tích, không sửa tệp hay chạy lệnh. Sử dụng model đã cấu hình; phí sử dụng do nhà cung cấp AI tính.</p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="lg" disabled={active || busy || !goal.trim()} onClick={() => setConfirmOpen(true)}>{active || busy ? 'Đang phân tích…' : 'Bắt đầu phân tích'}</Button>
      {(active || busy) && <Button size="md" variant="danger" onClick={async () => {
        try { await api.cancelDynamicDelegates(); await refetch(); showToast('Đã yêu cầu dừng phân tích', 'info'); }
        catch (e: any) { showToast(e?.message || 'Chưa thể dừng phân tích', 'error'); }
      }}>Dừng phân tích</Button>}
    </div>
    <Modal open={confirmOpen} onOpenChange={setConfirmOpen} role="alertdialog" title="Cho phép AI phân tích dự án?"
      description="Các trợ lý sẽ đọc các phần liên quan của dự án và gửi yêu cầu tới nhà cung cấp AI đã cấu hình. Không sửa tệp, chạy lệnh hay đưa mã lên GitHub. Phí sử dụng do nhà cung cấp AI tính.">
          <p className="mt-3 rounded-lg bg-surface p-3 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{goal}</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="outline" autoFocus onClick={() => setConfirmOpen(false)}>Để sau</Button>
            <Button variant="primary" disabled={active || busy || !goal.trim()} onClick={startAnalysis}>Cho phép và bắt đầu</Button>
          </div>
    </Modal>
    {(active || busy) && <p role="status" className="text-muted">Các trợ lý đang làm việc. Kết quả sẽ xuất hiện bên dưới.</p>}
    {error && <p role="alert" className="text-danger">Không tải được trạng thái: {error.message}</p>}
    {last && <div className="space-y-3 border-t border-line pt-4 select-text">
      <div>
        <h4 className="font-semibold">Kết quả phân tích</h4>
        <p className="text-xs text-muted mt-1">{agentStatusLabel(last.status)} · {(last.workers || []).length} trợ lý</p>
      </div>
      {(last.workers || []).map((worker: any) => <details key={worker.id} className="rounded-lg border border-line p-3" open={worker.status === 'failed'}>
        <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
          {agentRoleLabel(worker.role)} <span className="font-normal text-muted">· {agentStatusLabel(worker.status)}</span>
        </summary>
        <p className="mt-3 whitespace-pre-wrap break-words leading-relaxed">{worker.summary || worker.error || 'Chưa có kết quả.'}</p>
      </details>)}
      {last.conclusion && <p className="whitespace-pre-wrap leading-relaxed">{last.conclusion}</p>}
      {last.error && <p role="alert" className="text-danger break-words">{last.error}</p>}
    </div>}
  </section>;
}
