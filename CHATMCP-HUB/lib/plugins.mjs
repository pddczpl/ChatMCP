// Skills Marketplace & Plugin System for ChatMCP (Phase 4 Hardening).
//
// Manages extensible agent skills, tool extensions, and MCP server integrations.
// Supports discovery, atomic installation, activation/deactivation, multi-file directory layout,
// lockfiles, strict SSRF defense (DNS resolution, redirect validation, IP checking),
// and dynamic token-budgeted skill selection for the Agent loop.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readJson, writeJson } from './runtime.mjs';
import { fetchPinnedSkillResponse } from './skill-http.mjs';
import { isUnsafeWindowsName } from './fs-safe.mjs';

const INSTALLED_FILENAME = 'installed-plugins.json';
const LOCK_FILENAME = 'skills-lock.json';

const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

/**
 * Validates and normalizes a skill ID slug.
 * Rejects path separators, traversal, absolute paths, and Windows reserved device names.
 *
 * @param {string} rawId
 * @returns {string} Normalized safe ID
 */
export function normalizeSkillId(rawId) {
  if (typeof rawId !== 'string') {
    throw error('invalid_skill_id', 'Mã kỹ năng phải là chuỗi ký tự.', 400);
  }
  const id = rawId.trim().toLowerCase();
  if (!id || id.length > 64) {
    throw error('invalid_skill_id', 'Mã kỹ năng phải có độ dài từ 1 đến 64 ký tự.', 400);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..') || path.isAbsolute(id)) {
    throw error('invalid_skill_id', 'Mã kỹ năng không được chứa ký tự phân cách thư mục hoặc duyệt đường dẫn.', 400);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw error('invalid_skill_id', 'Mã kỹ năng chỉ được gồm chữ thường (a-z), chữ số (0-9), gạch nối (-) và gạch dưới (_), bắt đầu bằng chữ hoặc số.', 400);
  }
  if (isUnsafeWindowsName(id)) {
    throw error('invalid_skill_id', `Mã kỹ năng trùng tên thiết bị hệ thống Windows: "${id}".`, 400);
  }
  return id;
}

/**
 * Returns true if an IP address (IPv4 or IPv6) is private, loopback, link-local, carrier-grade NAT, or reserved.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateOrReservedIp(ip) {
  if (typeof ip !== 'string') return true;
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b, c, d] = parts;
    // 0.0.0.0/8 (current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (private)
    if (a === 10) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local & AWS metadata)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (private: 172.16.x.x - 172.31.x.x)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.0.0.0/24 (IETF assignments), 192.0.2.0/24 (TEST-NET-1), 192.88.99.0/24 (6to4)
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true;
    // 198.18.0.0/15 (benchmarking: 198.18.x.x - 198.19.x.x)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true;
    // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved)
    if (a >= 224) return true;
    // 255.255.255.255 (broadcast)
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    // ::1 loopback
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
    // :: unspecified
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
    // IPv4-mapped IPv6 (::ffff:192.168.1.1)
    if (lower.startsWith('::ffff:') || lower.startsWith('0:0:0:0:0:ffff:')) {
      const match = lower.match(/(?:::ffff:|ffff:)(\d+\.\d+\.\d+\.\d+)$/);
      if (match) return isPrivateOrReservedIp(match[1]);
      return true;
    }
    // Unique local (fc00::/7 -> fc.. or fd..)
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
    // Link-local (fe80::/10 -> fe8.., fe9.., fea.., feb..)
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
    // Multicast (ff00::/8)
    if (lower.startsWith('ff')) return true;
    // Documentation (2001:db8::/32)
    if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return true;
    return false;
  }
  return true;
}

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
  if (parsed.username || parsed.password) throw error('invalid_url', 'Remote skill URL must not contain credentials.', 400);
  const host = parsed.hostname.toLowerCase();
  const literalHost = host.replace(/^\[|\]$/g, '');
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

  // Check IP literal directly
  if (net.isIP(literalHost) && isPrivateOrReservedIp(literalHost)) {
    throw error('ssrf_blocked', `Địa chỉ IP (${host}) thuộc dải mạng nội bộ hoặc không an toàn.`, 403);
  }

  return parsed.toString();
}

/**
 * Resolves a hostname via DNS and enforces that all destination IP addresses are strictly public.
 * Protects against DNS rebinding and internal network scanning.
 *
 * @param {string} rawUrl
 * @returns {Promise<{ url: string, ip: string, parsed: URL }>}
 */
export async function resolvePublicUrl(rawUrl) {
  const validated = validateSkillUrl(rawUrl);
  const parsed = new URL(validated);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw error('ssrf_blocked', `Địa chỉ IP đích (${hostname}) bị chặn.`, 403);
    }
    return { url: validated, ip: hostname, parsed };
  }

  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (dnsErr) {
    throw error('dns_resolution_failed', `Không thể phân giải tên miền "${hostname}": ${dnsErr.message}`, 400);
  }

  if (!addresses || addresses.length === 0) {
    throw error('dns_resolution_failed', `Không tìm thấy địa chỉ IP cho "${hostname}".`, 400);
  }

  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr.address)) {
      throw error('ssrf_blocked', `Tên miền "${hostname}" phân giải về địa chỉ IP nội bộ (${addr.address}) bị chặn.`, 403);
    }
  }

  return { url: validated, ip: addresses[0].address, parsed };
}

/**
 * Safely fetches a remote skill manifest with DNS pre-resolution, public IP enforcement,
 * manual redirect validation (no unvalidated redirect hops), strict timeouts, and size limits.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {number} [options.maxRedirects]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {Function} [options.fetchFn]
 * @param {Function} [options.dnsResolver]
 * @returns {Promise<{ text: string, finalUrl: string }>}
 */
export async function safeFetchSkillManifest(rawUrl, {
  maxRedirects = 3,
  timeoutMs = 8000,
  maxBytes = 512 * 1024,
  fetchFn = null,
  dnsResolver = resolvePublicUrl,
} = {}) {
  let currentUrl = rawUrl;
  let hops = 0;

  while (hops <= maxRedirects) {
    const resolved = await dnsResolver(currentUrl);
    const validatedUrl = typeof resolved === 'string' ? resolved : resolved.url;
    if (resolved?.ip && isPrivateOrReservedIp(resolved.ip)) {
      throw error('ssrf_blocked', `Địa chỉ IP phân giải (${resolved.ip}) bị chặn vì thuộc mạng nội bộ hoặc không an toàn.`, 403);
    }

    let res;
    try {
      res = fetchFn
        ? await fetchFn(validatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
        : await fetchPinnedSkillResponse(validatedUrl, { ip: resolved.ip, timeoutMs, maxBytes });
    } catch (fetchErr) {
      if (fetchErr.code && fetchErr.statusCode) throw fetchErr;
      throw error('fetch_network_error', `Lỗi tải manifest: ${fetchErr.message}`, 400);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      hops += 1;
      if (hops > maxRedirects) {
        throw error('too_many_redirects', 'Vượt quá số lượt chuyển hướng cho phép (tối đa 3).', 400);
      }
      const location = res.headers.get('location');
      if (!location) {
        throw error('fetch_manifest_failed', `HTTP ${res.status} chuyển hướng không có Location header.`, 400);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw error('fetch_manifest_failed', `Không thể tải manifest từ URL (${validatedUrl}): HTTP ${res.status}`, res.status);
    }

    const contentLength = Number(res.headers.get('content-length'));
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      throw error('response_too_large', `Kích thước manifest (${contentLength} B) vượt quá giới hạn cho phép (${maxBytes} B).`, 400);
    }

    // The production transport caps raw bytes as they arrive. For injected test
    // fetchers, also read Web streams incrementally when available.
    let text;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let count = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const part = Buffer.from(value);
          count += part.length;
          if (count > maxBytes) throw error('response_too_large', 'Manifest stream exceeds the download limit.', 413);
          chunks.push(part);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      text = Buffer.concat(chunks, count).toString('utf8');
    } else {
      text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw error('response_too_large', 'Manifest exceeds the download limit.', 413);
    }

    return { text, finalUrl: validatedUrl };
  }

  throw error('too_many_redirects', 'Vượt quá số lượt chuyển hướng cho phép.', 400);
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

/**
 * Parses skill manifest from JSON or agentskills.io SKILL.md format (Markdown with YAML frontmatter).
 * Rejects arbitrary markdown files starting with '#' without frontmatter.
 * Never treats self-declared licenses as independently verified redistribution permission.
 */
export function parseSkillManifest(rawText, fallbackUrl = '') {
  const trimmed = String(rawText ?? '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const declaredLicense = parsed.license ? String(parsed.license).trim() : 'unknown';
      const idRaw = parsed.id || path.basename(fallbackUrl, '.json');
      const id = normalizeSkillId(String(idRaw));

      return {
        id,
        name: parsed.name || id,
        version: parsed.version || '1.0.0',
        license: declaredLicense,
        declaredLicense,
        verifiedLicense: null,
        redistributable: false,
        category: parsed.category || 'skills',
        author: parsed.author ? String(parsed.author).trim() : 'unknown',
        description: parsed.description || '',
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        systemPrompt: parsed.systemPrompt || parsed.prompt || '',
      };
    } catch (e) {
      if (e.code === 'invalid_skill_id') throw e;
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
    const id = normalizeSkillId(String(idCandidate));
    const declaredLicense = meta.license ? String(meta.license).trim() : 'unknown';

    return {
      id,
      name: meta.name || id,
      version: meta.version || '1.0.0',
      license: declaredLicense,
      declaredLicense,
      verifiedLicense: null,
      redistributable: false,
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
 * Distinguishes ChatMCP built-ins from external community templates.
 * Never invents fabricated commit SHAs or false verification badges.
 */
export const MARKETPLACE_CATALOG = Object.freeze([
  {
    id: 'git-workflow-pro',
    name: 'Git Workflow Pro',
    version: '1.2.0',
    license: 'MIT',
    declaredLicense: 'MIT',
    verifiedLicense: 'MIT',
    redistributable: true,
    provenance: 'chatmcp-builtin',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Semantic git commits, branching automation, pull request templates, and merge conflict assistance.',
    tools: ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_branch'],
    systemPrompt: 'You have Git Workflow Pro skill enabled: use semantic commit messages (feat, fix, docs, refactor) and suggest pull request templates upon branch completion.',
    installedByDefault: true,
    sourceUrl: null,
    commitSha: null,
  },
  {
    id: 'python-architect',
    name: 'Python Architect & Pytest',
    version: '1.1.0',
    license: 'MIT',
    declaredLicense: 'MIT',
    verifiedLicense: 'MIT',
    redistributable: true,
    provenance: 'chatmcp-builtin',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Python code analysis, automated pytest fixtures generator, and type-hint verification.',
    tools: ['read_file', 'edit_file', 'write_file', 'run_command'],
    systemPrompt: 'You have Python Architect skill: follow PEP-8 conventions, verify type hints, and ensure unit tests accompany all new functions.',
    installedByDefault: true,
    sourceUrl: null,
    commitSha: null,
  },
  {
    id: 'fastapi-backend-developer',
    name: 'FastAPI Backend Developer',
    version: '1.0.0',
    license: 'MIT',
    declaredLicense: 'MIT',
    verifiedLicense: null,
    redistributable: false,
    provenance: 'community',
    sourceUrl: 'https://github.com/tiangolo/fastapi',
    commitSha: null,
    category: 'coding',
    author: 'Community',
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
    declaredLicense: 'MIT',
    verifiedLicense: null,
    redistributable: false,
    provenance: 'community',
    sourceUrl: 'https://github.com/facebook/react',
    commitSha: null,
    category: 'coding',
    author: 'Community',
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
    declaredLicense: 'Apache-2.0',
    verifiedLicense: null,
    redistributable: false,
    provenance: 'community',
    sourceUrl: 'https://github.com/actions/runner',
    commitSha: null,
    category: 'devops',
    author: 'Community',
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
    declaredLicense: 'Apache-2.0',
    verifiedLicense: null,
    redistributable: false,
    provenance: 'community',
    sourceUrl: 'https://github.com/moby/moby',
    commitSha: null,
    category: 'devops',
    author: 'Community',
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
    declaredLicense: 'MIT',
    verifiedLicense: 'MIT',
    redistributable: true,
    provenance: 'chatmcp-builtin',
    category: 'mcp-servers',
    author: 'ChatMCP Team',
    description: 'MCP server plugin for querying local SQLite databases, extracting schemas, and running data sanity checks.',
    tools: ['read_file', 'run_command'],
    systemPrompt: 'You have SQLite MCP Explorer: use parameterized queries and analyze database indexes before running joins.',
    installedByDefault: false,
    sourceUrl: null,
    commitSha: null,
  },
  {
    id: 'web-researcher',
    name: 'Web & Docs Researcher',
    version: '2.0.0',
    license: 'MIT',
    declaredLicense: 'MIT',
    verifiedLicense: 'MIT',
    redistributable: true,
    provenance: 'chatmcp-builtin',
    category: 'research',
    author: 'ChatMCP Team',
    description: 'Web search, technical documentation scraping, and library changelog analysis via MCP.',
    tools: ['tasks_run', 'tasks_status'],
    systemPrompt: 'You have Web Researcher skill: cite official package documentation and compare semantic versions when investigating dependencies.',
    installedByDefault: false,
    sourceUrl: null,
    commitSha: null,
  },
  {
    id: 'security-compliance-guard',
    name: 'Security & Secret Compliance Guard',
    version: '1.1.2',
    license: 'Apache-2.0',
    declaredLicense: 'Apache-2.0',
    verifiedLicense: 'Apache-2.0',
    redistributable: true,
    provenance: 'chatmcp-builtin',
    category: 'governance',
    author: 'ChatMCP Security Team',
    description: 'Pre-commit scanner for hardcoded credentials, JWTs, private keys, and suspicious open-source package licenses.',
    tools: ['read_file', 'search_files'],
    systemPrompt: 'You have Security Guard skill: never allow API keys or private certificates into source files, and reject GPL licenses in proprietary code.',
    installedByDefault: true,
    sourceUrl: null,
    commitSha: null,
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
    this.stateDir = path.resolve(stateDir);
    this.filePath = path.join(this.stateDir, INSTALLED_FILENAME);
    this.skillsDir = path.join(this.stateDir, 'skills');
    this.lockFilePath = path.join(this.stateDir, LOCK_FILENAME);
    this.installedPlugins = new Map();
    this.loaded = false;
  }

  #resolveSkillDir(rawId) {
    const validId = normalizeSkillId(rawId);
    const target = path.resolve(this.skillsDir, validId);
    const rel = path.relative(this.skillsDir, target).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('/')) {
      throw error('directory_traversal', `Đường dẫn kỹ năng không an toàn: "${validId}".`, 400);
    }
    return { id: validId, absolute: target, relative: rel };
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
            if (!p || !p.id) continue;
            try {
              const validId = normalizeSkillId(p.id);
              this.installedPlugins.set(validId, { ...p, id: validId });
            } catch {
              // Discard legacy/corrupt persisted ID with path separators or unsafe names
            }
          }
        } else {
          // First boot: install default plugins
          this.installedPlugins.clear();
          for (const p of MARKETPLACE_CATALOG) {
            if (p.installedByDefault) {
              const entry = { ...p, enabled: true, installedAt: new Date().toISOString() };
              this.installedPlugins.set(entry.id, entry);
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
    const { absolute: targetDir } = this.#resolveSkillDir(skill.id);
    const stagingDir = path.join(this.stateDir, `.staging-skill-${crypto.randomUUID()}`);
    await fs.mkdir(stagingDir, { recursive: true });

    try {
      // 1. Write manifest.json
      const manifestJson = JSON.stringify(
        {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          license: skill.license || 'unknown',
          declaredLicense: skill.declaredLicense || skill.license || 'unknown',
          verifiedLicense: skill.verifiedLicense || null,
          redistributable: Boolean(skill.redistributable),
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
      await fs.writeFile(path.join(stagingDir, 'manifest.json'), manifestJson, 'utf8');

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
      await fs.writeFile(path.join(stagingDir, 'SKILL.md'), skillMd, 'utf8');

      const contentHash = crypto.createHash('sha256').update(skillMd).digest('hex');

      // Stage is fully written before touching any existing version.
      // A backup gives us recovery if the final rename fails.
      const existing = await fs.lstat(targetDir).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (existing?.isSymbolicLink()) throw error('skill_symlink', 'Cannot replace a symlinked skill directory.', 403);
      const backupDir = path.join(this.stateDir, `.backup-skill-${crypto.randomUUID()}`);
      if (existing) await fs.rename(targetDir, backupDir);
      try {
        await fs.rename(stagingDir, targetDir);
      } catch (moveError) {
        if (existing) await fs.rename(backupDir, targetDir).catch((rollbackError) => {
          throw Object.assign(error('skill_rollback_failed', 'Skill replacement and rollback failed.', 500), { cause: rollbackError });
        });
        throw moveError;
      }
      if (existing) await fs.rm(backupDir, { recursive: true, force: true });
      return { contentHash };
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async #removeSkillDirectory(skillId) {
    const { absolute } = this.#resolveSkillDir(skillId);
    let st;
    try {
      st = await fs.lstat(absolute);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }

    if (st.isSymbolicLink()) {
      await fs.unlink(absolute);
      return;
    }

    const realTarget = await fs.realpath(absolute);
    const realSkillsDir = await fs.realpath(this.skillsDir);
    const rel = path.relative(realSkillsDir, realTarget).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw error('directory_traversal', `Thư mục kỹ năng trỏ ra ngoài phạm vi an toàn: "${skillId}".`, 400);
    }

    await fs.rm(absolute, { recursive: true, force: true });
  }

  async save() {
    const plugins = Array.from(this.installedPlugins.values());
    const payload = {
      plugins,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.filePath, payload);

    // Sync skills-lock.json - never silently ignore errors
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
        declaredLicense: p.declaredLicense || p.license || 'unknown',
        verifiedLicense: p.verifiedLicense || null,
        redistributable: Boolean(p.redistributable),
        author: p.author || 'unknown',
        provenance: p.provenance || 'custom',
        sourceUrl: p.sourceUrl || null,
        commitSha: p.commitSha || null,
        installedAt: p.installedAt || new Date().toISOString(),
      };
    }
    await writeJson(this.lockFilePath, lockPayload);
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
      declaredLicense: p.declaredLicense || p.license || 'unknown',
      verifiedLicense: p.verifiedLicense || null,
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
      const { text: rawText, finalUrl } = await safeFetchSkillManifest(rawTarget.trim());
      const remoteData = parseSkillManifest(rawText, finalUrl);

      if (!remoteData || typeof remoteData !== 'object') {
        throw error('invalid_manifest', 'Nội dung trả về từ URL không phải JSON manifest hoặc SKILL.md hợp lệ.');
      }

      const id = normalizeSkillId(String(remoteData.id || customDefinition?.id || 'online-skill'));
      if (this.installedPlugins.has(id)) {
        throw error('already_installed', `Kỹ năng "${id}" đã được cài đặt.`, 409);
      }

      const installedEntry = {
        id,
        name: String(remoteData.name || customDefinition?.name || id).trim(),
        version: String(remoteData.version || '1.0.0'),
        license: String(remoteData.license || customDefinition?.license || 'unknown'),
        declaredLicense: String(remoteData.declaredLicense || remoteData.license || 'unknown'),
        verifiedLicense: null,
        redistributable: false,
        category: String(remoteData.category || 'skills'),
        author: String(remoteData.author || 'unknown'),
        provenance: 'remote-url',
        description: String(remoteData.description || ''),
        tools: Array.isArray(remoteData.tools) ? remoteData.tools : [],
        systemPrompt: String(remoteData.systemPrompt || remoteData.prompt || ''),
        sourceUrl: finalUrl,
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
    const id = normalizeSkillId(pluginId);
    if (this.installedPlugins.has(id)) {
      throw error('already_installed', `Plugin "${id}" đã được cài đặt.`, 409);
    }

    let manifest = MARKETPLACE_CATALOG.find((x) => x.id === id);
    if (!manifest) {
      if (customDefinition && typeof customDefinition === 'object' && customDefinition.name) {
        const declaredLicense = customDefinition.license ? String(customDefinition.license).trim() : 'unknown';
        manifest = {
          id,
          name: String(customDefinition.name).trim(),
          version: customDefinition.version || '1.0.0',
          license: declaredLicense,
          declaredLicense,
          verifiedLicense: null,
          redistributable: false,
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
   * Uninstalls a plugin and safely removes its directory and lockfile entry.
   */
  async uninstall(pluginId) {
    if (!pluginId || typeof pluginId !== 'string') throw error('invalid_plugin_id', 'Mã plugin không hợp lệ.');
    const id = normalizeSkillId(pluginId);
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
    const id = normalizeSkillId(pluginId);
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
        declaredLicense: p.declaredLicense || p.license || 'unknown',
        verifiedLicense: p.verifiedLicense || null,
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
   * Enforces a relevance threshold: if no skill is meaningfully relevant (score < 3), selects nothing.
   * Guarantees that injected prompt instructions never exceed tokenBudget, even if the first skill is oversized.
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

    const promptText = String(prompt || '').trim().toLowerCase();
    if (!promptText) return [];

    const promptTokens = new Set(
      promptText.match(/\b[a-z0-9_-]{3,}\b/g) || []
    );

    const scored = [];

    for (const skill of active) {
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
      if (promptTokens.has('branch') && skill.id.includes('git')) score += 8;
      if (promptTokens.has('test') && (skill.id.includes('python') || skill.id.includes('test'))) score += 8;
      if (promptTokens.has('pytest') && skill.id.includes('python')) score += 10;
      if (promptTokens.has('docker') && skill.id.includes('docker')) score += 10;
      if (promptTokens.has('react') && skill.id.includes('react')) score += 10;
      if (promptTokens.has('security') && skill.id.includes('security')) score += 10;
      if (promptTokens.has('secret') && skill.id.includes('security')) score += 10;
      if (promptTokens.has('sqlite') && skill.id.includes('sqlite')) score += 10;

      // Meaningful relevance threshold: must achieve score >= 3
      if (score >= 3) {
        scored.push({ skill, score });
      }
    }

    // If nothing is relevant, select nothing
    if (!scored.length) return [];

    scored.sort((a, b) => b.score - a.score);

    const selected = [];
    let currentChars = 0;

    for (const { skill } of scored) {
      if (selected.length >= limit) break;
      const promptLength = (skill.systemPrompt || '').length;

      // First skill handling: ensure even an oversized first skill does not exceed tokenBudget
      if (selected.length === 0) {
        if (promptLength > tokenBudget) {
          const truncatedPrompt = skill.systemPrompt.slice(0, Math.max(0, tokenBudget - 80)) + '\n... [Cắt theo giới hạn token]';
          selected.push({ ...skill, systemPrompt: truncatedPrompt });
          currentChars = truncatedPrompt.length;
          break;
        } else {
          selected.push(skill);
          currentChars += promptLength;
        }
      } else {
        if (currentChars + promptLength <= tokenBudget) {
          selected.push(skill);
          currentChars += promptLength;
        }
      }
    }

    return selected;
  }
}
