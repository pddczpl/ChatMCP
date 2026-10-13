import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, onboard } from './fixtures.mjs';
import { PluginManager } from '../../lib/plugins.mjs';

test('Skills show real install state, correct toggle actions, removal and persisted registry imports', async ({ page, app }, testInfo) => {
  // Seed one downloaded registry skill using the real manager, without making
  // this UI regression depend on GitHub or an external model. All UI actions
  // below use the real Hub routes and persistent plugin state, not route mocks.
  await app.hub.stop();
  const manager = new PluginManager({ stateDir: app.hub.stateDir });
  await manager.load();
  const revision = 'a'.repeat(40);
  const registrySkill = {
    id: 'anthropic-ui-fixture', name: 'Kỹ năng kiểm thử giao diện', key: 'anthropic:skills/ui-fixture',
    repo: 'anthropics/skills', sourceId: 'anthropic', folder: 'skills/ui-fixture', manifestPath: 'skills/ui-fixture/SKILL.md',
    description: 'Hướng dẫn trợ lý kiểm tra tính dễ dùng của giao diện.', revision, license: 'unknown',
  };
  await manager.importRegistrySkill({ ...registrySkill, commitSha: revision,
    sourceUrl: `https://raw.githubusercontent.com/anthropics/skills/${revision}/skills/ui-fixture/SKILL.md`,
    systemPrompt: 'Review interface clarity.', originalSkillText: '---\nname: ui-fixture\n---\nReview interface clarity.',
  });
  await fs.writeFile(path.join(app.hub.stateDir, 'registry-index.json'), JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), entries: [registrySkill] }));
  await app.restart();
  await expect.poll(async () => (await app.hub.get('/api/plugins/registry')).json.skills.map((skill) => skill.id)).toContain(registrySkill.id);
  await onboard(page, app);
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kỹ năng cho trợ lý' })).toBeVisible();

  const git = page.getByRole('article', { name: 'Git Workflow Pro', exact: true });
  await expect(git).toContainText('Đã cài · Đang bật');
  await git.getByRole('button', { name: 'Tắt', exact: true }).click();
  await expect(git).toContainText('Đã cài · Đang tắt');
  await expect(git.getByRole('button', { name: 'Bật', exact: true })).toBeEnabled();
  await git.getByRole('button', { name: 'Bật', exact: true }).click();
  await expect(git).toContainText('Đã cài · Đang bật');
  await git.getByRole('button', { name: 'Gỡ cài đặt', exact: true }).click();
  await expect(git).toContainText('Chưa cài');
  await git.getByRole('button', { name: 'Cài đặt', exact: true }).click();
  await expect(git).toContainText('Đã cài · Đang bật');
  await expect(git.getByRole('button', { name: 'Cài đặt', exact: true })).toHaveCount(0);
  expect((await app.hub.get('/api/plugins/installed')).json.plugins.filter((skill) => skill.id === 'git-workflow-pro')).toHaveLength(1);

  const imported = page.getByRole('article', { name: registrySkill.name, exact: true });
  await expect(imported).toContainText('Đã cài · Đang tắt');
  await expect(imported.getByRole('button', { name: 'Cài đặt', exact: true })).toHaveCount(0);
  await imported.getByRole('button', { name: 'Bật', exact: true }).click();
  await expect(imported).toContainText('Đã cài · Đang bật');
  await page.reload();
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await expect(imported).toContainText('Đã cài · Đang bật');
  await expect(imported.getByRole('button', { name: 'Cài đặt', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Đã cài \(/ }).click();
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTitle('Chuyển theme sáng / tối').click();
    await expect(page.getByRole('banner').getByRole('button', { name: 'workspace', exact: true })).toHaveCSS('background-color', theme === 'light' ? 'rgb(241, 245, 249)' : 'rgb(24, 32, 43)');
    await page.screenshot({ path: testInfo.outputPath(`skills-${theme}.png`), animations: 'disabled' });
  }
  await imported.getByRole('button', { name: 'Tắt', exact: true }).click();
  await expect(imported).toContainText('Đã cài · Đang tắt');
  await imported.getByRole('button', { name: 'Gỡ cài đặt', exact: true }).click();
  await expect(imported).toHaveCount(0);
  expect((await app.hub.get('/api/plugins/installed')).json.plugins.some((skill) => skill.id === registrySkill.id)).toBe(false);
  await page.getByRole('button', { name: 'Khám phá', exact: true }).click();
  await page.getByLabel('Tìm kỹ năng', { exact: true }).fill(registrySkill.name);
  await expect(imported).toContainText('Chưa cài');
  await expect(imported.getByRole('button', { name: 'Cài đặt', exact: true })).toBeEnabled();

  // A custom skill is absent from the marketplace and must still appear in the
  // installed list immediately, with a working uninstall action.
  await page.getByText('Nguồn kỹ năng & tùy chỉnh', { exact: true }).click();
  await page.getByRole('button', { name: 'Thêm kỹ năng từ URL hoặc tự viết', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Tự viết', exact: true }).click();
  await dialog.getByLabel('Mã kỹ năng', { exact: true }).fill('   ');
  await dialog.getByLabel('Tên kỹ năng', { exact: true }).fill('   ');
  await dialog.getByRole('button', { name: 'Cài kỹ năng', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Mã kỹ năng', { exact: true }).fill('ui-custom-guidance');
  await dialog.getByLabel('Tên kỹ năng', { exact: true }).fill('Hướng dẫn riêng');
  await dialog.getByLabel('Hướng dẫn cho trợ lý', { exact: true }).fill('Trả lời ngắn gọn, dễ hiểu.');
  await dialog.getByRole('button', { name: 'Cài kỹ năng', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const custom = page.getByRole('article', { name: 'Hướng dẫn riêng', exact: true });
  await expect(custom).toContainText('Đã cài · Đang bật');
  await custom.getByRole('button', { name: 'Gỡ cài đặt', exact: true }).click();
  await expect(custom).toHaveCount(0);
});
