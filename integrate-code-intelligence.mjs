// integrate-code-intelligence.mjs
// Script tự động tích hợp bộ 6 công cụ Code Intelligence vào CHATMCP-HUB
// Cách chạy: đặt file này cùng code-intelligence.mjs và code-intelligence.test.mjs ở thư mục gốc repo ChatMCP (hoặc trong CHATMCP-HUB) rồi chạy:
//   node integrate-code-intelligence.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveHubRoot() {
  const candidates = [
    path.join(process.cwd(), 'CHATMCP-HUB'),
    process.cwd(),
    path.join(__dirname, 'CHATMCP-HUB'),
    __dirname,
  ];
  for (const dir of candidates) {
    if (await fileExists(path.join(dir, 'lib', 'local-tools.mjs'))) {
      return dir;
    }
  }
  throw new Error(
    'Không tìm thấy thư mục CHATMCP-HUB/lib/local-tools.mjs. Hãy chạy script này từ thư mục gốc của repo ChatMCP hoặc bên trong thư mục CHATMCP-HUB.'
  );
}

async function patchLocalTools(filePath) {
  const original = await fs.readFile(filePath, 'utf8');
  if (original.includes('registerCodeIntelligenceTools')) {
    console.log('  [SKIP] lib/local-tools.mjs đã được tích hợp từ trước.');
    return false;
  }

  let updated = original;

  // 1. Chèn câu lệnh import ở đầu file
  const importAnchor = "import { validateArguments } from './tool-schema.mjs';";
  const newImport = `${importAnchor}\nimport { registerCodeIntelligenceTools } from './code-intelligence.mjs';`;
  if (updated.includes(importAnchor)) {
    updated = updated.replace(importAnchor, newImport);
  } else {
    updated = `import { registerCodeIntelligenceTools } from './code-intelligence.mjs';\n${updated}`;
  }

  // 2. Đăng ký 6 công cụ bên trong #register()
  const registerRegex = /(#register\s*\(\)\s*\{\s*\n\s*const define = [^\n]+\n(?:\s*const WRITE = [^\n]+\n)?)/;
  if (!registerRegex.test(updated)) {
    throw new Error('Không tìm thấy vị trí hàm #register() trong lib/local-tools.mjs');
  }
  updated = updated.replace(
    registerRegex,
    `$1    registerCodeIntelligenceTools(define, this.workspace);\n`
  );

  await fs.writeFile(filePath, updated, 'utf8');
  console.log('  [OK] Đã cập nhật lib/local-tools.mjs');
  return true;
}

async function patchPermissions(filePath) {
  if (!(await fileExists(filePath))) return false;
  const original = await fs.readFile(filePath, 'utf8');
  if (original.includes('repo_map') && original.includes('code_diagnostics')) {
    console.log('  [SKIP] lib/permissions.mjs đã có danh sách tool Code Intelligence.');
    return false;
  }

  // Bổ sung 6 tool vào danh sách read-only cạnh 'search_files'
  const searchFilesRegex = /(['"]search_files['"])/;
  if (!searchFilesRegex.test(original)) {
    console.log('  [WARN] Không tìm thấy "search_files" trong lib/permissions.mjs, bỏ qua bước vá tự động.');
    return false;
  }

  const updated = original.replace(
    searchFilesRegex,
    `$1, 'repo_map', 'code_symbols', 'find_definition', 'find_references', 'dependency_graph', 'code_diagnostics'`
  );
  await fs.writeFile(filePath, updated, 'utf8');
  console.log('  [OK] Đã cập nhật danh sách Read-Only tools trong lib/permissions.mjs');
  return true;
}

async function patchAgentInstructions(filePath) {
  if (!(await fileExists(filePath))) return false;
  const original = await fs.readFile(filePath, 'utf8');
  if (original.includes('Code Intelligence')) {
    console.log('  [SKIP] lib/agent.mjs đã có phân nhóm Code Intelligence.');
    return false;
  }

  const fileOpsAnchor = "{ name: 'File Operations',";
  if (!original.includes(fileOpsAnchor)) {
    console.log('  [WARN] Không tìm thấy danh sách categories trong lib/agent.mjs, bỏ qua bước vá tự động.');
    return false;
  }

  const codeIntelCategory = `{ name: 'Code Intelligence (AST & Symbols)', tools: ['repo_map', 'code_symbols', 'find_definition', 'find_references', 'dependency_graph', 'code_diagnostics'] },\n    ${fileOpsAnchor}`;
  const updated = original.replace(fileOpsAnchor, codeIntelCategory);
  await fs.writeFile(filePath, updated, 'utf8');
  console.log('  [OK] Đã bổ sung nhóm Code Intelligence vào createLocalAgentInstructions() trong lib/agent.mjs');
  return true;
}

async function main() {
  console.log('=== Tích hợp Code Intelligence Engine vào ChatMCP ===');
  const hubRoot = await resolveHubRoot();
  console.log(`Thư mục CHATMCP-HUB: ${hubRoot}`);

  // Copy code-intelligence.mjs và code-intelligence.test.mjs nếu chạy từ ngoài
  const srcEngine = path.join(__dirname, 'code-intelligence.mjs');
  const destEngine = path.join(hubRoot, 'lib', 'code-intelligence.mjs');
  if ((await fileExists(srcEngine)) && path.resolve(srcEngine) !== path.resolve(destEngine)) {
    await fs.copyFile(srcEngine, destEngine);
    console.log('  [OK] Đã chép code-intelligence.mjs -> CHATMCP-HUB/lib/code-intelligence.mjs');
  }

  const srcTest = path.join(__dirname, 'code-intelligence.test.mjs');
  const destTest = path.join(hubRoot, 'tests', 'code-intelligence.test.mjs');
  if ((await fileExists(srcTest)) && path.resolve(srcTest) !== path.resolve(destTest)) {
    await fs.mkdir(path.join(hubRoot, 'tests'), { recursive: true });
    await fs.copyFile(srcTest, destTest);
    console.log('  [OK] Đã chép code-intelligence.test.mjs -> CHATMCP-HUB/tests/code-intelligence.test.mjs');
  }

  await patchLocalTools(path.join(hubRoot, 'lib', 'local-tools.mjs'));
  await patchPermissions(path.join(hubRoot, 'lib', 'permissions.mjs'));
  await patchAgentInstructions(path.join(hubRoot, 'lib', 'agent.mjs'));

  console.log('\nHoàn tất! Hãy chạy `node tests/code-intelligence.test.mjs` hoặc `npm test` trong CHATMCP-HUB để kiểm tra.');
}

main().catch((err) => {
  console.error('Lỗi tích hợp:', err.message);
  process.exitCode = 1;
});
