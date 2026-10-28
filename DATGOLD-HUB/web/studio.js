/* ChatMCP Studio 2.0 code panel. No dynamic HTML injection; source/tool text
   is displayed via textContent. Browser scripts never receive the API key. */
'use strict';
(() => {
  const $=id=>document.getElementById(id);
  if(!$('studio-shell'))return;
  let state=null, cwd='', file='', fileSha='', selectedCheckpoint='', reviewData=null, planItems=[], currentTerminal=null, tab='files';
  let busy=false, updateBusy=false, lastApprovals='', lastTerminal='', lastWorkspace='', lastPlanId='', lastDelegates='';
  let lastRecoveryTask = null;
  const selectedTask=()=>document.querySelector('.session-entry.is-selected')?.dataset.sessionId || $('task-history')?.value || null;
  const N=(tag,className,text)=>{const x=document.createElement(tag);if(className)x.className=className;if(text!==undefined)x.textContent=String(text);return x;};
  const notify=(message,bad=false)=>{const x=$('studio-status');x.textContent=message;x.classList.toggle('studio-error',bad);};
  async function request(route,data){
    const options=data===undefined?{method:'GET',cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-ChatMCP-CSRF':state?.csrfToken||'','X-ChatMCP-Request':'local-dashboard'},body:JSON.stringify(data)};
    const response=await fetch(route,{credentials:'same-origin',...options});const json=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
    if(!response.ok)throw Error(json.error || `HTTP ${response.status}`);
    return json;
  }
  const qs=(endpoint,fields)=>endpoint+'?'+new URLSearchParams(fields).toString();
  async function action(label,handler){if(busy)return;busy=true;notify(label);try{await handler();notify('Sẵn sàng · '+new Date().toLocaleTimeString());}catch(e){notify(e.message,true);}finally{busy=false;}}
  function button(label,callback,css='studio-mini-button'){const b=N('button',css,label);b.type='button';b.addEventListener('click',()=>void callback());return b;}
  const selectTab=(next)=>{
    tab=next;document.querySelectorAll('[data-studio-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.studioTab===next)));
    document.querySelectorAll('#studio-shell .studio-tab').forEach(x=>x.hidden=x.id!==`studio-${next}`);
    if(next==='files')void loadTree();if(next==='git')void loadGit();if(next==='plan')void loadPlan();if(next==='skills')void loadSkills();if(next==='terminal')void loadTerminal();if(next==='delegates')void loadDelegates();
  };
  document.querySelectorAll('[data-studio-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.studioTab)));
  async function loadTree(){
    if(!state?.studio?.workspace)return;
    await action('Đang đọc cây file...',async()=>{
      const data=await request(qs('/api/studio/tree',{directory:cwd,limit:320}));
      $('studio-dir').textContent=data.directory||'/';
      const entries=data.entries.map(e=>{
        const li=N('li');const b=button(`${e.kind==='directory'?'▸':e.kind==='symlink'?'↪':'▤'}  ${e.name}`,async()=>{
          if(e.kind==='directory'){cwd=e.path;await loadTree();}else if(e.kind==='file')await openFile(e.path);
        },'studio-file-entry');if(e.kind==='directory')b.classList.add('is-directory');li.append(b);return li;
      });
      $('studio-tree').replaceChildren(...entries);if(data.truncated)$('studio-tree').append(N('li','studio-muted','Giới hạn hiển thị '+entries.length+' mục.'));
    });
  }
  async function openFile(path){await action('Đang đọc '+path,async()=>{
    const data=await request(qs('/api/studio/file',{file:path,maxBytes:230000}));
    file=path;fileSha=data.sha256;$('studio-editor-text').value=data.content;stopEditing();$('studio-open-file').textContent=data.path;$('studio-code-meta').textContent=`${data.size} bytes · SHA ${data.sha256.slice(0,12)}`;
    $('studio-code').textContent=data.content;
    $('studio-preview').textContent=/\.(?:md|html|css|json|svg)$/i.test(data.path)?data.content.slice(0,16000):'Chỉ đọc. Xem code ở giữa.';
  });}
  function stopEditing(){ $('studio-editor-text').hidden=true;$('studio-code').hidden=false;$('studio-edit-save').hidden=true;$('studio-edit-cancel').hidden=true;$('studio-edit-toggle').hidden=false; }
  function startEditing(){if(!file||!fileSha)return notify('Chọn file trước.',true);$('studio-editor-text').hidden=false;$('studio-code').hidden=true;$('studio-edit-save').hidden=false;$('studio-edit-cancel').hidden=false;$('studio-edit-toggle').hidden=true;}
  async function saveEditing(){if(!file||!fileSha)return;const content=$('studio-editor-text').value;
    if(!confirm(`Lưu thay đổi vào ${file}? Hub sẽ tạo checkpoint trước khi ghi và từ chối nếu file đã thay đổi trên ổ đĩa.`))return;
    await action('Đang lưu file với checkpoint...',async()=>{const updated=await request('/api/studio/file/save',{file,content,expectedSha:fileSha});if(!updated.ok)throw Error('Không thể lưu file');await openFileAfterSave(file);});
  }
  async function openFileAfterSave(path){const data=await request(qs('/api/studio/file',{file:path,maxBytes:300000}));fileSha=data.sha256;$('studio-code').textContent=data.content;$('studio-editor-text').value=data.content;$('studio-code-meta').textContent=`${data.size} bytes · SHA ${data.sha256.slice(0,12)}`;stopEditing();}
  async function search(){await action('Đang tìm kiếm trong workspace...',async()=>{
    const data=await request(qs('/api/studio/search',{query:$('studio-query').value.trim(),mode:$('studio-search-mode').value,limit:90}));
    const content=$('studio-search-results');content.replaceChildren();
    content.append(N('div','studio-muted',`${data.matches.length} kết quả · ${data.scannedFiles} file đã quét${data.partialScan?' · có thể chưa đầy đủ':''}`));
    for(const match of data.matches){const b=button(`${match.path}${match.line?':'+match.line:''}\n${match.text}`,()=>openFile(match.path),'studio-result');content.append(b);}
  });}
  async function loadGit(){if(!state?.studio?.workspace)return;await action('Đang đọc Git...',async()=>{
    const data=await request('/api/studio/git/status');const entries=data.entries||[];
    $('studio-git-output').textContent=`HEAD: ${data.head||'(no commit)'}\n${entries.length?entries.join('\n'):'Working tree clean.'}`;
    await loadCheckpoints();
  });}
  async function loadCheckpoints(){const cps=await request('/api/studio/checkpoints');const el=$('studio-checkpoint-select');
    el.replaceChildren(N('option','',cps.length?'Chọn checkpoint':'Chưa có checkpoint'));
    for(const cp of cps){const o=N('option','',`${new Date(cp.at).toLocaleString()} · ${cp.label} · ${cp.fileCount} files${cp.partial?' · partial':''}`);o.value=cp.id;el.append(o);}
    if(selectedCheckpoint&&cps.some(c=>c.id===selectedCheckpoint))el.value=selectedCheckpoint;else{selectedCheckpoint=cps[0]?.id||'';if(selectedCheckpoint)el.value=selectedCheckpoint;}
  }
  async function loadDiff(){await action('Đang đọc Git diff...',async()=>{const data=await request('/api/studio/git/diff');$('studio-git-output').textContent=data.diff || 'Không có unstaged diff của tracked files. File mới xem trong Git Status.';});}
  async function loadReview(){if(!selectedCheckpoint)return notify('Tạo hoặc chọn checkpoint trước.',true);
    await action('Đang so sánh với checkpoint...',async()=>{
      reviewData=await request(qs('/api/studio/review',{checkpointId:selectedCheckpoint}));
      const panel=$('studio-review-results');panel.replaceChildren();
      panel.append(N('p','studio-muted',`${reviewData.changes.length} file khác snapshot · ${reviewData.partial?'Backup có giới hạn; không khôi phục các file chưa được chụp.':'Snapshot đầy đủ'}`));
      for(const c of reviewData.changes){
        const card=N('div','studio-review-card');card.append(N('div','studio-review-path',`${c.status.toUpperCase()} · ${c.path}`));
        if(c.diff){const d=N('pre','studio-review-diff',c.diff);card.append(d);}
        if(c.currentSha&&c.baselineSha){
          card.append(button('✓ Accept',()=>action('Đang đánh dấu đã review...',async()=>{await request('/api/studio/accept',{checkpointId:selectedCheckpoint,file:c.path,expectedSha:c.currentSha});notify('Đã chấp nhận '+c.path);}), 'studio-mini-button studio-accept'));
          card.append(button('↶ Reject / Restore',()=>{if(!confirm(`Khôi phục riêng ${c.path} về bản checkpoint?\nKhông ảnh hưởng file khác.`))return;
            void (async()=>{await action('Đang khôi phục...',async()=>{await request('/api/studio/restore',{checkpointId:selectedCheckpoint,file:c.path,expectedSha:c.currentSha});});await loadReview();})();},'studio-mini-button studio-danger'));
        }
        panel.append(card);
      }
    });
  }
  async function loadTerminal(){const list=await request('/api/studio/terminal');
    const data=(currentTerminal&&list.find(x=>x.id===currentTerminal))||list.at(-1);
    if(!data){$('studio-terminal-output').textContent='Chưa có phiên terminal.';return;}
    currentTerminal=data.id;const logs=(data.logs||[]).map(x=>`[${x.type}] ${x.message}`).join('');
    const value=`${data.status} · exit=${data.exitCode??'...'}\n$ ${data.command}\n${logs}`;
    if(lastTerminal!==value){$('studio-terminal-output').textContent=value;$('studio-terminal-output').scrollTop=$('studio-terminal-output').scrollHeight;lastTerminal=value;}
  }
  async function loadPlan(){const taskId=selectedTask();if(!taskId)return;
    await action('Đang nạp kế hoạch...',async()=>{const data=await request(qs('/api/studio/plan',{taskId}));lastPlanId=taskId;planItems=data.items||[];$('studio-plan-title').value=data.title||'';renderPlan();await loadWorkflow(taskId);});
  }
  async function loadWorkflow(taskId=selectedTask()){
    if(!taskId)return;try{const data=await request(qs('/api/studio/workflow',{taskId}));const list=$('studio-workflow-timeline');list.replaceChildren();
    if(!data.steps?.length)list.append(N('li','studio-muted','Chưa có lời gọi công cụ được Hub ghi nhận.'));
    for(const e of (data.steps||[]).slice(-20)){const li=N('li','studio-workflow-item');li.append(N('span','',new Date(e.at).toLocaleTimeString()+' · '+e.type+' · '+e.toolName+(e.isError?' · LỖI':'')));list.append(li);} }catch(e){notify(e.message,true);} }
  function renderPlan(){const list=$('studio-plan-items');list.replaceChildren();
    for(const [i,item] of planItems.entries()){
      const li=N('li');const select=N('select');for(const key of ['todo','doing','done','blocked']){const o=N('option','',key);o.value=key;select.append(o);}select.value=item.status;select.addEventListener('change',()=>planItems[i].status=select.value);
      const input=N('input');input.value=item.text;input.maxLength=500;input.addEventListener('change',()=>planItems[i].text=input.value);
      const del=button('×',()=>{planItems.splice(i,1);renderPlan();},'studio-icon-button');li.append(select,input,del);list.append(li);
    }
  }
  async function savePlan(){const taskId=selectedTask();if(!taskId)return notify('Chọn một hội thoại đã lưu trước.',true);
    await action('Đang lưu plan...',async()=>{await request('/api/studio/plan/set',{taskId,title:$('studio-plan-title').value,items:planItems});});
  }
  async function loadSkills(){if(!state?.studio?.workspace)return;await action('Đang đọc hướng dẫn dự án...',async()=>{
    const data=await request('/api/studio/skills');$('studio-skills-output').textContent=(data.skills||[]).map(x=>`### ${x.path} (${x.sha256.slice(0,12)})\n${x.text}`).join('\n\n')||'Không tìm thấy file hướng dẫn trong danh sách kiểm tra.';
  });}
  async function loadDelegates(){const data=await request('/api/studio/delegates');
    const signature=JSON.stringify(data?.last||{});if(signature!==lastDelegates){lastDelegates=signature;$('studio-delegate-output').textContent=(data?.last?.workers||[]).map(x=>`Worker #${x.id}: ${x.status}\nQuestion: ${x.question}\n${x.summary||'(chưa có kết quả)'}`).join('\n\n')||'Chưa có research subagent nào.';}
  }
  function approvals(pending){const signature=JSON.stringify(pending.map(x=>[x.id,x.toolName,x.reason]));if(signature===lastApprovals)return;lastApprovals=signature;
    const panel=$('studio-approvals');panel.hidden=pending.length===0;panel.replaceChildren();
    if(pending.length)panel.append(N('h3','',`⚠ ${pending.length} yêu cầu xác nhận thực thi`));
    for(const p of pending){const box=N('article','studio-approval');box.append(N('strong','',p.toolName));box.append(N('p','studio-muted',`${p.category} · ${p.reason}`));box.append(N('pre','studio-approval-preview',p.preview));
      box.append(button('Cho phép lần này',()=>action('Đang phê duyệt...',async()=>{await request('/api/studio/permissions/decide',{id:p.id,approved:true});lastApprovals='';}), 'studio-mini-button studio-primary'));
      box.append(button('Từ chối',()=>action('Đang từ chối...',async()=>{await request('/api/studio/permissions/decide',{id:p.id,approved:false});lastApprovals='';}), 'studio-mini-button studio-danger'));panel.append(box);
    }
  }
  async function poll(){if(updateBusy)return;updateBusy=true;try{
    const next=await request('/api/state');state=next;
    const current=state.studio?.workspace||'';
    $('studio-project').textContent=current?current.split(/[\\/]/).at(-1):'Chọn workspace';
    if(lastWorkspace!==current){lastWorkspace=current;cwd='';file='';if(current)void loadTree();}
    const mode=state.studio?.permissions?.mode||'review';if($('studio-permission-mode').value!==mode)$('studio-permission-mode').value=mode;
    approvals(state.studio?.permissions?.pending||[]);
    const recoverTask=selectedTask();
    const recoverValue=state.agent?.tasks?.find(x=>x.id===recoverTask);
    const recoverCheck=$('studio-auto-resume');
    recoverCheck.disabled=!recoverTask || !recoverValue;
    if (lastRecoveryTask!==recoverTask || document.activeElement!==recoverCheck){
      recoverCheck.checked=!!recoverValue?.autoResume;
      lastRecoveryTask=recoverTask;
    }
    if(tab==='terminal')await loadTerminal();
    if(tab==='plan'&&selectedTask()!==lastPlanId)await loadPlan();
    if(tab==='delegates')await loadDelegates();
  }catch(e){notify('Mất kết nối Hub: '+e.message,true);}finally{updateBusy=false;}}
  $('studio-refresh').addEventListener('click',()=>{void poll();if(tab==='files')void loadTree();if(tab==='git')void loadGit();});
  $('studio-edit-toggle').addEventListener('click',startEditing);$('studio-edit-cancel').addEventListener('click',()=>{stopEditing();$('studio-editor-text').value=$('studio-code').textContent;});$('studio-edit-save').addEventListener('click',()=>void saveEditing());
  $('studio-up').addEventListener('click',()=>{cwd=cwd.split('/').slice(0,-1).join('/');void loadTree();});
  $('studio-search-button').addEventListener('click',()=>void search());$('studio-query').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void search();}});
  $('studio-git-refresh').addEventListener('click',()=>void loadGit());$('studio-git-diff').addEventListener('click',()=>void loadDiff());
  $('studio-git-check').addEventListener('click',()=>void action('Đang kiểm tra diff...',async()=>{$('studio-git-output').textContent=JSON.stringify(await request('/api/studio/git/check'),null,2);}));
  $('studio-checkpoint').addEventListener('click',()=>{const label=prompt('Tên checkpoint (không thay đổi file dự án):','Before coding changes');if(label===null)return;void action('Đang tạo checkpoint...',async()=>{const cp=await request('/api/studio/checkpoint',{label});selectedCheckpoint=cp.id;await loadCheckpoints();notify(`Đã lưu ${cp.fileCount} file · ${cp.partial?'partial backup':'backup'}`);});});
  $('studio-checkpoint-select').addEventListener('change',()=>selectedCheckpoint=$('studio-checkpoint-select').value);
  $('studio-review').addEventListener('click',()=>void loadReview());
  $('studio-run-command').addEventListener('click',()=>{const cmd=$('studio-command').value.trim();if(!cmd)return;if(!confirm(`Lệnh này sẽ chạy với quyền tài khoản hệ điều hành, KHÔNG phải sandbox.\n\n${cmd}\n\nBạn có chắc chắn muốn chạy?`))return;
    void action('Đang chạy lệnh...',async()=>{const data=await request('/api/studio/terminal/start',{command:cmd,timeoutMinutes:15});currentTerminal=data.id;await loadTerminal();});});
  $('studio-stop-command').addEventListener('click',()=>{if(!currentTerminal)return;void action('Đang dừng terminal...',async()=>await request('/api/studio/terminal/stop',{id:currentTerminal}));});
  $('studio-auto-resume').addEventListener('change',()=>{
    const taskId=selectedTask(),enabled=$('studio-auto-resume').checked;
    if(!taskId){$('studio-auto-resume').checked=false;return notify('Chọn hội thoại trước.',true);}
    void action('Đang lưu tùy chọn khôi phục...',async()=>{
      await request('/api/tasks/auto-resume',{id:taskId,enabled});
      notify(enabled?'Đã bật tự tiếp tục có kiểm tra cho hội thoại này.':'Đã tắt tự tiếp tục khi Hub khởi động lại.');
      await poll();
    });
  });
  $('studio-plan-refresh').addEventListener('click',()=>void loadPlan());
  $('studio-plan-add').addEventListener('click',()=>{const t=$('studio-plan-new').value.trim();if(!t)return;planItems.push({text:t,status:'todo',evidence:''});$('studio-plan-new').value='';renderPlan();});
  $('studio-plan-save').addEventListener('click',()=>void savePlan());
  $('studio-checks').addEventListener('click',()=>void action('Đang tìm lệnh kiểm thử...',async()=>{$('studio-check-output').textContent=JSON.stringify(await request('/api/studio/checks'),null,2);}));
  $('studio-skills-refresh').addEventListener('click',()=>void loadSkills());
  $('studio-delegate-start').addEventListener('click',()=>{const queries=$('studio-delegate-queries').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!queries.length)return;
    if(!confirm(`Chạy ${queries.length} lời gọi model API riêng (có thể phát sinh phí), chỉ phân tích code, không sửa file?`))return;
    void action('Đang chạy research delegates...',async()=>{const data=await request('/api/studio/delegates/research',{queries,taskId:selectedTask()});$('studio-delegate-output').textContent=data.workers.map(x=>`${x.question}\n${x.summary||x.status}`).join('\n\n');});});
  $('studio-permission-mode').addEventListener('change',()=>{
    const mode=$('studio-permission-mode').value;
    if(mode==='autonomous'&&!confirm('Autonomous cho phép tool ghi file tự động trong workspace. Lệnh shell, thao tác phá huỷ và tool không rõ vẫn cần xác nhận. Tiếp tục?')){ $('studio-permission-mode').value=state?.studio?.permissions?.mode||'review';return;}
    void action('Đang đổi quyền...',async()=>await request('/api/studio/permissions/config',{mode}));
  });
  void poll();setInterval(()=>void poll(),2500);
})();
