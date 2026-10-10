import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One credential/task directory must have one writer even if a second launcher
// is given a different HTTP port. No process discovered here is terminated.
export async function acquireInstanceLock(directory, port) {
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'hub-instance.lock');
  const guard = path.join(directory, 'hub-instance.claim');
  const nonce = randomUUID();
  // Every claimant, including a fresh one, serializes the read/unlink/create
  // sequence. The recovery comparison is not atomic without this guard.
  let claimed = false;
  for (let tries = 0; tries < 50; tries++) {
    try { await fs.mkdir(guard); claimed = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (!claimed) throw new Error('Một launcher đang nhận khóa Hub. Nếu máy vừa tắt đúng lúc khởi động, kiểm tra thư mục hub-instance.claim trong cấu hình trước khi mở lại.');
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(filename, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, port, nonce, startedAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      return async () => {
        try {
          const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (saved.nonce === nonce && saved.pid === process.pid) await fs.unlink(filename);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let original, saved;
      try { original = await fs.readFile(filename, 'utf8'); saved = JSON.parse(original); }
      catch { throw new Error('File khóa Hub chưa hợp lệ. Kiểm tra hub-instance.lock trong thư mục cấu hình trước khi chạy lại.'); }
      if (!Number.isInteger(saved.pid) || saved.pid < 1) throw new Error('File khóa Hub không chứa PID hợp lệ.');
      let alive = true;
      try { process.kill(saved.pid, 0); }
      catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error(`Một Hub đang giữ cấu hình này (PID ${saved.pid}, cổng ${saved.port}). Mở lại Hub đó; không chạy hai phiên với cùng cấu hình.`);
      // Only recover an unchanged lock whose recorded process is already gone.
      if (await fs.readFile(filename, 'utf8') !== original) throw new Error('File khóa Hub vừa thay đổi. Chạy lại launcher.');
      await fs.unlink(filename);
    }
  }
  throw new Error('Chưa lấy được khóa khởi động Hub.');
  } finally { await fs.rmdir(guard); }
}
