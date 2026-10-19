import { LockKeyhole } from 'lucide-react';

/**
 * Shown instead of the app when this tab has no valid Hub session: it was opened without going through ChatMCP (no sign-in
 * ticket), or the Hub restarted since (every launch has a new secret). Reloading cannot fix either, so it says what can.
 */
export function SessionRequired() {
  return (
    <main
      role="alert"
      aria-labelledby="session-required-title"
      className="flex h-screen items-center justify-center bg-[var(--bg)] p-6 text-[var(--text)]"
    >
      <div className="max-w-lg rounded-xl border border-[var(--line)] bg-[var(--panel)] p-8 shadow-[var(--shadow-3d)]">
        <div className="mb-4 flex items-center gap-3">
          <LockKeyhole aria-hidden="true" className="h-6 w-6 text-[var(--primary)]" />
          <h1 id="session-required-title" className="text-lg font-semibold">Cần mở lại ChatMCP · Session required</h1>
        </div>
        <p className="mb-3 text-sm text-[var(--muted)]">
          Trang này chưa có phiên Hub hợp lệ hoặc Hub đã khởi động lại. Hãy mở ChatMCP Studio từ ứng dụng desktop hoặc
          START-CHATMCP-HUB.cmd; việc tải lại trang không khắc phục được.
        </p>
        <p className="text-sm text-[var(--muted)]">
          This tab has no valid Hub session, or the Hub restarted. Reopen ChatMCP Studio from the desktop app or
          START-CHATMCP-HUB.cmd; reloading this page will not help.
        </p>
      </div>
    </main>
  );
}
