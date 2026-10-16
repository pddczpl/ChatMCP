import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitForState } from '../../tests/e2e/hub-process.mjs';
import { say } from '../../tests/e2e/scenarios.mjs';

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
  await page.screenshot({path:testInfo.outputPath('background-tasks-light-1280.png'),fullPage:true});
});
