// Where a saved API key lives. A key is never written in plain text.
//
//   Windows        Windows DPAPI through windows/Protect-ApiKey.ps1. Only the same Windows account on the same machine
//                  can read it back.
//   Linux / macOS  AES-256-GCM. The key comes from CHATMCP_MASTER_KEY (a secret you supply; strongest option) or, when
//                  that is not set, from a random master.key file in the Hub's data directory (mode 0600). The second
//                  protects against the key leaking through a backup, a log or a screenshot, NOT against someone who
//                  can already read the data directory as the same user. Set CHATMCP_MASTER_KEY, or do not save the
//                  key and pass it through an environment variable, if that matters for your machine.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const AAD = Buffer.from('chatmcp-secret-v1');
const b64 = (buffer) => buffer.toString('base64url');

async function dpapi(mode, text, bundleRoot) {
  if (process.platform !== 'win32') throw fail('dpapi_unavailable', 'Chỉ Windows hỗ trợ lưu API key bằng DPAPI.');
  const binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(bundleRoot, 'windows', 'Protect-ApiKey.ps1');
  return await new Promise((resolve, reject) => {
    const proc = spawn(binary, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let chunks = '', size = 0, settled = false;
    const done = (error, result) => { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(result); };
    const timeout = setTimeout(() => { proc.kill(); done(fail('dpapi_timeout', 'Windows chưa thể bảo vệ API key.')); }, 30000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s) => { size += Buffer.byteLength(s); if (size > 1024 * 1024) { proc.kill(); done(fail('dpapi_overflow', 'Credential quá dài.')); } else chunks += s; });
    proc.stderr.resume(); proc.stdin.on('error', () => {});
    proc.once('error', () => done(fail('dpapi_failed', 'Không gọi được Windows DPAPI.')));
    proc.once('close', (code) => done(code === 0 && chunks.trim() ? null : fail('dpapi_failed', 'Không thể lưu/đọc API key dưới tài khoản Windows hiện tại.'), chunks.trim()));
    proc.stdin.end(text, 'utf8');
  });
}

async function masterKeyFile(file) {
  try {
    const hex = (await fs.readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    throw fail('secret_master_invalid', `File ${path.basename(file)} không hợp lệ. Xóa nó (và nhập lại API key) hoặc khôi phục từ bản sao.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Create the file complete or not at all: write it privately under a temporary name, then link it into place. A second
  // writer (another Hub starting at the same moment) either wins the link or finds the finished file.
  const key = randomBytes(32);
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${key.toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fs.link(temp, file);
    return key;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return await masterKeyFile(file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

/**
 * @param {{platform?: string, bundleRoot: string, directory: string, env?: object}} options
 * @returns {{kind: 'windows-dpapi'|'aes-gcm', protect: (text: string) => Promise<string>, unprotect: (blob: string) => Promise<string>, describe: () => object}}
 */
export function createProtector({ platform = process.platform, bundleRoot, directory, env = process.env }) {
  if (platform === 'win32') {
    return {
      kind: 'windows-dpapi',
      protect: (text) => dpapi('Protect', text, bundleRoot),
      unprotect: (blob) => dpapi('Unprotect', blob, bundleRoot),
      describe: () => ({ kind: 'windows-dpapi', persistent: true, protection: 'Windows DPAPI (chỉ tài khoản Windows này đọc lại được)' }),
    };
  }
  const envSecret = typeof env.CHATMCP_MASTER_KEY === 'string' && env.CHATMCP_MASTER_KEY.length >= 16 ? env.CHATMCP_MASTER_KEY : null;
  const keyFile = path.join(directory, 'master.key');
  return {
    kind: 'aes-gcm',
    async protect(text) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const source = envSecret ? 'env' : 'file';
      const key = envSecret ? await scryptAsync(envSecret, salt, 32) : await masterKeyFile(keyFile);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return `v1.${source}.${b64(Buffer.concat([salt, iv, cipher.getAuthTag(), body]))}`;
    },
    async unprotect(blob) {
      const match = /^v1\.(env|file)\.([A-Za-z0-9_-]+)$/.exec(String(blob));
      if (!match) throw fail('secret_unreadable', 'API key đã lưu không đọc được trên hệ điều hành này (lưu bằng cách bảo vệ khác).');
      if (match[1] === 'env' && !envSecret) throw fail('secret_master_missing', 'API key được lưu với CHATMCP_MASTER_KEY, nhưng biến môi trường này chưa được đặt.');
      const raw = Buffer.from(match[2], 'base64url');
      if (raw.length < 16 + 12 + 16 + 1) throw fail('secret_unreadable', 'API key đã lưu bị hỏng.');
      const salt = raw.subarray(0, 16), iv = raw.subarray(16, 28), tag = raw.subarray(28, 44), body = raw.subarray(44);
      const key = match[1] === 'env' ? await scryptAsync(envSecret, salt, 32) : await masterKeyFile(keyFile);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        throw fail('secret_unreadable', 'Không giải mã được API key đã lưu (khóa chính đã đổi hoặc dữ liệu bị sửa).');
      }
    },
    describe: () => ({
      kind: 'aes-gcm',
      persistent: true,
      protection: envSecret ? 'AES-256-GCM, khóa từ biến môi trường CHATMCP_MASTER_KEY' : 'AES-256-GCM, khóa trong master.key (quyền 0600) cạnh dữ liệu Hub; đặt CHATMCP_MASTER_KEY để khóa nằm ngoài ổ đĩa',
    }),
  };
}
