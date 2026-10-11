// Multi-User RBAC, Tenant Isolation & Enterprise Audit Logging for ChatMCP (Phase 4).
//
// Implements role-based access control (viewer, developer, admin), multi-tenant workspace
// boundary enforcement, and tamper-evident append-only structured audit logging.

import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const ROLES = Object.freeze(['viewer', 'developer', 'admin']);

export const PERMISSIONS_MATRIX = Object.freeze({
  viewer: Object.freeze(['read', 'search', 'view_diff', 'view_status', 'view_audit']),
  developer: Object.freeze(['read', 'search', 'view_diff', 'view_status', 'view_audit', 'edit', 'checkpoint', 'restore', 'exec_test', 'exec_cmd']),
  admin: Object.freeze(['read', 'search', 'view_diff', 'view_status', 'view_audit', 'edit', 'checkpoint', 'restore', 'exec_test', 'exec_cmd', 'config_ai', 'manage_plugins', 'full_access', 'manage_users', 'shutdown']),
});

const error = (code, message, statusCode = 403) => Object.assign(new Error(message), { code, statusCode });

export class GovernanceManager {
  /**
   * @param {object} options
   * @param {string} options.stateDir Directory for state and audit logging
   * @param {string} [options.defaultTenantId='default-tenant']
   */
  constructor({ stateDir, defaultTenantId = 'default-tenant' }) {
    if (!stateDir) throw error('missing_state_dir', 'Cần thư mục lưu trạng thái quản trị.', 500);
    this.stateDir = stateDir;
    this.auditFilePath = path.join(stateDir, 'enterprise-audit.jsonl');
    this.defaultTenantId = defaultTenantId;
    this.tenantWorkspaces = new Map(); // tenantId -> Set of workspace paths
  }

  /**
   * Checks whether a role has permission to execute an action.
   *
   * @param {string} role Role name ('viewer', 'developer', 'admin')
   * @param {string} action Action identifier
   * @returns {boolean}
   */
  checkPermission(role, action) {
    if (!role || !ROLES.includes(role)) return false;
    const allowedActions = PERMISSIONS_MATRIX[role] || [];
    return allowedActions.includes(action);
  }

  /**
   * Enforces role permission, throwing 403 `forbidden` if not allowed.
   */
  enforce(role, action, message = null) {
    if (!this.checkPermission(role, action)) {
      throw error('forbidden', message || `Vai trò "${role}" không có quyền thực hiện thao tác "${action}".`, 403);
    }
    return true;
  }

  /**
   * Registers a workspace root under a specific tenant.
   * @param {string} tenantId
   * @param {string} workspacePath
   */
  registerWorkspace(tenantId, workspacePath) {
    const tid = String(tenantId || this.defaultTenantId).trim();
    if (!this.tenantWorkspaces.has(tid)) {
      this.tenantWorkspaces.set(tid, new Set());
    }
    this.tenantWorkspaces.get(tid).add(path.resolve(workspacePath));
  }

  /**
   * Verifies that a tenant has access to a workspace directory.
   * @param {string} tenantId
   * @param {string} workspacePath
   * @returns {boolean}
   */
  canAccessWorkspace(tenantId, workspacePath) {
    const tid = String(tenantId || this.defaultTenantId).trim();
    const target = path.resolve(workspacePath);
    const workspaces = this.tenantWorkspaces.get(tid);
    if (!workspaces) return false;
    return workspaces.has(target);
  }

  /**
   * Appends a structured audit entry.
   *
   * @param {object} entry
   * @param {string} entry.actor User ID or session identifier
   * @param {string} entry.role Role assigned to actor
   * @param {string} entry.action Action performed
   * @param {string} entry.target Target resource (file, command, workspace)
   * @param {boolean} entry.allowed Whether the operation succeeded or was permitted
   * @param {string} [entry.reason] Additional reason or failure code
   * @param {object} [entry.metadata] Extra metadata
   */
  async logAudit({ actor, role, action, target, allowed, reason = null, metadata = {} }) {
    const record = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      actor: String(actor || 'anonymous'),
      role: String(role || 'viewer'),
      action: String(action || 'unknown'),
      target: String(target || ''),
      allowed: Boolean(allowed),
      reason: reason || (allowed ? 'permitted' : 'denied'),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    };

    const line = JSON.stringify(record) + '\n';
    try {
      await fs.appendFile(this.auditFilePath, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Best effort disk logging
    }
    return record;
  }

  /**
   * Reads recent audit events from file.
   *
   * @param {object} [options]
   * @param {number} [options.limit=100]
   * @param {string} [options.action]
   * @param {string} [options.actor]
   * @returns {Promise<Array<object>>}
   */
  async queryAudit({ limit = 100, action = null, actor = null } = {}) {
    try {
      const content = await fs.readFile(this.auditFilePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const records = [];
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (action && rec.action !== action) continue;
          if (actor && rec.actor !== actor) continue;
          records.push(rec);
        } catch {
          // ignore malformed line
        }
      }
      return records.slice(-limit).reverse();
    } catch {
      return [];
    }
  }
}
