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
 * DNS-pinned, bounded raw download. GitHub content may be binary.
 * Every redirected URL receives new DNS checks, and bytes are capped
 * as they arrive in fetchPinnedSkillResponse.
 */
export async function safeFetchSkillBytes(rawUrl, {maxBytes=2*1024*1024,maxRedirects=3,timeoutMs=12000,transport=fetchPinnedSkillResponse,resolver=resolvePublicUrl}={}){
  let url=rawUrl;
  for(let hop=0;hop<=maxRedirects;hop++){
    const approved=await resolver(url);
    if(!approved?.ip||isPrivateOrReservedIp(approved.ip))throw error('ssrf_blocked','Unapproved skill asset address.',403);
    const res=await transport(approved.url,{ip:approved.ip,maxBytes,timeoutMs});
    if([301,302,303,307,308].includes(res.status)){
      const target=res.headers.get('location');
      if(!target)throw error('bad_redirect','Missing redirect destination.',400);
      url=new URL(target,url).toString();
      continue;
    }
    if(!res.ok)throw error('asset_fetch_failed','Remote asset returned HTTP '+res.status,res.status||400);
    const bytes=res.buffer;
    if(!Buffer.isBuffer(bytes)||bytes.length>maxBytes)throw error('asset_too_large','Asset exceeds download limit.',413);
    return {bytes,finalUrl:approved.url};
  }
  throw error('too_many_redirects','Skill asset exceeded redirect limit.',400);
}

/**
 * Strict subset parser for common Agent Skills frontmatter fields.
 * Throws `malformed_yaml` on syntax errors, unsupported nested types, or unclosed quotes.
 */
function parseYamlBlock(yamlText) {
  // An intentionally strict, dependency-free subset of YAML 1.2:
  // top-level scalars, inline lists, one-level string mappings, item lists,
  // and folded/literal block scalars. Unsupported structures fail closed.
  const result = Object.create(null);
  const lines = yamlText.split(/\r?\n/);
  let parent = null, block = null;

  const invalid = (line) => error('malformed_yaml', 'Unsupported or malformed SKILL.md YAML on line ' + line + '.', 400);
  const scalar = (raw, line) => {
    let value = raw.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || !value.endsWith(quote)) throw invalid(line);
      // Keep scalar values as text; never evaluate YAML tags or aliases.
      return value.slice(1, -1).replace(quote === '"' ? /\\"/g : /''/g, quote);
    }
    if (value.includes('!') && /^!/.test(value)) throw invalid(line);
    return value.replace(/\s+#.*$/, '').trim();
  };
  const finishBlock = () => {
    if (!block) return;
    const parts = block.lines;
    result[block.key] = block.style === '>'
      ? parts.join(' ').replace(/\s+/g, ' ').trim()
      : parts.join('\n').trim();
    block = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], number = i + 1;
    if (/^\s*\t/.test(raw)) throw invalid(number);
    const indent = (/^ */.exec(raw) || [''])[0].length;
    if (block) {
      if (!raw.trim()) { block.lines.push(''); continue; }
      if (indent > block.indent) { block.lines.push(raw.slice(block.indent + 1).trimEnd()); continue; }
      finishBlock();
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (indent === 0) {
      const match = /^([a-zA-Z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
      if (!match) throw invalid(number);
      const [,key,rawValue=''] = match;
      if (Object.hasOwn(result,key)) throw invalid(number);
      const value = scalar(rawValue,number);
      parent = key;
      if (value === '>' || value === '|') {
        block = {key,style:value,indent,lines:[]};
        result[key] = '';
      } else if (!value) result[key] = [];
      else if (value.startsWith('[') && value.endsWith(']')) {
        result[key] = value.slice(1,-1).split(',').map(v=>scalar(v,number)).filter(Boolean);
      } else result[key] = value;
      continue;
    }
    if (!parent || indent < 2) throw invalid(number);
    const listMatch = /^-\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      if (!Array.isArray(result[parent])) throw invalid(number);
      result[parent].push(scalar(listMatch[1],number));
      continue;
    }
    const pair = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!pair || !Array.isArray(result[parent]) || result[parent].length) throw invalid(number);
    result[parent] = Object.create(null);
    result[parent][pair[1]] = scalar(pair[2],number);
    // Consume further sibling entries of a shallow mapping.
    for (let j=i+1;j<lines.length;j++) {
      const next=lines[j], ni=(/^ */.exec(next)||[''])[0].length;
      if (!next.trim() || next.trim().startsWith('#')) {i=j;continue;}
      if (ni !== indent) break;
      const sub=/^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(next.trim());
      if (!sub || Object.hasOwn(result[parent],sub[1])) throw invalid(j+1);
      result[parent][sub[1]]=scalar(sub[2],j+1);
      i=j;
    }
  }
  finishBlock();
  return result;
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
    const normalizedName=String(idCandidate).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
    const id = normalizeSkillId(normalizedName);
    if (typeof meta.name !== 'string' || !meta.name.trim() ||
        (meta.description !== undefined && typeof meta.description !== 'string')) {
      throw error('invalid_manifest', 'SKILL.md requires a name and a scalar description.', 400);
    }
    const declaredLicense = meta.license ? String(meta.license).trim() : 'unknown';

    return {
      id,
      name: meta.name || id,
      version: meta.version || meta.metadata?.version || '1.0.0',
      license: declaredLicense,
      declaredLicense,
      verifiedLicense: null,
      redistributable: false,
      category: meta.category || 'skills',
      author: meta.author || meta.metadata?.author ? String(meta.author || meta.metadata.author).trim() : 'unknown',
      description: meta.description || '',
      tools: Array.isArray(meta.tools) ? meta.tools : [],
      systemPrompt: body || meta.prompt || '',
    };
  }

  throw error('invalid_manifest', 'Nội dung trả về không phải JSON manifest hoặc SKILL.md hợp lệ có frontmatter YAML.');
}

/**
 * Skill sources that the project knows about. Being listed here is NOT verification: nothing in this list is checked, signed or audited,
 * a skill from any of them is still untrusted third-party text (see the "UNTRUSTED SKILL REFERENCES" framing in lib/agent.mjs).
 */
export const KNOWN_SKILL_SOURCES = Object.freeze([
  {
    id: 'github-chatmcp',
    name: 'ChatMCP project skills',
    url: 'https://github.com/pddczpl/ChatMCP',
  },
  {
    id: 'agentskills-io',
    name: 'Agent Skills standard',
    url: 'https://agentskills.io',
  },
]);

/**
 * Built-in curated marketplace plugins catalog.
 * Every entry is prompt-only guidance: a short system prompt and tool-name hints, no code, no MCP server, no tools of its own.
 * Distinguishes ChatMCP built-ins from external community templates.
 * Never invents fabricated commit SHAs or false verification badges. The repository carries no LICENSE file, so the licence of a
 * built-in is only declared (never verified) and no entry is marked redistributable.
 */
export const MARKETPLACE_CATALOG = Object.freeze([
  {
    id: 'git-workflow-pro',
    name: 'Git Workflow Pro',
    version: '1.2.0',
    license: 'MIT',
    declaredLicense: 'MIT',
    verifiedLicense: null,
    redistributable: false,
    provenance: 'chatmcp-builtin',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Prompt guidance for semantic commit messages, branch naming and pull request templates.',
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
    verifiedLicense: null,
    redistributable: false,
    provenance: 'chatmcp-builtin',
    category: 'coding',
    author: 'ChatMCP Team',
    description: 'Prompt guidance for Python structure, pytest fixtures and type hints.',
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
    id: 'sqlite-explorer',
    name: 'SQLite Explorer',
    version: '1.3.0',
    license: 'MIT',
    declaredLicense: 'MIT',
    verifiedLicense: null,
    redistributable: false,
    provenance: 'chatmcp-builtin',
    category: 'data',
    author: 'ChatMCP Team',
    description: 'Prompt guidance for querying local SQLite databases with parameterized queries and checking schemas and indexes. It is not an MCP server and adds no tools.',
    tools: ['read_file', 'run_command'],
    systemPrompt: 'You have SQLite Explorer guidance: use parameterized queries and analyze database indexes before running joins.',
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
    verifiedLicense: null,
    redistributable: false,
    provenance: 'chatmcp-builtin',
    category: 'research',
    author: 'ChatMCP Team',
    description: 'Prompt guidance for citing official package documentation and comparing versions. It adds no web search or scraping tools.',
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
    verifiedLicense: null,
    redistributable: false,
    provenance: 'chatmcp-builtin',
    category: 'governance',
    author: 'ChatMCP Security Team',
    description: 'Prompt guidance to keep credentials, JWTs and private keys out of source files and to flag incompatible licenses. It does not scan files by itself.',
    tools: ['read_file', 'search_files'],
    systemPrompt: 'You have Security Guard skill: never allow API keys or private certificates into source files, and reject GPL licenses in proprietary code.',
    installedByDefault: true,
    sourceUrl: null,
    commitSha: null,
  },
]);

// Built-ins that earlier releases installed under a name that claimed more than they are (an "MCP explorer" that is prompt-only guidance).
const RENAMED_BUILTINS = Object.freeze({ 'sqlite-mcp-explorer': 'sqlite-explorer' });

// Words that cannot say what a request or a skill is about. A function word is no evidence anywhere: "and" used to select four skills because it sits inside
// "command", and "the" and "for" were a point for every description that has them. The filler is the vocabulary every description is written in
// ("Use this skill when the user wants ...", "Prompt guidance for ..."): no evidence in a description, though a skill may still be called "Skill Creator".
const FUNCTION_WORDS = new Set((
  'about above after again against all also although always among and another any are because been before being below between both but can could did does ' +
  'down during each either else even ever every few for from further had has have having her here hers him his how however into its itself just many may ' +
  'might more most much must neither never nor not now off once only onto other our ours out over per shall she several should since some still such than ' +
  'that the their theirs them then there these they this those though through too under unless until upon very via was were what whatever when whenever ' +
  'where whether which while who whom whose why will with within without would yet you your yours'
).split(' '));
const DESCRIPTION_FILLER = new Set('guidance need needs prompt prompts skill skills tool tools trigger triggers use used user users uses using want wants'.split(' '));

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
              let entry = { ...p, id: validId };
              if (entry.provenance === 'chatmcp-builtin') {
                // Take over the renamed catalog entry (keeping the owner's choice) and drop licence claims an older release wrote down:
                // the repository has no LICENSE file, so nothing is verified or redistributable.
                const renamed = MARKETPLACE_CATALOG.find((item) => item.id === RENAMED_BUILTINS[validId]);
                if (renamed) entry = { ...renamed, enabled: entry.enabled, installedAt: entry.installedAt };
                entry.verifiedLicense = null;
                entry.redistributable = false;
              }
              this.installedPlugins.set(entry.id, entry);
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
          resourcePaths: skill.resourcePaths || [],
          licenseEvidence: skill.licenseEvidence || null,
          dependencies: skill.dependencies || [],
          installedAt: skill.installedAt || new Date().toISOString(),
        },
        null,
        2
      );
      await fs.writeFile(path.join(stagingDir, 'manifest.json'), manifestJson, 'utf8');

      // 2. Write SKILL.md
      const toolsYaml = (skill.tools || []).map((t) => `  - ${t}`).join('\n');
      const generatedSkillMd = [
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
      const skillMd = typeof skill.originalSkillText === 'string' ? skill.originalSkillText : generatedSkillMd;
      if (Buffer.byteLength(skillMd, 'utf8') > 128 * 1024) throw error('skill_too_large', 'SKILL.md exceeds 128 KiB.', 413);
      await fs.writeFile(path.join(stagingDir, 'SKILL.md'), skillMd, { encoding: 'utf8', mode: 0o600 });
      const digest = crypto.createHash('sha256').update('SKILL.md\0').update(skillMd);
      let total = 0;
      const resources = Array.isArray(skill.resourceFiles) ? skill.resourceFiles : [];
      if (resources.length > 200) throw error('too_many_skill_files', 'Maximum 200 additional skill resources.', 413);
      for (const item of resources) {
        const rel = String(item?.path || '').replaceAll('\\', '/');
        const body = item?.encoding === 'base64' && typeof item?.data === 'string'
          ? Buffer.from(item.data, 'base64')
          : typeof item?.text === 'string' ? Buffer.from(item.text, 'utf8') : null;
        if (!/^[a-zA-Z0-9_.@+() -]+(?:\/[a-zA-Z0-9_.@+() -]+)*$/.test(rel) ||
            rel.split('/').some(x => x === '..' || x === '.' || x === '.git' || x === 'node_modules' || isUnsafeWindowsName(x)) ||
            ['SKILL.md','manifest.json'].includes(rel) || !body) {
          throw error('invalid_resource_path', 'Imported skill resource path or content is unsafe.', 403);
        }
        if (item.encoding === 'base64' && Buffer.from(body.toString('base64'),'base64').compare(body) !== 0)
          throw error('invalid_resource_data','Invalid base64 asset.',400);
        const size = body.length;
        total += size;
        if (size > 2 * 1024 * 1024 || total > 24 * 1024 * 1024) throw error('skill_resources_too_large', 'Skill resources exceed size limits.', 413);
        const dest = path.resolve(stagingDir, rel);
        if (!dest.startsWith(stagingDir + path.sep)) throw error('directory_traversal', 'Invalid skill resource.', 403);
        await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await fs.writeFile(dest, body, { flag: 'wx', mode: 0o600 });
        digest.update('\0'+rel+'\0').update(body);
      }
      const contentHash = digest.digest('hex');

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
        contentHash: p.contentHash || null,
        resourcePaths: p.resourcePaths || [],
        licenseEvidence: p.licenseEvidence || null,
        dependencies: p.dependencies || [],
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
      resourcePaths: p.resourcePaths || [],
      contentHash: p.contentHash || null,
      licenseEvidence: p.licenseEvidence || null,
      dependencies: p.dependencies || null,
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

  /** Import an immutable GitHub SKILL.md and supporting text files. No script execution. */
  async importRegistrySkill({id,name,description='',version='1.0.0',license='unknown',author='unknown',tools=[],systemPrompt='',sourceUrl,commitSha,originalSkillText,resourceFiles=[],licenseEvidence=null,dependencies=[],update=false}={}){
    const safeId=normalizeSkillId(id);
    const previous=this.installedPlugins.get(safeId) ?? null;
    if(previous&&!update)throw error('already_installed','Skill already installed.',409);
    if(update&&(!previous||previous.provenance!=='github-registry'))throw error('not_registry_skill','Only a managed registry skill can be updated.',409);
    if(!/^[a-f0-9]{40}$/i.test(String(commitSha||'')) ||
      !/^https:\/\/raw\.githubusercontent\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-f0-9]{40}\/.+SKILL\.md$/i.test(String(sourceUrl||''))) {
      throw error('invalid_source','Registry import requires a pinned GitHub SKILL.md URL.',403);
    }
    if(!String(sourceUrl).includes('/'+commitSha+'/'))throw error('invalid_source','Source revision mismatch.',403);
    const resourcePaths=resourceFiles.map(x=>x.path);
    const entry={
      id:safeId,name,description,version,license,declaredLicense:license,
      // Automated pattern matching is license evidence, not verified legal permission.
      verifiedLicense:null,
      licenseEvidence:licenseEvidence||null,dependencies,redistributable:false,author,tools,
      systemPrompt,sourceUrl,commitSha,resourcePaths,
      category:'skills',provenance:'github-registry',enabled:false,
      installedAt:new Date().toISOString()
    };
    // Preserve a recovery copy across the directory swap AND state writes;
    // failure does not replace the last known-good imported skill.
    const backupPath=path.join(this.stateDir,'.rollback-registry-'+crypto.randomUUID());
    if(previous)await fs.cp(this.#resolveSkillDir(safeId).absolute,backupPath,{recursive:true,force:false,errorOnExist:true});
    try{
      const {contentHash}=await this.#writeSkillDirectory({...entry,originalSkillText,resourceFiles});
      entry.contentHash=contentHash;
      this.installedPlugins.set(safeId,entry);
      await this.save();
      return entry;
    }catch(e){
      if(previous){
        this.installedPlugins.set(safeId,previous);
        await fs.rm(this.#resolveSkillDir(safeId).absolute,{recursive:true,force:true}).catch(()=>{});
        await fs.rename(backupPath,this.#resolveSkillDir(safeId).absolute).catch(()=>{});
      }else{
        this.installedPlugins.delete(safeId);
        await this.#removeSkillDirectory(safeId).catch(()=>{});
      }
      await this.save().catch(()=>{});
      throw e;
    }finally{
      await fs.rm(backupPath,{recursive:true,force:true}).catch(()=>{});
    }
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
   * A skill is relevant when the prompt names it (a word of its id, +5, or of its name, +4), asks for what it is about (an explicit trigger word, +8 to +10) or
   * shares distinct words with its description (+1 each). Enforces a relevance threshold: if no skill is meaningfully relevant (score < 3), selects nothing.
   * Any other word is worth at most 1 to a skill, so one ordinary word ("file", "read", "and", "test") cannot reach the threshold by itself: function words and
   * the filler of descriptions count for nothing, and so do the tools a skill lists (they say which tools it would use, not what it is about, and most skills
   * list read_file).
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

    // Function words are no evidence for anything, whichever field they would match.
    const words = [...promptTokens].filter((tok) => !FUNCTION_WORDS.has(tok));

    const scored = [];

    for (const skill of active) {
      let score = 0;
      const idTokens = skill.id.toLowerCase().split(/[-_]/);
      const nameTokens = skill.name.toLowerCase().split(/\s+/);
      const descTokens = new Set((skill.description || '').toLowerCase().split(/\s+/));

      // What a skill is called is evidence on its own (5 and 4); what it says about itself is weak and needs company: a description word is 1 and the
      // threshold is 3. The tools it lists are no evidence at all: a word that is part of "read_file" or "run_command" is in the request of nearly every task.
      for (const tok of words) {
        if (idTokens.includes(tok)) score += 5;
        if (nameTokens.includes(tok)) score += 4;
        if (descTokens.has(tok) && !DESCRIPTION_FILLER.has(tok)) score += 1;
      }

      // Context heuristics: explicit triggers, each enough on its own. Not "test": it is the most ordinary word of a request for code (the Hub's own
      // auto-resume prompt says it), and selecting the Python skill on it was a guess about the language of the project.
      if (promptTokens.has('git') && skill.id.includes('git')) score += 10;
      if (promptTokens.has('commit') && skill.id.includes('git')) score += 8;
      if (promptTokens.has('branch') && skill.id.includes('git')) score += 8;
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
