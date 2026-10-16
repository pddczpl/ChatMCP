import { test, expect, onboard, send, taskByPrompt } from './fixtures.mjs';
import { waitForState } from '../../tests/e2e/hub-process.mjs';
import { say, call } from '../../tests/e2e/scenarios.mjs';
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
  const blocked=await app.hub.request('POST','/api/tasks/continue',{
    id:third.id,prompt:'Should not resume after workspace detachment',
  });
  expect(blocked.status).toBe(403);

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


test('model-created workflow appears live in chat and Background Tasks with real phase agents', async ({page,app})=>{
  let reviewerStarts=0,verifierStarts=0;
  app.mock.define('phased-review',async ctx=>{
    if(ctx.prompt.includes('Workflow E2E:')){
      if(ctx.turn===0){
        if(!ctx.tools.includes('spawn_workflow'))throw new Error('Model did not receive spawn_workflow');
        return call('spawn_workflow',{
          name:'Independent review + verification',
          phases:[
            {name:'Review',agents:[
              {role:'Security',goal:'Workflow Reviewer One: inspect security evidence'},
              {role:'Correctness',goal:'Workflow Reviewer Two: inspect correctness evidence'},
            ]},
            {name:'Verify',agents:[{role:'Independent verifier',
              goal:'Workflow Verifier: validate both independent review findings'}]},
          ],
        });
      }
      return say('Đã giao workflow chạy nền. Báo cáo sẽ được kiểm chứng sau khi các subagent hoàn thành.');
    }
    if(ctx.prompt.includes('Workflow Reviewer')){
      reviewerStarts++;
      await new Promise(r=>setTimeout(r,900));
      return say('Reviewer finished with a concrete finding; no code was merged.');
    }
    if(ctx.prompt.includes('Workflow Verifier')){
      verifierStarts++;
      return say('Verifier cross-checked the earlier findings independently.');
    }
    return say('Worker reported a result.');
  });
  app.mock.setScenario('phased-review');
  await onboard(page,app);
  await page.setViewportSize({width:1280,height:900});
  const prompt='Workflow E2E: use two independent reviewers and one verifying agent.';
  await send(page,prompt);
  const parent=await taskByPrompt(app,prompt);
  await expect(page.getByTestId('chat-workflow')).toBeVisible();
  await expect(page.getByTestId('chat-workflow').getByTestId('workflow-phase')).toHaveCount(2);
  await expect(page.getByTestId('chat-workflow').getByText('Independent review + verification')).toBeVisible();
  await expect(page.getByTestId('background-workflow')).toHaveCount(1);
  const first=await app.hub.get('/api/background-tasks');
  expect(first.ok).toBe(true);
  expect(first.json.workflows).toHaveLength(1);
  const workflow=first.json.workflows[0];
  expect(workflow.conversationId).toBe(parent.id);
  expect(workflow.phases[0].agents).toHaveLength(2);
  expect(workflow.phases[1].agents).toHaveLength(1);
  expect(workflow.phases[1].dependsOn).toEqual([workflow.phases[0].id]);
  await waitForState(app.hub,parent.id,'completed');
  // Workflows remain observable AFTER the parent chat turn completes.
  await expect(page.getByTestId('chat-workflow')).toBeVisible();
  await expect.poll(async()=>{
    // The test runs in Review mode. Worktree writes must NOT bypass the real
    // Permission Gate just because an automated workflow created the agents.
    // Grant each actual pending workspace-worktree request, like a user would.
    const hub=await app.hub.state();
    for(const approval of hub.studio?.permissions?.pending||[]){
      if(approval.toolName==='local.worktrees_create'){
        await app.hub.post('/api/studio/permissions/decide',{id:approval.id,approved:true});
      }
    }
    const response=await app.hub.get('/api/background-tasks');
    return response.json.workflows?.[0]?.status;
  },{timeout:90000,intervals:[250,500,1000]}).toBe('completed');
  expect(reviewerStarts).toBe(2);
  expect(verifierStarts).toBe(1);
  const final=(await app.hub.get('/api/background-tasks')).json.workflows[0];
  expect(final.completed).toBe(3);
  expect(final.phases.every(p=>p.status==='completed')).toBe(true);
  await expect(page.getByTestId('chat-workflow').getByText('3/3 completed')).toBeVisible();
  await expect(page.getByTestId('background-workflow')).toHaveCount(1);
  await expect(page.getByTestId('background-workflow').getByText('Review')).toBeVisible();
  await expect(page.getByTestId('background-workflow').getByText('Verify')).toBeVisible();
});
