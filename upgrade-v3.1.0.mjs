// upgrade-v3.1.0.mjs
// Script tự động nâng cấp Smart Context Compaction (Auto Repo-Map + Tool History Compaction)
// và nâng phiên bản CHATMCP-HUB lên v3.1.0.
// Cách chạy: đặt file này cùng context-compaction.mjs và context-compaction.test.mjs ở thư mục gốc repo ChatMCP rồi chạy:
//   node upgrade-v3.1.0.mjs

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
    if (await fileExists(path.join(dir, 'lib', 'agent.mjs'))) {
      return dir;
    }
  }
  throw new Error(
    'Không tìm thấy CHATMCP-HUB/lib/agent.mjs. Hãy chạy script này từ thư mục gốc của repo ChatMCP hoặc bên trong CHATMCP-HUB.'
  );
}

async function patchAgentMjs(agentPath) {
  const original = await fs.readFile(agentPath, 'utf8');
  let updated = original;
  let changed = false;

  // 1. Thêm import { injectRepoMapIntoInstructions, compactConversationHistory } từ './context-compaction.mjs'
  if (!updated.includes('./context-compaction.mjs')) {
    const autonomyImport = "from './agent-autonomy.mjs';";
    const compactionImport = `${autonomyImport}\nimport { injectRepoMapIntoInstructions, compactConversationHistory } from './context-compaction.mjs';`;
    if (updated.includes(autonomyImport)) {
      updated = updated.replace(autonomyImport, compactionImport);
    } else {
      updated = `import { injectRepoMapIntoInstructions, compactConversationHistory } from './context-compaction.mjs';\n${updated}`;
    }
    changed = true;
    console.log('  [OK] Đã thêm import context-compaction.mjs vào lib/agent.mjs');
  }

  // 2. Tự động chèn Repo Map vào đầu phiên (ngay sau khi khởi tạo context.instructions / goalPlan)
  if (!updated.includes('injectRepoMapIntoInstructions')) {
    const goalPlanAnchor = "if (task.goalPlan) context.instructions += '\\n' + planInstructions(task.goalPlan);";
    const instructionsAnchor = ': createAgentInstructions(context.catalog, task.workspace);';
    const injectionSnippet = [
      'const repoMapInit = await injectRepoMapIntoInstructions(context.instructions, task.workspace, { prompt: task.prompt ?? task.goal ?? "" });',
      '      if (repoMapInit.injected) context.instructions = repoMapInit.instructions;',
    ].join('\n');

    if (updated.includes(goalPlanAnchor)) {
      updated = updated.replace(goalPlanAnchor, `${goalPlanAnchor}\n      ${injectionSnippet}`);
      changed = true;
      console.log('  [OK] Đã tích hợp tự động chèn Repo Map (injectRepoMapIntoInstructions) vào đầu phiên trong lib/agent.mjs');
    } else if (updated.includes(instructionsAnchor)) {
      updated = updated.replace(instructionsAnchor, `${instructionsAnchor}\n      ${injectionSnippet}`);
      changed = true;
      console.log('  [OK] Đã tích hợp tự động chèn Repo Map sau createLocalAgentInstructions trong lib/agent.mjs');
    } else {
      console.log('  [WARN] Không tìm thấy vị trí gán context.instructions trong lib/agent.mjs');
    }
  }

  // 3. Tự động nén lịch sử gọi tool trước khi gọi this.provider.respond(...) trong #run(context)
  if (!updated.includes('compactConversationHistory')) {
    const respondRegex = /(\s*const response = await abortable\(this\.provider\.respond\(\{)/;
    if (respondRegex.test(updated)) {
      const compactionCall = [
        '',
        '      const smartCompaction = compactConversationHistory(context.history);',
        '      if (smartCompaction.compacted) {',
        "        await this.#event(task, 'context_compaction', `Đã nén lịch sử gọi tool: tiết kiệm ~${smartCompaction.stats.savedTokens} tokens (${smartCompaction.stats.compactedCount} mục).`, smartCompaction.stats);",
        '      }',
      ].join('\n');
      updated = updated.replace(respondRegex, `${compactionCall}$1`);
      changed = true;
      console.log('  [OK] Đã tích hợp compactConversationHistory(context.history) vào vòng lặp #run(context) trong lib/agent.mjs');
    } else {
      console.log('  [WARN] Không tìm thấy lời gọi this.provider.respond trong lib/agent.mjs');
    }
  }

  if (changed) {
    await fs.writeFile(agentPath, updated, 'utf8');
  } else {
    console.log('  [SKIP] lib/agent.mjs đã được tích hợp đầy đủ từ trước.');
  }
}

async function patchPermissionsMjs(permPath) {
  if (!(await fileExists(permPath))) return;
  const original = await fs.readFile(permPath, 'utf8');
  if (original.includes('repo_map') && original.includes('code_diagnostics')) {
    console.log('  [SKIP] lib/permissions.mjs đã có danh sách 6 tool Code Intelligence.');
    return;
  }

  const searchFilesRegex = /(['"]search_files['"])/;
  if (searchFilesRegex.test(original)) {
    const updated = original.replace(
      searchFilesRegex,
      `$1, 'repo_map', 'code_symbols', 'find_definition', 'find_references', 'dependency_graph', 'code_diagnostics'`
    );
    await fs.writeFile(permPath, updated, 'utf8');
    console.log('  [OK] Đã bổ sung 6 tool Code Intelligence vào danh sách Read-Only trong lib/permissions.mjs');
  }
}

async function bumpPackageVersion(pkgPath, newVersion = '3.1.0') {
  if (!(await fileExists(pkgPath))) return;
  const raw = await fs.readFile(pkgPath, 'utf8');
  const updated = raw.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${newVersion}"`);
  if (updated !== raw) {
    await fs.writeFile(pkgPath, updated, 'utf8');
    console.log(`  [OK] Đã nâng phiên bản trong CHATMCP-HUB/package.json lên v${newVersion}`);
  }
}

async function main() {
  console.log('=== Nâng cấp Smart Context Compaction & Chuẩn bị Release v3.1.0 ===');
  const hubRoot = await resolveHubRoot();

  const srcCompaction = path.join(__dirname, 'context-compaction.mjs');
  const destCompaction = path.join(hubRoot, 'lib', 'context-compaction.mjs');
  if ((await fileExists(srcCompaction)) && path.resolve(srcCompaction) !== path.resolve(destCompaction)) {
    await fs.copyFile(srcCompaction, destCompaction);
    console.log('  [OK] Đã chép context-compaction.mjs -> CHATMCP-HUB/lib/context-compaction.mjs');
  }

  const srcTest = path.join(__dirname, 'context-compaction.test.mjs');
  const destTest = path.join(hubRoot, 'tests', 'context-compaction.test.mjs');
  if ((await fileExists(srcTest)) && path.resolve(srcTest) !== path.resolve(destTest)) {
    await fs.mkdir(path.join(hubRoot, 'tests'), { recursive: true });
    await fs.copyFile(srcTest, destTest);
    console.log('  [OK] Đã chép context-compaction.test.mjs -> CHATMCP-HUB/tests/context-compaction.test.mjs');
  }

  await patchAgentMjs(path.join(hubRoot, 'lib', 'agent.mjs'));
  await patchPermissionsMjs(path.join(hubRoot, 'lib', 'permissions.mjs'));
  await bumpPackageVersion(path.join(hubRoot, 'package.json'), '3.1.0');

  console.log('\nHoàn tất nâng cấp v3.1.0!');
}

main().catch((err) => {
  console.error('Lỗi nâng cấp:', err.message);
  process.exitCode = 1;
});
