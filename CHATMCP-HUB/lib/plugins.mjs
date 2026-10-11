// Skills Marketplace & Plugin System for ChatMCP (Phase 4).
//
// Manages extensible agent skills, tool extensions, and MCP server integrations.
// Supports discovery, installation, activation/deactivation, and dynamic skill injection into the Agent loop.

import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';

const INSTALLED_FILENAME = 'installed-plugins.json';

const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

/**
 * Built-in curated marketplace plugins catalog.
 */
export const MARKETPLACE_CATALOG = Object.freeze([
  {
    id: 'git-workflow-pro',
    name: 'Git Workflow Pro',
    version: '1.2.0',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Semantic git commits, branching automation, pull request templates, and merge conflict assistance.',
    tools: ['git_smart_commit', 'git_branch_clean', 'git_pr_template'],
    systemPrompt: 'You have Git Workflow Pro skill enabled: use semantic commit messages (feat, fix, docs, refactor) and suggest pull request templates upon branch completion.',
    installedByDefault: true,
  },
  {
    id: 'python-architect',
    name: 'Python Architect & Pytest',
    version: '1.1.0',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'AST-based Python code analysis, automated pytest fixtures generator, and type-hint verification.',
    tools: ['python_ast_inspect', 'pytest_scaffold', 'type_check'],
    systemPrompt: 'You have Python Architect skill: follow PEP-8 conventions, verify type hints, and ensure unit tests accompany all new functions.',
    installedByDefault: true,
  },
  {
    id: 'docker-devops',
    name: 'Docker DevOps Engine',
    version: '1.0.5',
    category: 'devops',
    author: 'Community',
    description: 'Multi-stage Dockerfile linting, Docker Compose health checks, and container logs diagnostics.',
    tools: ['docker_lint', 'compose_inspect'],
    systemPrompt: 'You have Docker DevOps skill: prioritize minimal non-root base images (Alpine/Distroless) and multi-stage builds.',
    installedByDefault: false,
  },
  {
    id: 'sqlite-mcp-explorer',
    name: 'SQLite MCP Explorer',
    version: '1.3.0',
    category: 'mcp-servers',
    author: 'MCP Community',
    description: 'MCP server plugin for querying local SQLite databases, extracting schemas, and running data sanity checks.',
    tools: ['sqlite_query', 'sqlite_schema', 'sqlite_tables'],
    systemPrompt: 'You have SQLite MCP Explorer: use parameterized queries and analyze database indexes before running joins.',
    installedByDefault: false,
  },
  {
    id: 'web-researcher',
    name: 'Web & Docs Researcher',
    version: '2.0.0',
    category: 'research',
    author: 'ChatMCP Team',
    description: 'Web search, technical documentation scraping, and library changelog analysis via MCP.',
    tools: ['web_search', 'fetch_docs'],
    systemPrompt: 'You have Web Researcher skill: cite official package documentation and compare semantic versions when investigating dependencies.',
    installedByDefault: false,
  },
  {
    id: 'security-compliance-guard',
    name: 'Security & Secret Compliance Guard',
    version: '1.1.2',
    category: 'governance',
    author: 'Security SIG',
    description: 'Pre-commit scanner for hardcoded credentials, JWTs, private keys, and suspicious open-source package licenses.',
    tools: ['scan_secrets', 'check_licenses'],
    systemPrompt: 'You have Security Guard skill: never allow API keys or private certificates into source files, and reject GPL licenses in proprietary code.',
    installedByDefault: true,
  },
]);

export class PluginManager {
  /**
   * @param {object} options
   * @param {string} options.stateDir Directory for persistent state
   */
  constructor({ stateDir }) {
    if (!stateDir) throw error('missing_state_dir', 'Cần thư mục lưu trạng thái plugin.', 500);
    this.filePath = path.join(stateDir, INSTALLED_FILENAME);
    this.installedPlugins = new Map();
    this.loaded = false;
  }

  async load() {
    try {
      const data = await readJson(this.filePath);
      if (data && Array.isArray(data.plugins)) {
        this.installedPlugins.clear();
        for (const p of data.plugins) {
          if (p && p.id) this.installedPlugins.set(p.id, p);
        }
      } else {
        // First boot: install default plugins
        this.installedPlugins.clear();
        for (const p of MARKETPLACE_CATALOG) {
          if (p.installedByDefault) {
            this.installedPlugins.set(p.id, { ...p, enabled: true, installedAt: new Date().toISOString() });
          }
        }
        await this.save();
      }
    } catch {
      this.installedPlugins.clear();
    }
    this.loaded = true;
  }

  async save() {
    const payload = {
      plugins: Array.from(this.installedPlugins.values()),
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.filePath, payload);
  }

  /**
   * Browses the marketplace catalog with optional category and search query.
   *
   * @param {object} [options]
   * @param {string} [options.category]
   * @param {string} [options.query]
   * @returns {Array<object>}
   */
  marketplace({ category = null, query = null } = {}) {
    return MARKETPLACE_CATALOG.filter((item) => {
      if (category && category !== 'all' && item.category !== category) return false;
      if (query) {
        const q = query.toLowerCase().trim();
        const match = item.name.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q);
        if (!match) return false;
      }
      return true;
    }).map((item) => ({
      ...item,
      isInstalled: this.installedPlugins.has(item.id),
      isEnabled: this.installedPlugins.get(item.id)?.enabled ?? false,
    }));
  }

  /**
   * Lists all installed plugins.
   * @returns {Array<object>}
   */
  installed() {
    return Array.from(this.installedPlugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      category: p.category,
      description: p.description,
      author: p.author || 'Custom',
      enabled: Boolean(p.enabled),
      tools: Array.isArray(p.tools) ? p.tools : [],
      installedAt: p.installedAt || null,
    }));
  }

  /**
   * Installs a plugin from marketplace or custom definition.
   * @param {string} pluginId
   * @param {object} [customDefinition]
   */
  async install(pluginId, customDefinition = null) {
    if (!pluginId || typeof pluginId !== 'string') {
      throw error('invalid_plugin_id', 'Mã plugin không hợp lệ.');
    }
    const id = pluginId.toLowerCase().trim();
    if (this.installedPlugins.has(id)) {
      throw error('already_installed', `Plugin "${id}" đã được cài đặt.`, 409);
    }

    let manifest = MARKETPLACE_CATALOG.find((x) => x.id === id);
    if (!manifest) {
      if (customDefinition && typeof customDefinition === 'object' && customDefinition.name) {
        manifest = {
          id,
          name: String(customDefinition.name).trim(),
          version: customDefinition.version || '1.0.0',
          category: customDefinition.category || 'custom',
          description: customDefinition.description || '',
          tools: Array.isArray(customDefinition.tools) ? customDefinition.tools : [],
          systemPrompt: customDefinition.systemPrompt || '',
        };
      } else {
        throw error('plugin_not_found', `Không tìm thấy plugin "${id}" trong Marketplace.`, 404);
      }
    }

    const installedEntry = {
      ...manifest,
      enabled: true,
      installedAt: new Date().toISOString(),
    };

    this.installedPlugins.set(id, installedEntry);
    await this.save();
    return installedEntry;
  }

  /**
   * Uninstalls a plugin.
   * @param {string} pluginId
   */
  async uninstall(pluginId) {
    if (!pluginId || typeof pluginId !== 'string') throw error('invalid_plugin_id', 'Mã plugin không hợp lệ.');
    const id = pluginId.toLowerCase().trim();
    if (!this.installedPlugins.has(id)) {
      throw error('plugin_not_found', `Plugin "${id}" chưa được cài đặt.`, 404);
    }
    this.installedPlugins.delete(id);
    await this.save();
    return { ok: true, id };
  }

  /**
   * Enables or disables an installed plugin.
   * @param {string} pluginId
   * @param {boolean} enabled
   */
  async toggle(pluginId, enabled) {
    if (!pluginId || typeof pluginId !== 'string') throw error('invalid_plugin_id', 'Mã plugin không hợp lệ.');
    const id = pluginId.toLowerCase().trim();
    const plugin = this.installedPlugins.get(id);
    if (!plugin) {
      throw error('plugin_not_found', `Plugin "${id}" chưa được cài đặt.`, 404);
    }
    plugin.enabled = Boolean(enabled);
    this.installedPlugins.set(id, plugin);
    await this.save();
    return { ok: true, id, enabled: plugin.enabled };
  }

  /**
   * Returns all active skills, instructions, and tools to inject into the Agent context.
   * @returns {Array<{ id: string, name: string, tools: string[], systemPrompt: string }>}
   */
  activeSkills() {
    return Array.from(this.installedPlugins.values())
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        name: p.name,
        tools: p.tools || [],
        systemPrompt: p.systemPrompt || '',
      }));
  }
}
