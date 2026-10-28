// Cross-workspace concurrency locking for ChatMCP (Phase 3).
//
// Prevents multiple concurrent tasks or Hub instances from simultaneously modifying
// the same workspace directory. Locks are recorded atomically with process ID, task ID,
// and timestamp, and stale locks from dead processes are automatically detected and reclaimed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';

const LOCK_FILENAME = '.chatmcp-workspace.lock';
const STALE_LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

export class WorkspaceLock {
  /**
   * @param {object} options
   * @param {string} options.workspaceRoot Path to the workspace directory
   * @param {() => number} [options.now] Clock function
   */
  constructor({ workspaceRoot, now = () => Date.now() }) {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      throw error('invalid_workspace', 'Đường dẫn workspace không hợp lệ.', 400);
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.lockPath = path.join(this.workspaceRoot, LOCK_FILENAME);
    this.now = now;
    this.heldLock = null;
  }

  /**
   * Checks whether a PID is currently running on the system.
   * @param {number} pid
   * @returns {boolean}
   */
  static isPidAlive(pid) {
    if (!pid || typeof pid !== 'number' || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM'; // Running but owned by another user
    }
  }

  /**
   * Reads current lock status without acquiring.
   * @returns {Promise<{ locked: boolean, info: object|null }>}
   */
  async inspect() {
    try {
      const data = await readJson(this.lockPath);
      if (!data || typeof data !== 'object') return { locked: false, info: null };
      const isAlive = WorkspaceLock.isPidAlive(data.pid);
      const isExpired = this.now() - (data.acquiredAt || 0) > STALE_LOCK_TIMEOUT_MS;
      if (!isAlive || isExpired) {
        return { locked: false, info: { ...data, stale: true, reason: !isAlive ? 'process_dead' : 'expired' } };
      }
      return { locked: true, info: { ...data, stale: false } };
    } catch {
      return { locked: false, info: null };
    }
  }

  /**
   * Acquires the lock for a given task ID.
   * Throws 409 `workspace_locked` if currently held by an active process.
   * @param {string} taskId
   * @returns {Promise<{ acquired: boolean, lock: object }>}
   */
  async acquire(taskId) {
    if (!taskId) throw error('missing_task_id', 'Cần mã tác vụ để khóa workspace.', 400);
    const { locked, info } = await this.inspect();
    if (locked && info.pid !== process.pid) {
      throw error('workspace_locked', `Workspace đang bị khóa bởi tiến trình PID ${info.pid} (tác vụ ${info.taskId}).`, 409);
    }

    const lockData = {
      pid: process.pid,
      taskId: String(taskId),
      acquiredAt: this.now(),
      workspaceRoot: this.workspaceRoot,
    };

    try {
      await writeJson(this.lockPath, lockData);
      this.heldLock = lockData;
      return { acquired: true, lock: lockData };
    } catch (err) {
      throw error('lock_write_failed', `Không thể ghi file khóa workspace: ${err.message}`, 500);
    }
  }

  /**
   * Releases the lock if held by this process.
   * @returns {Promise<boolean>}
   */
  async release() {
    try {
      const data = await readJson(this.lockPath);
      if (data && data.pid === process.pid) {
        await fs.unlink(this.lockPath);
        this.heldLock = null;
        return true;
      }
      return false;
    } catch {
      this.heldLock = null;
      return false;
    }
  }
}
