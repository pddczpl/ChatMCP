import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitForState } from '../../tests/e2e/hub-process.mjs';
import { say } from '../../tests/e2e/scenarios.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

// The legacy Inspector -> "Trợ lý" form was intentionally removed.
// Background agents are now ordinary conversations, dispatched from chat,
// with independent task state, a shared background panel and Git selection.
test('Background tasks supports new chats, Git choices, attachment previews and independent task history', async ({page,app},testInfo)=>{
  app.mock.define('background-workspace',()=>say('Hoàn thành yêu cầu trong cuộc trò chuyện riêng.'));
  app.mock.setScenario('background-workspace');
  await onboard(page,app);
  await page.setViewportSize({width:1280,height:900});
  const tasks=page.getByRole('button',{name:'Background tasks',exact:true});
  await expect(tasks).toBeVisible();
  await expect(tasks).toHaveAttribute('aria-pressed','true');
  await expect(page.getByText('Chưa có công việc nền.',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Inspector',exact:true})).toBeVisible();

  const workspaceButton=page.locator('button[title^="Thư mục:"]');
  await expect(workspaceButton).toHaveCSS('background-color','rgb(24, 32, 43)');
  await page.getByRole('button',{name:'Chuyển theme sáng / tối',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await expect(workspaceButton).toHaveCSS('background-color','rgb(241, 245, 249)');

  // Users can choose the source branch directly, no terminal command needed.
  const picker=page.getByRole('button',{name:'Chọn nhánh Git và worktree'});
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByLabel('Nhánh nguồn Git')).toBeVisible();
  await expect(page.getByLabel('Nhánh nguồn Git')).toContainText('HEAD hiện tại');
  await picker.click();

  // A pasted screenshot must appear as a removable attachment; never start an
  // AI model request merely from pasting a file in the editor.
  const before=app.mock.state.requests.length;
  await page.locator('textarea').evaluate(el=>{
    const transfer=new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137,80,78,71])],'screen.png',{type:'image/png'}));
    el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  });
  await expect(page.getByLabel('Tệp đính kèm').getByText('screen.png')).toBeVisible();
  expect(app.mock.state.requests.length).toBe(before);
  await page.getByRole('button',{name:'Bỏ screen.png'}).click();
  await expect(page.getByText('screen.png')).toHaveCount(0);

  const prompt1='Please inspect the workspace.';
  await send(page,prompt1);
  const first=await taskByPrompt(app,prompt1);
  await waitForState(app.hub,first.id,'completed');
  await expect(page.getByText('Hoàn thành yêu cầu trong cuộc trò chuyện riêng.')).toBeVisible();
  await expect(page.getByText(prompt1,{exact:false}).first()).toBeVisible();

  // New chat is allowed even while an older chat stays in the sidebar;
  // completed sessions remain separate and can be navigated independently.
  await page.getByRole('button',{name:'Hội thoại mới',exact:true}).click();
  await expect(page.locator('textarea')).toHaveValue('');
  const prompt2='Please summarize the repository.';
  await send(page,prompt2);
  const second=await taskByPrompt(app,prompt2);
  await waitForState(app.hub,second.id,'completed');
  expect(second.id).not.toBe(first.id);
  expect((await app.hub.state()).agent.tasks).toHaveLength(2);
  const panel=page.getByText('2 tác vụ',{exact:false});
  await expect(page.getByTestId('background-task')).toHaveCount(2);
  await expect(panel).toBeVisible();
  // The second workspace is a distinct folder with its own chat list.
  // Running a task there must never redirect the original Hub manager.
  const other=path.join(app.scratch,'second-workspace');
  await fs.mkdir(other,{recursive:true});
  await fs.writeFile(path.join(other,'README.md'),'# Second workspace\n');
  await app.hub.post('/api/workspaces/add',{path:other});
  await expect(page.getByRole('button',{name:'second-workspace',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'second-workspace',exact:true}).click();
  await page.getByRole('button',{name:'Hội thoại mới',exact:true}).click();
  const thirdPrompt='Summarize another workspace independently.';
  await send(page,thirdPrompt);
  const third=await taskByPrompt(app,thirdPrompt);
  await waitForState(app.hub,third.id,'completed');
  expect(third.workspacePath).toBe(await fs.realpath(other));
  expect((await app.hub.state()).workspace.path).toBe(app.project);
  await expect(page.getByTestId('background-task')).toHaveCount(3);
  await expect(page.getByTestId('background-workspace')).toHaveCount(2);
  await expect(page.getByTestId('background-conversation')).toHaveCount(3);
  await expect(page.getByTestId('background-task').filter({hasText:thirdPrompt}))
    .toHaveAttribute('data-workspace',await fs.realpath(other));

  // Workspace removal archives its association. No host directory, source file
  // or conversation record is removed; re-adding restores the task links.
  page.once('dialog',dialog=>void dialog.accept());
  await page.getByRole('button',{name:'Gỡ workspace second-workspace'}).click();
  await expect(page.getByRole('button',{name:'second-workspace',exact:true})).toHaveCount(0);
  await expect(page.getByTestId('background-task')).toHaveCount(2);
  expect((await fs.stat(path.join(other,'README.md'))).isFile()).toBe(true);
  const detached=await app.hub.get('/api/workspaces');
  const detachedPath=await fs.realpath(other);
  expect(detached.json.items.some(w=>w.path===detachedPath)).toBe(false);
  expect((await app.hub.task(third.id)).id).toBe(third.id);

  await app.hub.post('/api/workspaces/add',{path:other});
  await expect(page.getByRole('button',{name:'second-workspace',exact:true})).toBeVisible();
  await expect(page.getByTestId('background-task')).toHaveCount(3);

  // Each workspace shows an always-visible conversation delete control. Its
  // target and all its subagent records are removed from ChatMCP only.
  page.once('dialog',dialog=>void dialog.accept());
  await page.getByRole('button',{name:'Xóa hội thoại: '+prompt1}).click();
  await expect(page.getByRole('button',{name:'Xóa hội thoại: '+prompt1})).toHaveCount(0);
  await expect(page.getByTestId('background-task')).toHaveCount(2);
  expect((await app.hub.get('/api/tasks/'+encodeURIComponent(first.id))).status).toBe(404);
  expect((await fs.stat(path.join(app.project,'README.md'))).isFile()).toBe(true);
  await page.screenshot({path:testInfo.outputPath('background-tasks-light-1280.png'),fullPage:true});
});
