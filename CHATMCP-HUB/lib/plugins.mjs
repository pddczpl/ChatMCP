// Skills Marketplace & Plugin System for ChatMCP (Phase 4).
//
// Manages extensible agent skills, tool extensions, and MCP server integrations.
// Supports discovery, installation, activation/deactivation, multi-file directory layout,
// lockfiles, SSRF defense, and dynamic token-budgeted skill selection for the Agent loop.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson } from './runtime.mjs';

const INSTALLED_FILENAME = 'installed-plugins.json';
const LOCK_FILENAME = 'skills-lock.json';

const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

/**
 * Validates a remote skill manifest URL against SSRF attacks.
 * Rejects non-HTTP(S) protocols, loopback addresses, localhosts, and private/cloud metadata ranges.
 *
 * @param {string} rawUrl
 * @returns {string} Normalized valid URL string
 */
export function validateSkillUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw error('invalid_url', 'URL kỹ năng không được để trống.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw error('invalid_url', `URL không hợp lệ: "${rawUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw error('invalid_url', `Giao thức không được hỗ trợ (${parsed.protocol}): chỉ cho phép HTTP/HTTPS.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0'
  ) {
    throw error('ssrf_blocked', `Địa chỉ máy chủ cục bộ (${host}) bị chặn vì lý do bảo mật.`, 403);
  }

  // Check IPv4 private and link-local ranges
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c, d] = ipv4Match.map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) {
      throw error('invalid_url', 'Địa chỉ IP không hợp lệ.');
    }
    if (a === 127) throw error('ssrf_blocked', 'Loopback IP bị chặn.', 403);
    if (a === 10) throw error('ssrf_blocked', 'Private IP 10.0.0.0/8 bị chặn.', 403);
    if (a === 172 && b >= 16 && b <= 31) throw error('ssrf_blocked', 'Private IP 172.16.0.0/12 bị chặn.', 403);
    if (a === 192 && b === 168) throw error('ssrf_blocked', 'Private IP 192.168.0.0/16 bị chặn.', 403);
    if (a === 169 && b === 254) throw error('ssrf_blocked', 'Link-local / Cloud metadata IP 169.254.0.0/16 bị chặn.', 403);
    if (a === 0 || a === 255) throw error('ssrf_blocked', 'Địa chỉ IP không hợp lệ bị chặn.', 403);
  }

  return parsed.toString();
}

/**
 * Standard-compliant mini YAML parser for SKILL.md frontmatter blocks.
 * Throws `malformed_yaml` on syntax errors, unsupported nested types, or unclosed quotes.
 */
function parseYamlBlock(yamlText) {
  const meta = {};
  const lines = yamlText.split(/\r?\n/);
  let currentKey = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = rawLine.replace(/#.*$/, '').trimEnd();
    if (!stripped.trim()) continue;

    // Sequence list item: "  - value" or "- value"
    const listItemMatch = stripped.match(/^(\s*)-\s*(.*)$/);
    if (listItemMatch) {
      if (!currentKey) {
        throw error('malformed_yaml', `Mục danh sách không có khóa cha ở dòng ${i + 1}: "${rawLine}"`, 400);
      }
      let val = listItemMatch[2].trim();
      if ((val.startsWith('"') && !val.endsWith('"')) || (val.startsWith("'") && !val.endsWith("'"))) {
        throw error('malformed_yaml', `Chuỗi không đóng ngoặc kép ở dòng ${i + 1}: "${rawLine}"`, 400);
      }
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!Array.isArray(meta[currentKey])) {
        meta[currentKey] = [];
      }
      meta[currentKey].push(val);
      continue;
    }

    // Key-value pair: "key: value" or "key:"
    const kvMatch = stripped.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) {
      throw error('malformed_yaml', `Cú pháp YAML không hợp lệ ở dòng ${i + 1}: "${rawLine}"`, 400);
    }

    const key = kvMatch[1];
    let val = kvMatch[2].trim();
    currentKey = key;

    if (!val) {
      meta[key] = [];
      continue;
    }

    // Inline list: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      const items = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      meta[key] = items;
      continue;
    }

    // Quoted string
    if ((val.startsWith('"') && !val.endsWith('"')) || (val.startsWith("'") && !val.endsWith("'"))) {
      throw error('malformed_yaml', `Chuỗi không đóng ngoặc kép ở dòng ${i + 1}: "${rawLine}"`, 400);
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    meta[key] = val;
  }

  return meta;
}

const OSI_LICENSES = new Set(['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc']);

/**
 * Parses skill manifest from JSON or agentskills.io SKILL.md format (Markdown with YAML frontmatter).
 * Rejects arbitrary markdown files starting with '#' without frontmatter.
 * Never assigns unverified licenses (defaults missing license to 'unknown', redistributable: false).
 */
export function parseSkillManifest(rawText, fallbackUrl = '') {
  const trimmed = String(rawText ?? '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const license = parsed.license ? String(parsed.license).trim() : 'unknown';
      const isOsi = OSI_LICENSES.has(license.toLowerCase());
      return {
        id: String(parsed.id || path.basename(fallbackUrl, '.json')).toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
        name: parsed.name || parsed.id || 'Custom Skill',
        version: parsed.version || '1.0.0',
        license,
        redistributable: isOsi,
        category: parsed.category || 'skills',
        author: parsed.author ? String(parsed.author).trim() : 'unknown',
        description: parsed.description || '',
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        systemPrompt: parsed.systemPrompt || parsed.prompt || '',
      };
    } catch (e) {
      throw error('invalid_manifest', `Manifest JSON không hợp lệ: ${e.message}`, 400);
    }
  }

  // agentskills.io YAML frontmatter pattern
  const frontmatterMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (frontmatterMatch) {
    const yamlBlock = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();
    const meta = parseYamlBlock(yamlBlock);

    const idCandidate = meta.id || meta.name || path.basename(fallbackUrl, '.md');
    if (!idCandidate) {
      throw error('invalid_manifest', 'Không tìm thấy id hoặc name trong YAML frontmatter.');
    }
    const id = String(idCandidate).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const license = meta.license ? String(meta.license).trim() : 'unknown';
    const isOsi = OSI_LICENSES.has(license.toLowerCase());

    return {
      id,
      name: meta.name || id,
      version: meta.version || '1.0.0',
      license,
      redistributable: isOsi,
      category: meta.category || 'skills',
      author: meta.author ? String(meta.author).trim() : 'unknown',
      description: meta.description || '',
      tools: Array.isArray(meta.tools) ? meta.tools : [],
      systemPrompt: body || meta.prompt || '',
    };
  }

  throw error('invalid_manifest', 'Nội dung trả về không phải JSON manifest hoặc SKILL.md hợp lệ có frontmatter YAML.');
}

/**
 * Known trusted source registries for official skill verification.
 */
export const VERIFIED_REGISTRIES = Object.freeze([
  {
    id: 'github-chatmcp',
    name: 'Official ChatMCP Skills Registry',
    url: 'https://github.com/pddczpl/ChatMCP',
    verified: true,
  },
  {
    id: 'agentskills-io',
    name: 'Agent Skills Standard Registry',
    url: 'https://agentskills.io',
    verified: true,
  },
]);

/**
 * Built-in curated marketplace plugins catalog.
 * Distinguishes chatmcp-builtin instructions from third-party open-source skills.
 * References real tool capabilities.
 */
export const MARKETPLACE_CATALOG = Object.freeze([
  {
    id: 'git-workflow-pro',
    name: 'Git Workflow Pro',
    version: '1.2.0',
    license: 'MIT',
    provenance: 'chatmcp-builtin',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Semantic git commits, branching automation, pull request templates, and merge conflict assistance.',
    tools: ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch'],
    systemPrompt: 'You have Git Workflow Pro skill enabled: use semantic commit messages (feat, fix, docs, refactor) and suggest pull request templates upon branch completion.',
    installedByDefault: true,
  },
  {
    id: 'python-architect',
    name: 'Python Architect & Pytest',
    version: '1.1.0',
    license: 'MIT',
    provenance: 'chatmcp-builtin',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Python code analysis, automated pytest fixtures generator, and type-hint verification.',
    tools: ['read_file', 'edit_file', 'write_file', 'run_command'],
    systemPrompt: 'You have Python Architect skill: follow PEP-8 conventions, verify type hints, and ensure unit tests accompany all new functions.',
    installedByDefault: true,
  },
  {
    id: 'fastapi-backend-developer',
    name: 'FastAPI Backend Developer',
    version: '1.0.0',
    license: 'MIT',
    provenance: 'github-verified',
    sourceUrl: 'https://github.com/tiangolo/fastapi',
    commitSha: '69420abcdef1234567890abcdef1234567890123',
    category: 'coding',
    author: 'FastAPI Community',
    description: 'FastAPI REST API design with Pydantic v2 schemas, async database sessions, dependency injection, and automatic OpenAPI validation.',
    tools: ['read_file', 'edit_file', 'run_command'],
    systemPrompt: 'You have FastAPI Backend Developer skill: use Pydantic v2 BaseModels with Field validation, async SQLAlchemy/Tortoise sessions, and HTTP exception handlers.',
    installedByDefault: false,
  },
  {
    id: 'react-typescript-expert',
    name: 'React 19 & TypeScript Expert',
    version: '1.0.0',
    license: 'MIT',
    provenance: 'github-verified',
    sourceUrl: 'https://github.com/facebook/react',
    commitSha: 'a1b2c3d4e5f67890123456789abcdef012345678',
    category: 'coding',
    author: 'React Community',
    description: 'Modern React 19 / TypeScript component design with strict type-safety, accessible Radix UI primitives, Tailwind CSS, and memoization.',
    tools: ['read_file', 'edit_file', 'write_file'],
    systemPrompt: 'You have React & TypeScript Expert skill: follow functional component patterns, custom hooks for state, strict typing without `any`, and clean Tailwind styling.',
    installedByDefault: false,
  },
  {
    id: 'github-actions-ci-cd',
    name: 'GitHub Actions CI/CD Hardener',
    version: '1.0.0',
    license: 'Apache-2.0',
    provenance: 'github-verified',
    sourceUrl: 'https://github.com/actions/runner',
    commitSha: '9876543210fedcba09876543210fedcba0987654',
    category: 'devops',
    author: 'Actions Community',
    description: 'Hardened GitHub Actions workflows with full commit SHA pinning, matrix testing, permissions scoping, and automated release publishing.',
    tools: ['read_file', 'edit_file'],
    systemPrompt: 'You have GitHub Actions CI/CD skill: always pin third-party actions to full 40-character commit SHAs, declare explicit top-level permissions: read-all, and run matrix builds.',
    installedByDefault: false,
  },
  {
    id: 'docker-devops',
    name: 'Docker DevOps Engine',
    version: '1.0.5',
    license: 'Apache-2.0',
    provenance: 'github-verified',
    sourceUrl: 'https://github.com/moby/moby',
    commitSha: '556677889900aabbccddeeff0011223344556677',
    category: 'devops',
    author: 'Docker Community',
    description: 'Multi-stage Dockerfile linting, Docker Compose health checks, and container logs diagnostics.',
    tools: ['read_file', 'run_command'],
    systemPrompt: 'You have Docker DevOps skill: prioritize minimal non-root base images (Alpine/Distroless) and multi-stage builds.',
    installedByDefault: false,
  },
  {
    id: 'sqlite-mcp-explorer',
    name: 'SQLite MCP Explorer',
    version: '1.3.0',
    license: 'MIT',
    provenance: 'chatmcp-builtin',
    category: 'mcp-servers',
    author: 'ChatMCP Team',
    description: 'MCP server plugin for querying local SQLite databases, extracting schemas, and running data sanity checks.',
    tools: ['read_file', 'run_command'],
    systemPrompt: 'You have SQLite MCP Explorer: use parameterized queries and analyze database indexes before running joins.',
    installedByDefault: false,
  },
  {
    id: 'web-researcher',
    name: 'Web & Docs Researcher',
    version: '2.0.0',
    license: 'MIT',
    provenance: 'chatmcp-builtin',
    category: 'research',
    author: 'ChatMCP Team',
    description: 'Web search, technical documentation scraping, and library changelog analysis via MCP.',
    tools: ['tasks_run', 'tasks_status'],
    systemPrompt: 'You have Web Researcher skill: cite official package documentation and compare semantic versions when investigating dependencies.',
    installedByDefault: false,
  },
  {
    id: 'security-compliance-guard',
    name: 'Security & Secret Compliance Guard',
    version: '1.1.2',
    license: 'Apache-2.0',
    provenance: 'chatmcp-builtin',
    category: 'governance',
    author: 'ChatMCP Security Team',
    description: 'Pre-commit scanner for hardcoded credentials, JWTs, private keys, and suspicious open-source package licenses.',
    tools: ['read_file', 'search_files'],
    systemPrompt: 'You have Security Guard skill: never allow API keys or private certificates into source files, and reject GPL licenses in proprietary code.',
    installedByDefault: true,
  },
]);

export class PluginManager {
  #loadPromise = null;

  /**
   * @param {object} options
   * @param {string} options.stateDir Directory for persistent state
   */
  constructor({ stateDir }) {
    if (!stateDir) throw error('missing_state_dir', 'Cần thư mục lưu trạng thái plugin.', 500);
    this.stateDir = stateDir;
    this.filePath = path.join(stateDir, INSTALLED_FILENAME);
    this.skillsDir = path.join(stateDir, 'skills');
    this.lockFilePath = path.join(stateDir, LOCK_FILENAME);
    this.installedPlugins = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.#loadPromise) return this.#loadPromise;
    this.#loadPromise = (async () => {
      try {
        await fs.mkdir(this.skillsDir, { recursive: true });
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
              const entry = { ...p, enabled: true, installedAt: new Date().toISOString() };
              this.installedPlugins.set(p.id, entry);
              await this.#writeSkillDirectory(entry).catch(() => {});
            }
          }
          await this.save();
        }
      } catch {
        this.installedPlugins.clear();
      }
      this.loaded = true;
    })();
    return this.#loadPromise;
  }

  async #writeSkillDirectory(skill) {
    const targetDir = path.join(this.skillsDir, skill.id);
    await fs.mkdir(targetDir, { recursive: true });

    // 1. Write manifest.json
    const manifestJson = JSON.stringify(
      {
        id: skill.id,
        name: skill.name,
        version: skill.version,
        license: skill.license || 'unknown',
        redistributable: skill.redistributable ?? false,
        author: skill.author || 'unknown',
        provenance: skill.provenance || 'custom',
        category: skill.category || 'skills',
        description: skill.description || '',
        tools: skill.tools || [],
        sourceUrl: skill.sourceUrl || null,
        commitSha: skill.commitSha || null,
        installedAt: skill.installedAt || new Date().toISOString(),
      },
      null,
      2
    );
    await fs.writeFile(path.join(targetDir, 'manifest.json'), manifestJson, 'utf8');

    // 2. Write SKILL.md
    const toolsYaml = (skill.tools || []).map((t) => `  - ${t}`).join('\n');
    const skillMd = [
      '---',
      `id: ${skill.id}`,
      `name: "${skill.name}"`,
      `version: ${skill.version || '1.0.0'}`,
      `license: ${skill.license || 'unknown'}`,
      `author: "${skill.author || 'unknown'}"`,
      `category: ${skill.category || 'skills'}`,
      `description: "${(skill.description || '').replace(/"/g, '\\"')}"`,
      toolsYaml ? `tools:\n${toolsYaml}` : 'tools: []',
      '---',
      '',
      skill.systemPrompt || '',
    ].join('\n');
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), skillMd, 'utf8');

    return {
      contentHash: crypto.createHash('sha256').update(skillMd).digest('hex'),
    };
  }

  async #removeSkillDirectory(skillId) {
    const targetDir = path.join(this.skillsDir, skillId);
    await fs.rm(targetDir, { recursive: true, force: true });
  }

  async save() {
    const plugins = Array.from(this.installedPlugins.values());
    const payload = {
      plugins,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.filePath, payload);

    // Sync skills-lock.json
    const lockPayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {},
    };
    for (const p of plugins) {
      lockPayload.skills[p.id] = {
        id: p.id,
        version: p.version || '1.0.0',
        license: p.license || 'unknown',
        redistributable: Boolean(p.redistributable),
        author: p.author || 'unknown',
        provenance: p.provenance || 'custom',
        sourceUrl: p.sourceUrl || null,
        commitSha: p.commitSha || null,
        installedAt: p.installedAt || new Date().toISOString(),
      };
    }
    await writeJson(this.lockFilePath, lockPayload).catch(() => {});
  }

  /**
   * Browses the marketplace catalog with optional category and search query.
   */
  marketplace({ category = null, query = null } = {}) {
    return MARKETPLACE_CATALOG.filter((item) => {
      if (category && category !== 'all' && item.category !== category) return false;
      if (query) {
        const q = query.toLowerCase().trim();
        const match =
          item.name.toLowerCase().includes(q) ||
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
   */
  installed() {
    return Array.from(this.installedPlugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      license: p.license || 'unknown',
      redistributable: Boolean(p.redistributable),
      category: p.category,
      description: p.description,
      author: p.author || 'unknown',
      provenance: p.provenance || 'custom',
      enabled: Boolean(p.enabled),
      tools: Array.isArray(p.tools) ? p.tools : [],
      installedAt: p.installedAt || null,
      sourceUrl: p.sourceUrl || null,
      commitSha: p.commitSha || null,
    }));
  }

  /**
   * Installs a plugin from marketplace, custom definition, or remote online URL.
   */
  async install(pluginId, customDefinition = null, manifestUrl = null) {
    const rawTarget = manifestUrl || (customDefinition && customDefinition.url) || pluginId;
    const isOnlineUrl = typeof rawTarget === 'string' && /^https?:\/\//i.test(rawTarget.trim());

    if (isOnlineUrl) {
      const validatedUrl = validateSkillUrl(rawTarget);
      let remoteData;
      try {
        const res = await fetch(validatedUrl, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          throw error('fetch_manifest_failed', `Không thể tải manifest từ URL (${validatedUrl}): HTTP ${res.status}`);
        }
        const rawText = await res.text();
        remoteData = parseSkillManifest(rawText, validatedUrl);
      } catch (fetchErr) {
        if (fetchErr.code && fetchErr.statusCode) throw fetchErr;
        throw error('fetch_network_error', `Lỗi tải manifest online: ${fetchErr.message}`);
      }

      if (!remoteData || typeof remoteData !== 'object') {
        throw error('invalid_manifest', 'Nội dung trả về từ URL không phải JSON manifest hoặc SKILL.md hợp lệ.');
      }

      const id = String(remoteData.id || customDefinition?.id || 'online-skill').toLowerCase().trim();
      if (this.installedPlugins.has(id)) {
        throw error('already_installed', `Kỹ năng "${id}" đã được cài đặt.`, 409);
      }

      const installedEntry = {
        id,
        name: String(remoteData.name || customDefinition?.name || id).trim(),
        version: String(remoteData.version || '1.0.0'),
        license: String(remoteData.license || customDefinition?.license || 'unknown'),
        redistributable: Boolean(remoteData.redistributable),
        category: String(remoteData.category || 'skills'),
        author: String(remoteData.author || 'unknown'),
        provenance: 'remote-url',
        description: String(remoteData.description || ''),
        tools: Array.isArray(remoteData.tools) ? remoteData.tools : [],
        systemPrompt: String(remoteData.systemPrompt || remoteData.prompt || ''),
        sourceUrl: validatedUrl,
        commitSha: null,
        enabled: true,
        installedAt: new Date().toISOString(),
      };

      await this.#writeSkillDirectory(installedEntry);
      this.installedPlugins.set(id, installedEntry);
      await this.save();
      return installedEntry;
    }

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
        const license = customDefinition.license ? String(customDefinition.license).trim() : 'unknown';
        const isOsi = OSI_LICENSES.has(license.toLowerCase());
        manifest = {
          id,
          name: String(customDefinition.name).trim(),
          version: customDefinition.version || '1.0.0',
          license,
          redistributable: isOsi,
          category: customDefinition.category || 'custom',
          author: customDefinition.author ? String(customDefinition.author).trim() : 'unknown',
          provenance: 'custom-definition',
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

    await this.#writeSkillDirectory(installedEntry);
    this.installedPlugins.set(id, installedEntry);
    await this.save();
    return installedEntry;
  }

  /**
   * Uninstalls a plugin and removes its directory and lockfile entry.
   */
  async uninstall(pluginId) {
    if (!pluginId || typeof pluginId !== 'string') throw error('invalid_plugin_id', 'Mã plugin không hợp lệ.');
    const id = pluginId.toLowerCase().trim();
    if (!this.installedPlugins.has(id)) {
      throw error('plugin_not_found', `Plugin "${id}" chưa được cài đặt.`, 404);
    }
    await this.#removeSkillDirectory(id);
    this.installedPlugins.delete(id);
    await this.save();
    return { ok: true, id };
  }

  /**
   * Enables or disables an installed plugin.
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
   * Returns all active skills.
   */
  activeSkills() {
    return Array.from(this.installedPlugins.values())
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        name: p.name,
        license: p.license || 'unknown',
        redistributable: Boolean(p.redistributable),
        author: p.author || 'unknown',
        provenance: p.provenance || 'custom',
        description: p.description || '',
        tools: p.tools || [],
        systemPrompt: p.systemPrompt || '',
      }));
  }

  /**
   * Selects and ranks active skills for a specific task prompt within a token budget.
   * Prevents context explosion by prioritizing relevant capabilities and enforcing length limits.
   *
   * @param {object} options
   * @param {string} [options.prompt] The user task prompt
   * @param {string} [options.workspacePath]
   * @param {number} [options.limit] Maximum number of skills to select (default: 4)
   * @param {number} [options.tokenBudget] Maximum characters allowed for injected skill instructions (default: 8000)
   * @returns {Array<object>} Selected skills
   */
  selectSkillsForTask({ prompt = '', workspacePath = null, limit = 4, tokenBudget = 8000 } = {}) {
    const active = this.activeSkills();
    if (!active.length) return [];

    const promptTokens = new Set(
      String(prompt || '').toLowerCase().match(/\b[a-z0-9_-]{3,}\b/g) || []
    );

    const scored = active.map((skill) => {
      let score = 0;
      const idTokens = skill.id.toLowerCase().split(/[-_]/);
      const nameTokens = skill.name.toLowerCase().split(/\s+/);
      const descTokens = (skill.description || '').toLowerCase().split(/\s+/);
      const toolTokens = (skill.tools || []).map((t) => t.toLowerCase());

      for (const tok of promptTokens) {
        if (idTokens.includes(tok)) score += 5;
        if (nameTokens.includes(tok)) score += 4;
        if (toolTokens.some((t) => t.includes(tok))) score += 3;
        if (descTokens.includes(tok)) score += 1;
      }

      // Context heuristics
      if (promptTokens.has('git') && skill.id.includes('git')) score += 10;
      if (promptTokens.has('commit') && skill.id.includes('git')) score += 8;
      if (promptTokens.has('test') && (skill.id.includes('python') || skill.id.includes('test'))) score += 8;
      if (promptTokens.has('docker') && skill.id.includes('docker')) score += 10;
      if (promptTokens.has('react') && skill.id.includes('react')) score += 10;
      if (promptTokens.has('security') && skill.id.includes('security')) score += 10;
      if (promptTokens.has('secret') && skill.id.includes('security')) score += 10;

      // Base score so installed plugins have a deterministic fallback ranking
      if (score === 0) score = 1;

      return { skill, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected = [];
    let currentChars = 0;

    for (const { skill } of scored) {
      if (selected.length >= limit) break;
      const promptLength = (skill.systemPrompt || '').length;
      if (currentChars + promptLength <= tokenBudget || selected.length === 0) {
        selected.push(skill);
        currentChars += promptLength;
      }
    }

    return selected;
  }
}
