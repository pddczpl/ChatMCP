/* ChatMCP Studio — React dashboard. No CDN or build step is required at runtime.
 * All state mutations go through localhost HTTP with CSRF; all model/tool data
 * is rendered as text, never HTML or remotely-supplied executable content. */
'use strict';
(function () {
  if (!window.React || !window.ReactDOM) {
    document.getElementById('root').textContent = 'Không nạp được React. Kiểm tra bộ cài và làm mới trang bằng Ctrl+F5.';
    return;
  }
  const UI = window.ChatMcpUi;
  const Onboarding = window.ChatMcpOnboarding;
  if (!UI || !Onboarding) {
    document.getElementById('root').textContent = 'Không nạp được ui-logic.js hoặc onboarding.js. Hãy cập nhật đầy đủ thư mục web/ rồi làm mới trang bằng Ctrl+F5.';
    return;
  }
  const R = window.React;
  const h = R.createElement;
  const BUILD = '3.2.0-react-agent';
  const uiVersion = '3.2.0';
  const themeStore = {get(){try{return localStorage.getItem('chatmcp:theme')||'dark';}catch{return 'dark';}},set(v){try{localStorage.setItem('chatmcp:theme',v);}catch{}}};
  const applyTheme=v=>{const resolved=v==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):v;document.documentElement.setAttribute('data-theme',resolved);};
  applyTheme(themeStore.get());
  const serviceNames = { docker: 'Docker', cloud: 'Cloud Harness', proxy: 'MCP Proxy', desktop: 'Desktop Commander' };
  const statusKind = status => ['completed','ready'].includes(status) ? 'success' : ['running','preparing','starting','queued'].includes(status) ? 'working' : ['failed','error','interrupted'].includes(status) ? 'error' : 'neutral';
  const arr = x => Array.isArray(x) ? x : [];
  const str = (x, fallback='') => typeof x === 'string' ? x : fallback;
  const formatTime = s => { const v = new Date(s); return Number.isNaN(v.getTime()) ? '' : v.toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'}); };
  const shortPath = s => str(s).split(/[\\/]/).filter(Boolean).pop() || 'Chưa chọn workspace';
  const params = (route, pairs) => route + '?' + new URLSearchParams(pairs).toString();
  const onboardingStore = {get(){try{return localStorage.getItem('chatmcp:onboarding-dismissed')==='1';}catch{return false;}},set(v){try{if(v)localStorage.setItem('chatmcp:onboarding-dismissed','1');else localStorage.removeItem('chatmcp:onboarding-dismissed');}catch{}}};
  const sessionStore = {get(){try{return localStorage.getItem('chatmcp:selected-conversation')||'';}catch{return '';}},set(id){try{if(id)localStorage.setItem('chatmcp:selected-conversation',id);else localStorage.removeItem('chatmcp:selected-conversation');}catch{}}};
  const Icon = ({name,size=17}) => {
    const paths = {
      code:'M8 4 3 9l5 5 M16 4l5 5-5 5 M14 2l-4 14',
      bot:'M12 3v3 M7 6h10a3 3 0 0 1 3 3v9H4V9a3 3 0 0 1 3-3z M8 12h.01 M16 12h.01 M9 16h6',
      folder:'M3 6h6l2 2h10v12H3z', file:'M6 2h8l5 5v15H6z M14 2v6h5',
      git:'M6 3v12a4 4 0 0 0 4 4h8 M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M18 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
      terminal:'M4 5l6 6-6 6 M12 18h9',
      settings:'M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M19.1 4.9L17 7 M7 17l-2.1 2.1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
      history:'M3 12a9 9 0 1 1 3 6 M3 5v7h7 M12 7v5l4 2',
      check:'M4 12l5 5L20 6',
      x:'M5 5l14 14 M19 5L5 19',
      search:'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M17 17l5 5',
      play:'M7 4l13 8-13 8z',
      stop:'M6 6h12v12H6z',
      refresh:'M21 9A9 9 0 0 0 5 6L2 9 M2 3v6h6 M3 15a9 9 0 0 0 16 3l3-3 M22 21v-6h-6',
      plus:'M12 3v18 M3 12h18',
      trash:'M4 7h16 M9 7V4h6v3 M7 7l1 14h8l1-14',
      shield:'M12 2l9 4v6c0 6-4 9-9 10-5-1-9-4-9-10V6z M8 12l3 3 5-6',
      arrow:'M5 12h14 M13 6l6 6-6 6',
      chevron:'M5 9l7 7 7-7',
      external:'M14 3h7v7 M21 3l-9 9 M18 13v8H3V6h8',
      save:'M5 3h13l3 3v15H3V3z M7 3v7h9V3 M7 21v-8h10v8',
      spark:'M12 2l2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3z',
      note:'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',
      wifi:'M2 9a16 16 0 0 1 20 0 M5 13a11 11 0 0 1 14 0 M9 17a5 5 0 0 1 6 0 M12 21h.01',
      warning:'M12 3L2 21h20z M12 9v5 M12 18h.01',
      sun:'M12 2v2 M12 20v2 M4.93 4.93l1.42 1.42 M17.65 17.65l1.42 1.42 M2 12h2 M20 12h2 M4.93 19.07l1.42-1.42 M17.65 6.35l1.42-1.42 M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
      moon:'M20.7 14.6A9 9 0 0 1 9.4 3.3 9 9 0 1 0 20.7 14.6z',
      panel:'M3 4h18v16H3z M9 4v16',
      layers:'M12 3l9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
      eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
      lock:'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
      key:'M14 10a4 4 0 1 0-3.9 4H12l1 1h2v2h2v2h3v-3l-6-6z M8 10h.01'
    };
    return h('svg',{className:'icon',width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':'true'},h('path',{d:paths[name]||paths.note}));
  };
  function Button({children,onClick,variant='',disabled=false,title='',icon=null,className=''}) {
    return h('button',{type:'button',title,onClick,disabled,className:`btn ${variant?'btn-'+variant:''} ${className}`.trim()},icon&&h(Icon,{name:icon,size:15}),children);
  }
  function Tag({children,kind='neutral',title}) {return h('span',{className:'tag tag-'+kind,title},children);}
  function Empty({icon='note',title,body}) {return h('div',{className:'empty'},h('div',{className:'empty-symbol'},h(Icon,{name:icon,size:22})),h('strong',null,title),h('p',null,body));}
  function Section({title,action,children}) {return h('section',{className:'section'},h('div',{className:'section-head'},h('h3',null,title),action),children);}
  class StudioApp extends R.Component {
    constructor(props) {
      super(props);
      this.state = {
        hub:null, health:null, serverMismatch:false, connected:false, toast:null, busy:'', paletteOpen:false,paletteQuery:'',
        selectedId:sessionStore.get(), selectedTask:null,
        sessionQuery:'',prompt:'',tab:'activity',workspaceDraft:'',apiDraft:UI.draftFromState(null),
        presets:[],envKeys:[],models:[],modelSource:'',modelWarning:'',modelsLoading:false,testResult:null,
        onboardingOpen:false,onboardingStep:'workspace',onboardingDismissed:onboardingStore.get(),livePlan:null,workflow:null,now:Date.now(),
        workspaceFolder:'',fileEntries:[],file:null,editing:false,fileDraft:'',codeQuery:'',codeSearchMode:'text',codeMatches:[],
        gitStatus:null,gitDiff:null,checkpoints:[],checkpointId:'',review:null,
        terminalCommand:'',terminals:[],currentTerminalId:'',suggestedChecks:[],verificationRuns:[],
        plan:{title:'',items:[]},skills:[],delegates:[],delegateQuery:'',
        permissionMode:'review',executionPolicy:'host-review',pairCode:'',pairedExpiresAt:'',
        theme:themeStore.get(),inspectorOpen:true,
        terminalSandbox:false,terminalInteractive:false,terminalInput:'',sandboxStatus:null,terminalCaps:null,
        indexState:null,indexQuery:'',indexMatches:[],referenceMatches:[],definitionMatches:[],lspLanguage:'python',lspFile:'',lspLine:1,lspColumn:1,lspResult:null,
        previewPort:'5173',previewPath:'/',previewInfo:null,
        wsList:null,wsCloneUrl:'',wsCloneBranch:'',wsNewName:'',wsPushBranch:'',wsPushed:null,
        showSettings:false
      };
      this.alive=false;this.polling=false;this.taskLoadingIds=new Set();this.lastTaskKey='';this.warmTask='';
      this.pollTimer=null;this.noticeTimer=null;this.terminalStream=null;this.streamRefresh=null;
      this.fileLoadSerial=0;
      this.reactAppVersion=uiVersion;
    }
    componentDidMount(){this.alive=true;this.keyboard=e=>this.onKeyDown(e);window.addEventListener('keydown',this.keyboard);this.bootstrap();this.schedulePoll();
      // Only the countdown on a pending approval needs a clock; nothing re-renders otherwise.
      this.tick=setInterval(()=>{if(this.pendingApprovals().length)this.set({now:Date.now()});},1000);}
    componentWillUnmount(){this.alive=false;window.removeEventListener('keydown',this.keyboard);clearTimeout(this.pollTimer);clearInterval(this.tick);clearTimeout(this.noticeTimer);clearTimeout(this.streamRefresh);this.terminalStream?.close();}
    componentDidUpdate(){if(!this.state.hub)return;const title=UI.documentTitle(this.state.hub);if(document.title!==title)document.title=title;}
    // Poll faster while the agent works or a request waits for the person; the Hub is on this machine, so it is cheap.
    schedulePoll(){clearTimeout(this.pollTimer);if(!this.alive)return;const fast=this.isRunning()||this.pendingApprovals().length>0;
      this.pollTimer=setTimeout(async()=>{try{await this.poll();}finally{this.schedulePoll();}},fast?1000:2400);}
    pendingApprovals(){return arr(this.state.hub?.studio?.permissions?.pending);}
    permMode(){return UI.normalizeMode(this.state.hub?.studio?.permissions?.mode);}
    set(patch){if(this.alive)this.setState(patch);}
    setTheme(theme){if(!['light','dark','system'].includes(theme))return;themeStore.set(theme);applyTheme(theme);this.set({theme});}
    onKeyDown(e){
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();this.set({paletteOpen:true,paletteQuery:''});return;}
      if(e.key==='Escape'&&this.state.paletteOpen){e.preventDefault();this.set({paletteOpen:false,paletteQuery:''});return;}
      if(e.key==='Escape'&&this.state.onboardingOpen){e.preventDefault();this.closeOnboarding(true);}
    }
    paletteActions(){return [
      {label:'Hội thoại mới',detail:'Bắt đầu một phiên độc lập',icon:'plus',go:()=>this.choose('')},
      {label:'Explorer · Files',detail:'Xem và sửa file có checkpoint',icon:'folder',go:()=>this.switchTab('files')},
      {label:'Git Diff / Review',detail:'Xem thay đổi và khôi phục',icon:'git',go:()=>this.switchTab('git')},
      {label:'Terminal / Project Verification',detail:'Kiểm thử dự án và log đã lưu',icon:'terminal',go:()=>this.switchTab('terminal')},
      {label:'Kế hoạch thực hiện',detail:'Checklist và bằng chứng',icon:'note',go:()=>this.switchTab('plan')},
      {label:'Lịch sử hoạt động',detail:'Nhật ký các lượt AI và MCP',icon:'history',go:()=>this.switchTab('activity')},
      {label:'Language Server & Code Index',detail:'Python AST, LSP, symbol và references',icon:'layers',go:()=>this.switchTab('intelligence')},
      {label:'Local App Preview',detail:'Xem localhost an toàn trong sandboxed iframe',icon:'eye',go:()=>this.switchTab('preview')},
      {label:'Chuyển theme sáng / tối',detail:'Giao diện sáng hoặc tối',icon:'sun',go:()=>this.setTheme(this.state.theme==='light'?'dark':'light')},
      {label:'Skills và Subagents',detail:'Hướng dẫn và tác nhân nghiên cứu',icon:'spark',go:()=>this.switchTab('skills')},
      {label:'Skills Marketplace & Plugins',detail:'Khám phá và cài đặt kỹ năng, plugin, công cụ MCP',icon:'spark',go:()=>this.switchTab('skills')},
      {label:'Cài đặt Web / API',detail:'Đổi chế độ, workspace, quyền',icon:'settings',go:()=>this.openSettings()},
      {label:'Quyền: Chỉ đọc',detail:'Agent chỉ đọc và phân tích; mọi thay đổi bị từ chối',icon:'eye',go:()=>this.setPermission('readonly')},
      {label:'Quyền: Review',detail:'Hỏi bạn trước mỗi lần sửa file hoặc chạy lệnh',icon:'shield',go:()=>this.setPermission('review')},
      {label:'Quyền: Tự động',detail:'Tự sửa file và chạy lệnh kiểm tra an toàn',icon:'bot',go:()=>this.setPermission('autonomous')},
      {label:'Quyền: Full Access (Bỏ qua duyệt)',detail:'Toàn bộ máy và Internet không cần hỏi duyệt (Rủi ro cao)',icon:'warning',go:()=>this.toggleFullAccess()},
      {label:'Hướng dẫn thiết lập',detail:'Chọn thư mục, kết nối AI và quyền của agent',icon:'spark',go:()=>this.set({onboardingOpen:true,onboardingStep:UI.onboarding(this.state.hub,{dismissed:false}).current})},
      {label:'Đồng bộ Hub',detail:'Tải lại trạng thái backend',icon:'refresh',go:()=>this.poll(true)}
    ].filter(item=>!(this.state.hub?.publicMode&&item.label==='Local App Preview'));}
    runPalette(item){this.set({paletteOpen:false,paletteQuery:''});item.go();}
    palette(){if(!this.state.paletteOpen)return null;const query=this.state.paletteQuery.trim().toLocaleLowerCase();const actions=this.paletteActions().filter(x=>(x.label+' '+x.detail).toLocaleLowerCase().includes(query));return h('div',{className:'palette-backdrop',role:'presentation',onMouseDown:e=>{if(e.target===e.currentTarget)this.set({paletteOpen:false});}},
      h('div',{className:'palette-dialog',role:'dialog','aria-modal':'true','aria-label':'Command Palette'},
        h('div',{className:'palette-search'},h(Icon,{name:'search',size:19}),h('input',{placeholder:'Tìm lệnh hoặc điều hướng...',autoFocus:true,value:this.state.paletteQuery,onChange:e=>this.set({paletteQuery:e.target.value}),onKeyDown:e=>{if(e.key==='Enter'&&actions[0]){e.preventDefault();this.runPalette(actions[0]);}}})),
        h('div',{className:'palette-results'},actions.length?actions.map(x=>h('button',{type:'button',key:x.label,onClick:()=>this.runPalette(x)},h(Icon,{name:x.icon,size:18}),h('span',null,h('strong',null,x.label),h('small',null,x.detail)),h(Icon,{name:'arrow',size:16}))):h('p',{className:'small-note'},'Không có lệnh phù hợp.')),
        h('div',{className:'palette-footer'},'Ctrl + K để mở · Enter để chọn · Esc để đóng')
      )
    );}

    toast(message,error=false){clearTimeout(this.noticeTimer);this.set({toast:{message,error}});this.noticeTimer=setTimeout(()=>this.set({toast:null}),7500);}
    async get(route){
      let response;
      try{response=await fetch(route,{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(12000)});}
      catch(error){throw new Error('Không liên lạc được Hub: '+error.message);}
      return this.handleResponse(response,route);
    }
    async handleResponse(response,route){
      const data=await response.json().catch(()=>null);
      // Public mode: the login session ended (or never existed). The server answers "/" with the login page, so reloading is enough.
      if(response.status===401&&data?.code==='login_required'){if(!this.reloadingForLogin){this.reloadingForLogin=true;location.reload();}throw new Error('Phiên đăng nhập đã hết. Đang mở lại trang đăng nhập…');}
      if(!response.ok){let message=data?.error||`HTTP ${response.status} tại ${route}`;
        if(response.status===404 && !message.includes(route))message+=` · endpoint ${route} · UI ${uiVersion}; kiểm tra tiến trình Hub đang chạy.`;
        const e=new Error(message);e.status=response.status;e.code=data?.code;throw e;
      }
      if(data===null)throw new Error(`Hub trả dữ liệu không hợp lệ ở ${route}`);
      return data;
    }
    async post(route,data={}){
      const csrf=this.state.hub?.csrfToken;
      if(!csrf)throw new Error('Chưa có CSRF token. Chờ Hub kết nối hoặc tải lại trang.');
      if(this.state.serverMismatch)throw new Error('Đã phát hiện Hub và giao diện lệch phiên bản. Hãy khởi động lại Hub trước.');
      const headers={'Content-Type':'application/json','X-ChatMCP-CSRF':csrf,'X-ChatMCP-Request':'local-dashboard','X-ChatMCP-UI-Build':BUILD};
      let response;
      try{response=await fetch(route,{method:'POST',headers,credentials:'same-origin',body:JSON.stringify(data)});}
      catch{throw new Error(`Mất kết nối trong khi gọi ${route}. Trạng thái thao tác chưa rõ; không gửi lại tự động. Hãy bấm Làm mới để kiểm tra.`);}
      return this.handleResponse(response,route);
    }
    async logout(){
      try{await this.post('/api/auth/logout',{});}catch(error){if(error.status!==401){this.toast(error.message,true);return;}}
      location.replace('/');
    }
    async bootstrap(){
      try{
        const health=await this.get('/api/health');
        if(health.app!=='chatmcp-local-hub')throw new Error('Cổng 3007 không phải ChatMCP Hub.');
        if(health.uiBuild!==BUILD){this.set({health,serverMismatch:true,connected:true});return;}
        const hub=await this.get('/api/state');
        const guide=UI.onboarding(hub,{dismissed:this.state.onboardingDismissed});
        this.set({health,hub,connected:true,serverMismatch:false,workspaceDraft:hub.workspace?.path||'',
          permissionMode:hub.studio?.permissions?.mode||'review',executionPolicy:hub.studio?.permissions?.executionPolicy||'host-review', apiDraft:this.initialApi(hub),
          onboardingOpen:guide.shouldOpen,onboardingStep:guide.current});
        void this.loadPresets();
        void this.loadWorkspaces();
        const selected=this.state.selectedId;
        if(selected && arr(hub.agent?.tasks).some(x=>x.id===selected))await this.loadTask(selected);
        else if(!selected && hub.agent?.activeTaskId)this.choose(hub.agent.activeTaskId);
      }catch(error){this.set({connected:false});this.toast(error.message,true);}
    }
    initialApi(hub){return UI.draftFromState(hub?.ai);}
    async loadPresets(){try{const r=await this.get('/api/ai/presets');this.set({presets:arr(r.presets),envKeys:arr(r.envKeys)});}catch{ /* an older Hub has no presets: the form still works by hand */ }}
    async poll(force=false){
      if(this.polling||this.state.serverMismatch)return;
      this.polling=true;
      try{
        const hub=await this.get('/api/state');
        if(this.state.health?.version && hub.version!==this.state.health.version){this.set({serverMismatch:true});return;}
        const updates={hub,connected:true};
        if(!this.state.hub)updates.workspaceDraft=hub.workspace?.path||'';
        if(hub.publicMode){const signature=`${hub.publicMode.workspaces?.count}|${hub.workspace?.path||''}`;if(signature!==this.workspaceSignature){this.workspaceSignature=signature;void this.loadWorkspaces();}}
        if(!this.state.hub){updates.permissionMode=hub.studio?.permissions?.mode||'review';updates.executionPolicy=hub.studio?.permissions?.executionPolicy||'host-review';}
        this.set(updates);
        const selected=this.state.selectedId;
        if(selected && !arr(hub.agent?.tasks).some(t=>t.id===selected)){
          this.choose('',true);
        }else if(selected){
          const sum=arr(hub.agent?.tasks).find(t=>t.id===selected);
          const signature=[selected,sum?.updatedAt,sum?.status,sum?.state,sum?.steps,sum?.toolCalls,sum?.promptCount,hub.agent?.active?.id].join('|');
          if(force || signature!==this.lastTaskKey || ['running','queued','preparing'].includes(sum?.status)){
            this.lastTaskKey=signature;await this.loadTask(selected);
          }
        }
        if(this.state.tab==='terminal')await this.loadTerminal(true);
      }catch{this.set({connected:false});}
      finally{this.polling=false;}
    }
    async act(label,fn){
      if(this.state.busy)return;
      this.set({busy:label});
      try{const result=await fn();if(result!==false)this.toast('Đã thực hiện: '+label);return result;}
      catch(error){this.toast(error.message,true);return null;}
      finally{this.set({busy:''});void this.poll(true);}
    }
    connectTaskStream(id){
      if(!window.EventSource || !id) return;
      if(this.taskStreamId === id && this.taskStream) return;
      if(this.taskStream){ try{ this.taskStream.close(); }catch{} this.taskStream = null; }
      this.taskStreamId = id;
      try {
        const stream = new EventSource('/api/tasks/' + encodeURIComponent(id) + '/stream');
        this.taskStream = stream;
        stream.onmessage = (e) => {
          if(!e?.data) return;
          try {
            const data = JSON.parse(e.data);
            if(data.type === 'token' && typeof data.token === 'string'){
              this.set((prev) => ({ streamingToken: (prev.streamingToken || '') + data.token }));
            } else if(data.type === 'event' && data.event){
              this.set((prev) => {
                if(prev.selectedId !== id || !prev.selectedTask) return null;
                const events = [...(prev.selectedTask.events || [])];
                events.push(data.event);
                return { selectedTask: { ...prev.selectedTask, events, state: data.state || prev.selectedTask.state } };
              });
            } else if(data.type === 'state'){
              this.set((prev) => {
                if(prev.selectedId !== id || !prev.selectedTask) return null;
                return { selectedTask: { ...prev.selectedTask, state: data.state } };
              });
            }
          } catch {}
        };
        stream.onerror = () => {
          if(this.taskStream === stream){ try{ stream.close(); }catch{} this.taskStream = null; }
        };
      } catch {}
    }
    choose(id='',silent=false){
      if(this.taskStream){ try{ this.taskStream.close(); }catch{} this.taskStream = null; this.taskStreamId = null; }
      this.set({ streamingToken: '' });
      sessionStore.set(id);
      this.lastTaskKey='';this.set({selectedId:id,selectedTask:null,prompt:'',plan:{title:'',items:[]},livePlan:null,workflow:null});
      if(id){ void this.loadTask(id); this.connectTaskStream(id); }
      if(!silent)this.set({tab:'activity'});
    }
    async loadTask(id){if(!id || this.taskLoadingIds.has(id))return;this.taskLoadingIds.add(id);
      try{
        const task=await this.get(`/api/tasks/${encodeURIComponent(id)}`);
        const item = task.task || task;
        if(this.alive&&this.state.selectedId===id){
          this.set({selectedTask:item});
          void this.loadTaskSide(id);
          if(['running','queued','planning','waiting_approval','verifying'].includes(item.state)){
            this.connectTaskStream(id);
          } else if(this.taskStream && this.taskStreamId === id){
            try{ this.taskStream.close(); }catch{} this.taskStream = null;
          }
        }
      }
      catch(error){if(this.state.selectedId===id && error.status!==404)this.toast(error.message,true);}
      finally{this.taskLoadingIds.delete(id);}
    }
    // The plan the agent keeps and what it has verified. Both are optional extras: a failure must not hide the task itself.
    async loadTaskSide(id){if(!this.state.hub?.studio)return;
      try{
        const [plan,workflow]=await Promise.all([this.get(params('/api/studio/plan',{taskId:id})).catch(()=>null),this.get(params('/api/studio/workflow',{taskId:id})).catch(()=>null)]);
        if(this.alive&&this.state.selectedId===id)this.set({livePlan:plan&&arr(plan.items).length?plan:null,workflow:workflow&&typeof workflow==='object'?workflow:null});
      }catch{ /* optional */ }
    }
    isRunning(){return Boolean(this.state.hub?.agent?.activeTaskId);}
    mode(){return UI.agentMode(this.state.hub);}
    chosenSummary(){return arr(this.state.hub?.agent?.tasks).find(x=>x.id===this.state.selectedId)||null;}
    async changeMode(mode){
      if(mode===this.mode())return;
      await this.act('Đổi chế độ AI',async()=>{
        const value=await this.post('/api/agent/mode',{mode});
        this.set({hub:value,apiDraft:this.initialApi(value)});
      });
    }
    async deleteSession(){const id=this.state.selectedId;if(!id)return;
      if(!confirm('Xóa LỊCH SỬ PHIÊN trong Hub? File workspace và hội thoại trên ChatGPT vẫn giữ nguyên. Không thể khôi phục lịch sử cục bộ sau thao tác này.'))return;
      await this.act('Xóa lịch sử phiên',async()=>{await this.post('/api/tasks/delete',{id});this.choose('',true);});
    }
    // Why the prompt cannot be sent, as something to fix: opens the screen that fixes it.
    fixBlocker(blocker){
      const local=UI.backendOf(this.state.hub)==='local';
      if(blocker.fix==='workspace'||blocker.fix==='ai'){
        if(local){this.set({onboardingOpen:true,onboardingStep:blocker.fix});return;}
        this.set({inspectorOpen:true});void this.switchTab('settings');return;
      }
      if(blocker.fix==='companion'){this.set({inspectorOpen:true});void this.switchTab('settings');return;}
      if(blocker.fix==='retry')void this.poll(true);
    }
    openSettings(){this.set({inspectorOpen:true});return this.switchTab('settings');}
    async send(override){const prompt=(typeof override==='string'?override:this.state.prompt).trim();const hub=this.state.hub;
      if(!prompt||this.isRunning()||!hub?.workspace?.path)return;
      const id=this.state.selectedId;
      const summary=this.chosenSummary();
      if(id&&!summary){this.toast('Hội thoại cũ không còn trong Hub; không tự mở hội thoại khác.',true);return;}
      const wrongTransport=summary?.transport&&summary.transport!==this.mode()?summary.transport:null;
      const ready=UI.readiness(hub,{connected:this.state.connected,mismatch:this.state.serverMismatch,wrongTransport});
      if(!ready.ready){this.toast(ready.blockers[0].label,true);this.fixBlocker(ready.blockers[0]);return;}
      const endpoint=id?'/api/tasks/continue':'/api/tasks/start';
      const payload={prompt}; // No Hub-imposed limits for local solo sessions.
      if(id)payload.id=id;
      await this.act(id?'Tiếp tục hội thoại':'Bắt đầu hội thoại',async()=>{
        // Tool selection is the agent's job. A prompt is also consent to start the project's tools (the local tools, or the
        // configured MCP services); the person does not have to open Settings and press Start first.
        // Never send the chat prompt if they cannot start.
        if(ready.startsTools){
          this.toast('Đang khởi động công cụ của dự án…');
          const updated=await this.post('/api/services/start');
          this.set({hub:updated});
          const tools=UI.toolsState(updated);
          if(!tools.ready)throw new Error('Công cụ của dự án chưa sẵn sàng sau khi tự khởi động'+(tools.detail?': '+tools.detail:'')+'. Chưa gửi prompt.');
        }
        const draft=this.state.prompt;
        const result=await this.post(endpoint,payload);
        if(!result.task?.id)throw new Error('Hub không trả ID phiên hợp lệ. Không gửi lại tự động.');
        this.choose(result.task.id,true);
        // A message sent by a button (resume) leaves whatever the person was typing alone.
        this.set({prompt:typeof override==='string'?draft:''});
        if(this.mode()==='chatgpt-web')window.postMessage({type:'CHATMCP_HUB_BROWSER_WAKE'},window.location.origin);
        return true;
      });
    }
    async cancel(){const id=this.state.hub?.agent?.activeTaskId;if(!id)return;
      await this.act('Dừng tác vụ (giữ lịch sử)',async()=>await this.post('/api/tasks/cancel',{id}));
    }
    async sessionRecovery(enabled){const id=this.state.selectedId;
      if(!id)return;
      await this.act('Cấu hình tự khôi phục',async()=>await this.post('/api/tasks/auto-resume',{id,enabled}));
    }
    async changeWorkspace(){const path=this.state.workspaceDraft.trim();if(!path)return;
      await this.act('Chuyển workspace',async()=>{const v=await this.post('/api/workspace/select',{path});this.set({hub:v,workspaceFolder:'',file:null,fileEntries:[]});});
    }
    async browseWorkspace(){await this.act('Chọn thư mục Windows',async()=>{const x=await this.post('/api/workspace/browse');if(x.path)this.set({workspaceDraft:x.path});});}
    // ---- workspaces of the public server: the Hub clones, creates, lists, exports, pushes and deletes them; the browser never names a path ----
    async loadWorkspaces(){
      if(!this.state.hub?.publicMode)return;
      try{this.set({wsList:await this.get('/api/workspace/list')});}catch(error){if(error.status!==401)this.toast(error.message,true);}
    }
    resetWorkspaceView(hub){this.set({hub,workspaceFolder:'',file:null,fileEntries:[]});void this.loadWorkspaces();}
    async cloneWorkspace(){const url=this.state.wsCloneUrl.trim(),branch=this.state.wsCloneBranch.trim();if(!url)return;
      await this.act('Clone kho (có thể mất vài phút)',async()=>{const v=await this.post('/api/workspace/clone',{url,...(branch?{branch}:{})});this.set({wsCloneUrl:'',wsCloneBranch:'',wsPushed:null});this.resetWorkspaceView(v);});
    }
    async createWorkspace(){const name=this.state.wsNewName.trim();if(!name)return;
      await this.act('Tạo workspace trống',async()=>{const v=await this.post('/api/workspace/create',{name});this.set({wsNewName:'',wsPushed:null});this.resetWorkspaceView(v);});
    }
    async useWorkspace(path){
      await this.act('Chuyển workspace',async()=>{const v=await this.post('/api/workspace/select',{path});this.set({wsPushed:null});this.resetWorkspaceView(v);});
    }
    async deleteWorkspace(name){
      if(!confirm(`Xóa workspace "${name}" khỏi máy chủ? File chưa push hoặc chưa tải về sẽ mất, không khôi phục được.`))return;
      await this.act('Xóa workspace',async()=>{const v=await this.post('/api/workspace/delete',{name});this.set({wsPushed:null});this.resetWorkspaceView(v);});
    }
    async pushWorkspace(name){const branch=this.state.wsPushBranch.trim();
      await this.act('Đẩy lên nhánh mới trên GitHub',async()=>{const v=await this.post('/api/workspace/push',{name,...(branch?{branch}:{})});this.set({wsPushed:{name,...v.pushed},wsPushBranch:''});});
    }
    async service(route,action){await this.act(action,async()=>this.set({hub:await this.post(route)}));}
    async pair(){await this.act('Tạo mã ghép Companion',async()=>{const p=await this.post('/api/browser/pair-code');this.set({pairCode:p.code||'',pairedExpiresAt:p.expiresAt||''});});}
    async unpair(){if(!confirm('Ngắt ghép Companion hiện tại?'))return;
      await this.act('Ngắt ghép Companion',async()=>{this.set({hub:await this.post('/api/browser/unpair')});});}
    updateApi(key,value){this.set({apiDraft:{...this.state.apiDraft,[key]:value,...(key==='apiKey'&&value?{useEnvKey:false}:{})}});}
    currentPreset(){return this.state.presets.find(x=>x.id===this.state.apiDraft.preset)||null;}
    // Choosing a provider starts from ITS values; nothing (least of all a key) is carried over from the previous one.
    selectPreset(id){const preset=this.state.presets.find(x=>x.id===id);if(!preset)return;
      this.set({apiDraft:UI.draftFromPreset(preset,this.state.apiDraft),models:[],modelSource:'',modelWarning:'',testResult:null});}
    async loadModels(){this.set({modelsLoading:true});
      try{const r=await this.get('/api/ai/models');this.set({models:arr(r.models),modelSource:str(r.source),modelWarning:str(r.warning)});}
      catch(error){this.toast(error.message,true);}
      finally{this.set({modelsLoading:false});}}
    async saveApi(){
      const problems=UI.validateDraft(this.state.apiDraft,this.currentPreset(),this.state.hub?.ai);
      if(problems.length){this.toast(problems[0].text,true);return false;}
      return await this.act('Lưu cấu hình AI',async()=>{
        const result=await this.post('/api/ai/config',UI.configPayload(this.state.apiDraft));
        this.set({hub:result,apiDraft:this.initialApi(result),models:[],modelSource:'',modelWarning:'',testResult:null});
        return true;
      });
    }
    async clearKey(){if(!confirm('Xóa API key đã lưu trên Hub?'))return;
      await this.act('Xóa API key',async()=>{const r=await this.post('/api/ai/clear-key');this.set({hub:r,apiDraft:{...this.state.apiDraft,apiKey:'',useEnvKey:false},testResult:null});});}
    // One tiny request: does the model answer, and does it call a tool when asked? Sends no project content.
    async testApi(){return await this.act('Kiểm tra kết nối AI và tool calling',async()=>{const r=await this.post('/api/ai/test');
      this.set({testResult:r});
      this.toast(r.responsePresent?`API hoạt động (${r.protocol||'gateway'} / ${r.authMode||'auto'})${r.autoSelected?' · Đã tự lưu cấu hình phù hợp':''}`:'Gateway trả kết quả nhưng không có message.',!r.responsePresent);
      if(r.autoSelected){const hub=await this.get('/api/state');this.set({hub,apiDraft:this.initialApi(hub)});}
      return false;});}
    async saveAndTest(){const saved=await this.saveApi();if(saved!==true)return;
      await this.testApi();
      if(this.state.hub?.ai?.configured)await this.loadModels();}
    async switchTab(tab){this.set({tab});
      if(this.terminalStream&&tab!=='terminal'){this.terminalStream.close();this.terminalStream=null;}
      if(tab==='terminal'&&!this.terminalStream&&window.EventSource&&!this.state.hub?.publicMode&&['localhost','127.0.0.1'].includes(window.location.hostname)){
        this.terminalStream=new EventSource('/api/studio/terminal/events');
        this.terminalStream.onmessage=()=>{clearTimeout(this.streamRefresh);this.streamRefresh=setTimeout(()=>this.loadTerminal(true),220);};
      }
      if(tab==='files')await this.loadTree();
      if(tab==='git')await this.loadGit();
      if(tab==='terminal')await this.loadTerminal();
      if(tab==='plan')await this.loadPlan();
      if(tab==='skills')await this.loadSkills();
      if(tab==='intelligence')await this.loadIntelligence();
      if(tab==='preview')await this.checkPreview(true);
      if(tab==='settings')await this.loadCapabilities();
    }
    async loadTree(folder=this.state.workspaceFolder){
      if(!this.state.hub?.workspace?.path)return;
      try{const r=await this.get(params('/api/studio/tree',{directory:folder,limit:350}));this.set({workspaceFolder:r.directory||'',fileEntries:arr(r.entries)});}
      catch(e){this.toast(e.message,true);}
    }
    async openFile(file){const serial=++this.fileLoadSerial;
      try{const v=await this.get(params('/api/studio/file',{file,maxBytes:230000}));if(serial===this.fileLoadSerial)this.set({file:v,fileDraft:v.content,editing:false});}
      catch(e){this.toast(e.message,true);}
    }
    async saveFile(){const f=this.state.file;
      if(!f)return;
      if(!confirm(`Lưu ${f.path}? Hub tạo checkpoint và từ chối nếu file đã bị thay đổi bên ngoài.`))return;
      await this.act('Lưu file có checkpoint',async()=>{
        await this.post('/api/studio/file/save',{file:f.path,content:this.state.fileDraft,expectedSha:f.sha256});
        await this.openFile(f.path);
      });
    }
    async searchCode(){if(!this.state.codeQuery.trim())return;
      await this.act('Tìm trong codebase',async()=>{
        const s=await this.get(params('/api/studio/search',{query:this.state.codeQuery.trim(),mode:this.state.codeSearchMode,limit:90}));
        this.set({codeMatches:arr(s.matches)});
      });
    }
    async loadGit(){try{const [git,checkpoints]=await Promise.all([this.get('/api/studio/git/status'),this.get('/api/studio/checkpoints')]);this.set({gitStatus:git,checkpoints,checkpointId:this.state.checkpointId||checkpoints[0]?.id||''});}
      catch(e){this.toast(e.message,true);}
    }
    async gitDiff(){await this.act('Đọc Git diff',async()=>this.set({gitDiff:await this.get('/api/studio/git/diff')}));}
    async diffCheck(){await this.act('Chạy git diff --check',async()=>{const r=await this.get('/api/studio/git/check');this.toast(r.ok?'Git diff --check: không phát hiện lỗi.':r.output||'Git diff --check không đạt.',!r.ok);return false;});}
    async checkpoint(){const label=prompt('Tên checkpoint trước khi sửa file:','Before code changes');if(label===null)return;
      await this.act('Tạo checkpoint',async()=>{const cp=await this.post('/api/studio/checkpoint',{label});await this.loadGit();this.set({checkpointId:cp.id});this.toast(`Đã lưu ${cp.fileCount} file · checkpoint có giới hạn.`);return false;});}
    async loadReview(){const id=this.state.checkpointId;if(!id)return this.toast('Chưa chọn checkpoint.',true);
      await this.act('So sánh checkpoint',async()=>{const review=await this.get(params('/api/studio/review',{checkpointId:id}));this.set({review});});}
    async decideReview(action,change){const endpoint=action==='accept'?'/api/studio/accept':'/api/studio/restore';
      if(action==='restore'&&!confirm(`Khôi phục ${change.path} về checkpoint? Chỉ file này được sửa.`))return;
      await this.act(action==='restore'?'Hoàn tác file':'Chấp nhận thay đổi',async()=>{
        await this.post(endpoint,{checkpointId:this.state.checkpointId,file:change.path,expectedSha:change.currentSha});
        await this.loadReview();
      });
    }
    async loadTerminal(silent=false){if(!this.state.hub?.studio)return;
      try{
        const [terminals,checks,history]=await Promise.all([
          this.get('/api/studio/terminal'),this.get('/api/studio/checks'),this.get('/api/studio/verifications')
        ]);
        this.set({terminals:arr(terminals),suggestedChecks:arr(checks.suggested),verificationRuns:arr(history.runs),currentTerminalId:this.state.currentTerminalId||arr(terminals).slice(-1)[0]?.id||''});
      }catch(e){if(!silent)this.toast(e.message,true);}
    }
    async verifyProject(command){
      if(!confirm(this.state.hub?.publicMode?`Chạy lệnh kiểm thử dự án trên MÁY CHỦ (tài khoản riêng của agent, không đọc được bí mật của Hub):\n\n${command}\n\nKết quả và exit code sẽ được lưu vào lịch sử. Tiếp tục?`:`Chạy lệnh kiểm thử dự án bằng quyền Windows (KHÔNG sandbox):\n\n${command}\n\nKết quả và exit code sẽ được lưu vào lịch sử. Tiếp tục?`))return;
      await this.act('Kiểm thử dự án có lưu kết quả',async()=>{
        const run=await this.post('/api/studio/verify/run',{command,taskId:this.state.selectedId||''});
        this.set({currentTerminalId:run.terminalId});await this.loadTerminal();
      });
    }
    async startTerminal(){const cmd=this.state.terminalCommand.trim(),sandbox=this.state.terminalSandbox,interactive=this.state.terminalInteractive;
      if(!cmd&&!interactive)return;
      if(!sandbox&&!confirm(this.state.hub?.publicMode?`CHẠY LỆNH TRÊN MÁY CHỦ (tài khoản riêng của agent):\n\n${cmd}\n\nLệnh đọc/sửa được workspace đang chọn và có thể truy cập Internet; không đọc được bí mật của Hub. Đồng ý?`:`CHẠY LỆNH TRÊN WINDOWS HOST (không sandbox):\n\n${cmd||'(mở shell tương tác)'}\n\nLệnh có toàn quyền tài khoản Windows. Đồng ý?`))return;
      await this.act(sandbox?'Chạy Docker sandbox':'Chạy Terminal',async()=>{const t=await this.post('/api/studio/terminal/start',{command:cmd,timeoutMinutes:15,sandbox,interactive});this.set({currentTerminalId:t.id,terminalCommand:'',terminalInput:''});await this.loadTerminal();});
    }
    async writeTerminal(){const id=this.state.currentTerminalId,text=this.state.terminalInput;if(!id||!text)return;await this.act('Gửi terminal stdin',async()=>{await this.post('/api/studio/terminal/input',{id,text:text+'\n'});this.set({terminalInput:''});return false;});}
    async stopTerminal(){const id=this.state.currentTerminalId;if(!id)return;
      await this.act('Dừng Terminal',async()=>await this.post('/api/studio/terminal/stop',{id}));}
    async loadPlan(){const id=this.state.selectedId;if(!id)return;
      try{const p=await this.get(params('/api/studio/plan',{taskId:id}));this.set({plan:{title:p.title||'',items:arr(p.items)}});}catch(e){this.toast(e.message,true);}
    }
    async savePlan(){const id=this.state.selectedId;if(!id)return this.toast('Chọn phiên trước khi lưu plan.',true);
      await this.act('Lưu checklist',async()=>{const p=await this.post('/api/studio/plan/set',{taskId:id,...this.state.plan});this.set({plan:p});});
    }
    updatePlanItem(i,key,value){const items=this.state.plan.items.map((item,j)=>i===j?{...item,[key]:value}:item);this.set({plan:{...this.state.plan,items}});}
    async loadSkills(){try{const r=await this.get('/api/studio/skills');this.set({skills:arr(r.skills)});}catch(e){this.toast(e.message,true);}}
    async decidePermission(id,approved){await this.act(approved?'Cho phép thao tác':'Từ chối thao tác',async()=>await this.post('/api/studio/permissions/decide',{id,approved}));}
    async setPermission(mode){
      const isFullAccess=this.state.hub?.studio?.permissions?.executionPolicy==='full-access';
      if(!isFullAccess&&mode===this.permMode())return;
      if(mode==='full-access'){return await this.toggleFullAccess(true);}
      if(isFullAccess){
        if(!confirm(`Tắt Full Access và chuyển sang chế độ ${mode==='readonly'?'Chỉ đọc':mode==='autonomous'?'Tự động':'Review'}?`))return;
        await this.act('Đổi quyền của agent',async()=>{
          await this.post('/api/studio/permissions/config',{mode,executionPolicy:'host-review'});
          this.set({permissionMode:mode,executionPolicy:'host-review'});
        });
        return;
      }
      if(mode==='autonomous'&&!confirm('Chế độ Tự động cho phép agent sửa file trong workspace và chạy lệnh kiểm tra an toàn mà không hỏi. Lệnh khác và lệnh nguy hiểm vẫn cần bạn duyệt; công cụ chưa phân loại bị từ chối. Bật?'))return;
      await this.act('Đổi quyền của agent',async()=>{await this.post('/api/studio/permissions/config',{mode});this.set({permissionMode:mode});});
    }
    async toggleFullAccess(forceEnable=false){
      const isFullAccess=this.state.hub?.studio?.permissions?.executionPolicy==='full-access';
      if(isFullAccess&&!forceEnable){
        if(!confirm('Tắt Full Access và quay về chế độ Review?'))return;
        await this.act('Tắt Full Access',async()=>{
          await this.post('/api/studio/permissions/config',{mode:'review',executionPolicy:'host-review'});
          this.set({permissionMode:'review',executionPolicy:'host-review'});
        });
        this.toast('Đã tắt Full Access, chuyển về Review.');
        return;
      }
      const confirmation=window.prompt('FULL ACCESS — RỦI RO CAO\n\nAgent có thể tự đọc/sửa/xóa file BẤT KỲ mà tài khoản có quyền truy cập, chạy shell và truy cập Internet qua công cụ MCP mà KHÔNG hỏi mỗi lần.\n\nKhông bảo vệ bằng Docker sandbox. Không được dùng với repository không tin cậy.\n\nNhập chính xác FULL ACCESS để xác nhận:');
      if(confirmation!=='FULL ACCESS'){this.toast('Đã hủy bật Full Access. Nhập đúng FULL ACCESS nếu muốn bật.',true);return;}
      await this.act('Bật Full Access',async()=>{
        const p=await this.post('/api/studio/permissions/config',{executionPolicy:'full-access',confirmation:'FULL ACCESS'});
        this.set({executionPolicy:p.executionPolicy});
      });
      this.toast('ĐÃ BẬT FULL ACCESS — Mọi công cụ chạy không cần duyệt.');
    }
    async denyAll(pending){await this.act('Từ chối tất cả yêu cầu',async()=>{for(const p of pending)await this.post('/api/studio/permissions/decide',{id:p.id,approved:false});});}
    // After the person has looked at what changed: the Git tab with the diff already loaded.
    async reviewChanges(){this.set({inspectorOpen:true});await this.switchTab('git');await this.gitDiff();}
    async setExecutionPolicy(executionPolicy){
      if(executionPolicy==='host-review'&&!confirm('Host-review cho phép MCP chạy trực tiếp bằng quyền Windows sau phê duyệt. Bật lại?'))return;
      let confirmation;
      if(executionPolicy==='full-access'){
        confirmation=window.prompt('FULL ACCESS — RỦI RO CAO\n\nAgent có thể tự đọc/sửa/xóa file BẤT KỲ mà tài khoản Windows có quyền truy cập, chạy shell và truy cập Internet qua công cụ MCP mà KHÔNG hỏi mỗi lần.\n\nKhông bảo vệ bằng Docker sandbox. Không được dùng với repository không tin cậy.\n\nNhập chính xác FULL ACCESS để xác nhận:');
        if(confirmation!=='FULL ACCESS'){this.toast('Đã hủy bật Full Access. Nhập đúng FULL ACCESS nếu muốn bật.',true);return;}
      }
      await this.act('Cập nhật an toàn thực thi',async()=>{const p=await this.post('/api/studio/permissions/config',{executionPolicy,...(confirmation?{confirmation}:{})});this.set({executionPolicy:p.executionPolicy});});
    }
    async loadCapabilities(){try{const [sandbox,terminalCaps,intelligence]=await Promise.all([this.state.hub?.publicMode?{ready:false}:this.get('/api/studio/sandbox'),this.get('/api/studio/terminal/capabilities'),this.get('/api/studio/intelligence/status')]);this.set({sandboxStatus:sandbox,terminalCaps,indexState:intelligence});}
      catch(e){this.toast(e.message,true);}}
    async loadIntelligence(){try{const status=await this.get('/api/studio/intelligence/status');this.set({indexState:status});}catch(e){this.toast(e.message,true);}}
    async buildIndex(){await this.act('Lập chỉ mục source code',async()=>{const report=await this.post('/api/studio/intelligence/index',{force:false});await this.loadIntelligence();this.toast(`Đã lập chỉ mục ${report.fileCount} file / ${report.symbolCount} symbol`);return false;});}
    async searchSymbols(){await this.act('Tìm symbols',async()=>{const v=await this.get(params('/api/studio/intelligence/symbols',{query:this.state.indexQuery,limit:120}));this.set({indexMatches:arr(v.matches)});return false;});}
    async findReferences(name){await this.act('Tìm references',async()=>{const v=await this.get(params('/api/studio/intelligence/references',{symbol:name}));this.set({referenceMatches:arr(v.matches)});return false;});}
    async lspStart(){await this.act('Khởi động LSP',async()=>{const v=await this.post('/api/studio/intelligence/lsp/start',{language:this.state.lspLanguage});await this.loadIntelligence();this.toast(v.ready?'LSP đã sẵn sàng':'LSP chưa chạy',!v.ready);return false;});}
    async lspJump(method){const s=this.state;if(!s.file?.path&&!s.lspFile)return this.toast('Mở file trong Explorer trước.',true);
      await this.act('Language server '+method,async()=>{const r=await this.get(params('/api/studio/intelligence/lsp',{language:s.lspLanguage,method,file:s.lspFile||s.file?.path,line:s.lspLine,column:s.lspColumn}));this.set({lspResult:r});return false;});}
    async checkPreview(silent=false){try{const v=await this.get(params('/api/studio/preview',{port:this.state.previewPort,pathname:this.state.previewPath}));this.set({previewInfo:v});}
      catch(e){if(!silent)this.toast(e.message,true);this.set({previewInfo:null});}}
    async runResearch(){const queries=this.state.delegateQuery.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      if(!queries.length)return;
      if(!confirm(`Chạy ${queries.length} research subagent qua API? Có thể phát sinh phí.`))return;
      await this.act('Research subagents',async()=>{const r=await this.post('/api/studio/delegates/research',{queries,taskId:this.state.selectedId||undefined});this.set({delegates:arr(r.workers)});});
    }
    // ---- approvals ---------------------------------------------------------------------------------------------------
    // The decision the agent is blocked on, shown where the person is looking (above the composer, never hidden behind a
    // closed side panel), with exactly what would happen: the command and its folder, the file and the change.
    // Everything is rendered as text; nothing the model wrote is ever interpreted as markup.
    approvalCard(request){
      const d=UI.describeApproval(request,this.state.now),left=d.secondsLeft,expired=left===0,busy=!!this.state.busy;
      return h('div',{className:`approval-card risk-${d.risk}`,key:d.id,role:'group','aria-label':d.title},
        h('div',{className:'approval-head'},
          h('div',{className:'approval-title'},h(Icon,{name:d.risk==='high'?'warning':'lock',size:16}),h('strong',null,d.title),h(Tag,{kind:d.risk==='high'?'error':d.risk==='medium'?'warn':'neutral'},d.categoryLabel)),
          left!==null?h('span',{className:'approval-timer'+(left<60?' urgent':''),title:'Hết thời gian này, yêu cầu bị từ chối tự động.'},expired?'Đã hết hạn':'Còn '+UI.countdown(left)):null),
        !d.blocks.length&&d.summary?h('p',{className:'approval-summary'},d.summary):null,
        d.rows.length?h('div',{className:'approval-rows'},d.rows.map((row,i)=>h('div',{className:'approval-row',key:'r'+i},h('span',null,row.label),h('span',{className:row.mono?'mono':''},row.value)))):null,
        d.blocks.map((block,i)=>h('div',{className:'approval-block approval-block-'+block.kind,key:'b'+i},h('div',{className:'approval-block-label'},block.label),h('pre',null,block.text||'(trống)'))),
        d.reason?h('p',{className:'approval-reason'},d.reason):null,
        h('div',{className:'approval-actions'},
          h(Button,{variant:'primary',icon:'check',disabled:expired||busy,onClick:()=>this.decidePermission(d.id,true)},'Cho phép'),
          h(Button,{variant:'danger',icon:'x',disabled:busy,onClick:()=>this.decidePermission(d.id,false)},'Từ chối')));
    }
    approvalDock(pending){if(!pending.length)return null;
      const shown=pending.slice(0,3),minutes=Math.max(1,Math.round((Number(this.state.hub?.studio?.permissions?.approvalTimeoutMs)||600000)/60000));
      return h('section',{className:'approval-dock',role:'region','aria-label':'Yêu cầu chờ bạn duyệt'},
        h('div',{className:'approval-dock-head'},h(Icon,{name:'lock',size:18}),
          h('div',null,h('strong',null,`Agent đang chờ bạn duyệt ${pending.length} thao tác`),h('small',null,`Không có gì chạy cho tới khi bạn quyết định. Yêu cầu tự bị từ chối sau ${minutes} phút.`)),
          pending.length>1?h(Button,{variant:'danger',disabled:!!this.state.busy,onClick:()=>this.denyAll(pending)},'Từ chối tất cả'):null),
        shown.map(request=>this.approvalCard(request)),
        pending.length>shown.length?h('p',{className:'small-note'},`Còn ${pending.length-shown.length} yêu cầu nữa, sẽ hiện sau khi bạn xử lý các yêu cầu trên.`):null);
    }
    // ---- task state --------------------------------------------------------------------------------------------------
    // What the person needs to know about a task that has stopped in a way that is not simply "done". An unknown outcome is
    // never softened: the banner says what may have happened, and the only way on is a message that tells the agent to look first.
    stateBanner(task,d){if(!task||!d.state||d.active)return null;
      const running=this.isRunning(),busy=!!this.state.busy;
      const resume=(label,variant='primary')=>h(Button,{variant,icon:'play',disabled:running||busy,onClick:()=>this.send(UI.resumePrompt(task))},label);
      const changes=h(Button,{variant:'outline',icon:'git',onClick:()=>this.reviewChanges()},'Xem thay đổi (Git diff)');
      if(d.state==='uncertain'){const ops=UI.unconfirmedOperations(task);
        return h('div',{className:'state-banner tone-warn',role:'alert'},h(Icon,{name:'warning',size:20}),h('div',{className:'state-banner-body'},
          h('strong',null,'Chưa rõ một thao tác đã chạy hay chưa'),h('p',null,d.hint),
          ops.length?h('ul',{className:'state-ops'},ops.map((op,i)=>h('li',{key:i},h('code',null,op.tool),op.startedAt?' · bắt đầu lúc '+formatTime(op.startedAt):''))):null,
          h('div',{className:'button-row'},changes,resume('Tiếp tục: kiểm tra trước'))));}
      if(d.state==='paused')return h('div',{className:'state-banner tone-warn',role:'status'},h(Icon,{name:'history',size:20}),h('div',{className:'state-banner-body'},
        h('strong',null,d.label),h('p',null,d.hint),h('div',{className:'button-row'},resume('Tiếp tục từ chỗ dừng'))));
      if(d.state==='failed'){const fix=UI.errorFix(task.errorCode);
        return h('div',{className:'state-banner tone-error',role:'alert'},h(Icon,{name:'warning',size:20}),h('div',{className:'state-banner-body'},
          h('strong',null,task.errorCode||d.label),h('p',null,str(task.error,d.hint).slice(0,600)),
          h('div',{className:'button-row'},
            fix?h(Button,{variant:'primary',icon:'settings',onClick:()=>this.fixBlocker({fix})},fix==='ai'?'Sửa cấu hình AI':'Chọn lại thư mục dự án'):null,
            task.toolCalls>0?changes:null,resume('Thử lại',fix?'outline':'primary'))));}
      if(d.state==='cancelled'&&task.toolCalls>0)return h('div',{className:'state-banner tone-idle',role:'status'},h(Icon,{name:'stop',size:20}),h('div',{className:'state-banner-body'},
        h('strong',null,d.label),h('p',null,d.hint),h('div',{className:'button-row'},changes)));
      return null;
    }
    // The agent's own checklist for the task, read-only here (it is edited in the Plan tab).
    planCard(){const plan=this.state.livePlan,items=arr(plan?.items);if(!items.length)return null;
      const words={todo:'Chưa làm',doing:'Đang làm',done:'Xong',blocked:'Bị chặn'},done=items.filter(item=>item.status==='done').length;
      return h('details',{className:'plan-card',open:true},
        h('summary',null,h(Icon,{name:'note',size:15}),' ',str(plan.title)||'Kế hoạch của agent',h('span',{className:'plan-progress'},` ${done}/${items.length} xong`)),
        h('ul',null,items.slice(0,40).map((item,i)=>h('li',{key:i,className:'plan-line plan-'+str(item.status,'todo')},
          h('span',{className:'plan-glyph','aria-hidden':'true',title:words[item.status]||words.todo}),
          h('span',null,h('span',{className:'sr-only'},(words[item.status]||words.todo)+': '),str(item.text).slice(0,240)),
          item.evidence?h('small',null,str(item.evidence).slice(0,160)):null))));
    }
    // What the agent verifiably did, from the workflow record: edits that succeeded and checks that exited 0.
    resultFooter(task,d){if(!task||d.active)return null;
      const ev=UI.evidenceSummary(this.state.workflow);
      if(!ev||(!ev.edits&&!ev.commands&&!ev.checks))return null;
      return h('div',{className:`result-footer result-${ev.kind}`,role:'status'},h(Icon,{name:ev.verified?'check':'warning',size:16}),h('span',null,ev.text),
        (ev.edits||ev.commands)&&d.state==='completed'?h(Button,{variant:'quiet',icon:'git',onClick:()=>this.reviewChanges()},'Xem thay đổi'):null);
    }
    // ---- composer parts ----------------------------------------------------------------------------------------------
    permissionSwitch(){const mode=this.permMode(),isFullAccess=this.state.hub?.studio?.permissions?.executionPolicy==='full-access',busy=!!this.state.busy;
      return h('div',{className:'perm-switch',role:'group','aria-label':'Quyền của agent'},
        UI.PERMISSION_MODES.map(entry=>h('button',{type:'button',key:entry.id,
          className:'perm-btn perm-'+entry.id+(entry.id===mode&&!isFullAccess?' active':''),
          title:entry.hint+(isFullAccess&&!busy?' (Bấm để tắt Full Access và chuyển về chế độ này)':''),
          'aria-pressed':entry.id===mode&&!isFullAccess,disabled:busy,onClick:()=>this.setPermission(entry.id)},entry.label)),
        h('button',{type:'button',key:'full-access',
          className:'perm-btn perm-full-access'+(isFullAccess?' active':''),
          title:'FULL ACCESS: Toàn bộ máy và Internet không cần hỏi duyệt (Rủi ro cao)',
          'aria-pressed':isFullAccess,disabled:busy,onClick:()=>this.toggleFullAccess()},'Full Access ⚠️'));
    }
    providerChip(){const ai=this.state.hub?.ai;
      if(this.mode()==='chatgpt-web')return h('button',{type:'button',className:'provider-chip',title:'ChatGPT Web: chế độ cũ, chỉ để thử nghiệm cục bộ. Mở Cài đặt để đổi.',onClick:()=>this.openSettings()},h(Icon,{name:'external',size:13}),'ChatGPT Web');
      const badge=UI.toolCallingBadge(ai);
      return h('button',{type:'button',className:'provider-chip',title:ai?.configured?`${str(ai.model)} · ${str(ai.apiBaseUrl)}\n${badge.label}`:'Chưa cấu hình AI. Bấm để thiết lập.',onClick:()=>this.openSettings()},
        h(Icon,{name:'bot',size:13}),ai?.configured?str(ai.model,'model'):'Chưa kết nối AI',
        ai?.configured?h('span',{className:'tc-dot tc-'+badge.kind,title:badge.label}):null);
    }
    // The first thing standing between the person and a task, as something to click. Connection and version problems have
    // their own banners; a session in the wrong mode has its own warning.
    blockerStrip(ready){if(this.isRunning())return null;
      const blocker=ready.blockers.find(item=>['workspace','ai','companion','tools-starting'].includes(item.id));if(!blocker)return null;
      const action={workspace:'Chọn thư mục',ai:'Thiết lập AI',companion:'Mở Cài đặt'}[blocker.id];
      return h('div',{className:'blocker-strip',role:'status'},h(Icon,{name:blocker.id==='tools-starting'?'refresh':'warning',size:16}),h('span',null,blocker.label),
        action?h(Button,{variant:'primary',onClick:()=>this.fixBlocker(blocker)},action):null);
    }
    // ---- AI connection form (Settings and the first-run wizard) -------------------------------------------------------
    // A key lives only in its field until it is saved; the Hub never sends it back, only how it is held.
    providerForm(){const s=this.state,a=s.apiDraft,ai=s.hub?.ai,preset=this.currentPreset(),badge=UI.toolCallingBadge(ai),key=UI.keyStatus(ai);
      const busy=!!s.busy||this.isRunning(),choices=UI.modelChoices(s.models,a.model),local=Boolean(preset?.local),protection=str(ai?.secretStorage?.protection),test=s.testResult;
      const field=(label,child,note)=>h('label',{className:'form-field'},label,child,note?h('small',{className:'field-note'},note):null);
      const unlisted=s.models.length&&a.model&&!choices.currentListed?`Model "${a.model}" không có trong danh sách nhà cung cấp trả về.`:(s.modelWarning||null);
      return h('div',{className:'provider-form'},
        field('Nhà cung cấp',h('select',{id:'ai-preset',value:a.preset||'',disabled:busy,onChange:e=>e.target.value?this.selectPreset(e.target.value):this.updateApi('preset','')},
          h('option',{value:''},ai?.configured||a.preset?'Tự nhập thủ công':'Chọn nhà cung cấp…'),s.presets.map(item=>h('option',{key:item.id,value:item.id},item.label))),preset?.notes),
        preset?.keyUrl&&!local?h('p',{className:'small-note'},'Tạo API key tại ',h('a',{className:'inline-link',href:preset.keyUrl,target:'_blank',rel:'noopener noreferrer'},preset.keyUrl.replace(/^https:\/\//,'')),'. Key chỉ được gửi tới địa chỉ API bên dưới.'):null,
        field('Giao thức',h('select',{value:a.protocol,onChange:e=>this.updateApi('protocol',e.target.value)},UI.PROTOCOLS.map(item=>h('option',{key:item.id,value:item.id},item.label)))),
        field('Base URL',h('input',{value:a.apiBaseUrl,placeholder:'https://api.example.com/v1',spellCheck:false,onChange:e=>this.updateApi('apiBaseUrl',e.target.value)})),
        field('Model',h('div',{className:'model-row'},
          h('input',{value:a.model,list:'ai-models',placeholder:'tên model',spellCheck:false,onChange:e=>this.updateApi('model',e.target.value)}),
          h('datalist',{id:'ai-models'},choices.ids.map(id=>h('option',{key:id,value:id}))),
          h(Button,{variant:'outline',icon:'refresh',disabled:busy||s.modelsLoading||!ai?.configured,title:'Hỏi nhà cung cấp danh sách model của tài khoản (cần lưu cấu hình trước)',onClick:()=>this.loadModels()},s.modelsLoading?'Đang tải…':'Tải danh sách model')),unlisted),
        local?h('p',{className:'small-note'},'Máy chủ cục bộ: không cần API key. Model phải hỗ trợ tool calling và có ngữ cảnh đủ lớn.'):h('div',null,
          field('API key',h('input',{type:'password',autoComplete:'off',spellCheck:false,value:a.apiKey,disabled:a.useEnvKey,placeholder:key.source==='none'?'Dán API key':'Để trống để giữ key hiện tại',onChange:e=>this.updateApi('apiKey',e.target.value)})),
          preset?.envKey?h('label',{className:'checkbox-line'},h('input',{type:'checkbox',checked:a.useEnvKey,onChange:e=>this.set({apiDraft:{...a,useEnvKey:e.target.checked,apiKey:e.target.checked?'':a.apiKey}})}),`Dùng key từ biến môi trường ${preset.envKey} (không lưu vào file)`):null,
          h('label',{className:'checkbox-line'},h('input',{type:'checkbox',checked:a.remember,disabled:a.useEnvKey,onChange:e=>this.updateApi('remember',e.target.checked)}),'Ghi nhớ key trên máy này'+(protection?` — ${protection}`:'')),
          h('p',{className:'key-status key-'+key.kind},h(Icon,{name:'key',size:13}),' ',key.text,!a.remember&&a.apiKey&&!a.useEnvKey?' Không ghi nhớ: key chỉ giữ trong bộ nhớ Hub, mất khi Hub dừng.':'')),
        h('details',{className:'advanced-fields'},h('summary',null,'Nâng cao'),
          field('Kiểu xác thực',h('select',{value:a.authMode,onChange:e=>this.updateApi('authMode',e.target.value)},UI.AUTH_MODES.map(mode=>h('option',{key:mode,value:mode},mode)))),
          field('Đường dẫn endpoint (tuỳ chọn)',h('input',{value:a.customPath,placeholder:'/v1/...',spellCheck:false,onChange:e=>this.updateApi('customPath',e.target.value)})),
          field('Ngữ cảnh model, token (tuỳ chọn)',h('input',{value:a.contextWindowTokens,inputMode:'numeric',placeholder:'ví dụ 128000',onChange:e=>this.updateApi('contextWindowTokens',e.target.value)}),'Dùng để cắt bớt lịch sử trước khi vượt giới hạn. Để trống nếu không biết.')),
        h('div',{className:'button-row'},
          h(Button,{variant:'primary',icon:'save',disabled:busy,onClick:()=>this.saveAndTest()},'Lưu & kiểm tra'),
          h(Button,{variant:'outline',disabled:busy,onClick:()=>this.saveApi()},'Lưu API'),
          h(Button,{variant:'outline',disabled:!!s.busy||!ai?.configured,onClick:()=>this.testApi()},'Test API · Tự nhận dạng'),
          ['saved','session'].includes(key.source)?h(Button,{variant:'danger',icon:'trash',disabled:busy,onClick:()=>this.clearKey()},'Xóa key'):null),
        ai?.configured?h('div',{className:'tc-line tc-'+badge.kind},h(Icon,{name:badge.kind==='success'?'check':'warning',size:14}),h('span',null,badge.label+(badge.note?' — '+badge.note:''))):null,
        test?h('p',{className:'small-note'},test.responsePresent?`Kết nối thành công${test.protocol?` · ${test.protocol}`:''}${test.autoSelected?' · đã tự chọn cấu hình phù hợp':''}.`:'Nhà cung cấp trả kết quả nhưng không có nội dung văn bản.'):null,
        h('p',{className:'small-note'},'Khả năng gọi công cụ: ',str(ai?.agentRequestMode,'chưa kiểm tra'),'. Agent chỉ làm việc đáng tin với model hỗ trợ tool calling gốc; "Lưu & kiểm tra" thử đúng điều đó bằng một yêu cầu rất nhỏ, không gửi nội dung dự án.'));
    }
    // ---- first-run wizard --------------------------------------------------------------------------------------------
    onboardingContext(ready){const s=this.state;
      return {UI,Icon,Button,Tag,hub:s.hub,step:s.onboardingStep,ready,busy:!!s.busy,running:this.isRunning(),workspaceDraft:s.workspaceDraft,permission:this.permMode(),
        providerForm:()=>this.providerForm(),
        setStep:id=>this.set({onboardingStep:id}),
        setWorkspaceDraft:value=>this.set({workspaceDraft:value}),
        browse:()=>this.browseWorkspace(),
        applyWorkspace:()=>this.changeWorkspace(),
        workspacePanel:s.hub?.publicMode?()=>this.workspacePanel():null,
        setPermission:mode=>this.setPermission(mode),
        useExample:text=>{this.closeOnboarding(true);this.set({prompt:text});},
        close:forever=>this.closeOnboarding(forever)};
    }
    // Closing is remembered per browser so the wizard never nags; the blocker strip above the composer reopens it when needed.
    closeOnboarding(forever=true){if(forever)onboardingStore.set(true);this.set({onboardingOpen:false,onboardingDismissed:forever||this.state.onboardingDismissed});}
    render() {
      const s=this.state, hub=s.hub, tasks=arr(hub?.agent?.tasks), selected=s.selectedTask||this.chosenSummary(), active=hub?.agent?.active, chosen=this.chosenSummary(),
        wrongTransport=chosen?.transport&&chosen.transport!==this.mode()?chosen.transport:null,
        ready=UI.readiness(hub,{connected:s.connected,mismatch:s.serverMismatch,wrongTransport}), described=UI.describeTask(selected);
      const filtered=tasks.filter(t=>[t.prompt, ...arr(t.prompts).map(p=>p.text),t.workspace?.path].join(' ').toLowerCase().includes(s.sessionQuery.toLowerCase()));
      const pending=this.pendingApprovals(),events=arr(selected?.events);
      return h('div',{className:'app-frame'},
        this.header(hub),
        h('div',{className:'studio-columns'+(s.inspectorOpen?'':' studio-no-inspector')},
          this.sidebar(filtered,hub),
          h('main',{className:'conversation-col'},
            this.chatHeader(selected,active,described),
            s.serverMismatch?this.versionNotice():null,
            hub?.publicMode?.ephemeralStorage?h('div',{className:'public-storage-note',role:'note'},h(Icon,{name:'warning',size:16}),' '+str(hub.publicMode.storageNote,'Ổ đĩa của máy chủ là tạm thời.')):null,
            !s.connected?h('div',{className:'offline-alert'},h(Icon,{name:'wifi'}),' Mất kết nối với Hub. Nhật ký đã lưu vẫn nằm trên máy; đang thử kết nối lại…'):null,
            active && this.mode()==='chatgpt-web' && active.delivery && active.delivery.status!=='sent' && hub?.browser
              ? h('div',{className:'web-delivery-alert',role:'status'},h(Icon,{name:'warning',size:17}),h('div',null,
                h('strong',null,active.delivery.status==='claimed'?'Companion đã nhận gói nhưng Hub chưa xác nhận gửi':'Đang chuẩn bị gửi qua ChatGPT Web'),
                h('p',null,str(hub.browser.companionNote,hub.browser.connected?'Đang đợi tab phản hồi; chưa có xác nhận đã gửi.':'Companion chưa phản hồi. Kiểm tra Edge và tab ChatGPT đang mở.')),
                active.delivery.claimedAt && Date.now()-Date.parse(active.delivery.claimedAt)>90000
                  ? h('p',{className:'web-delivery-stalled'},'Đã chờ hơn 90 giây. Kiểm tra popup Companion và tab ChatGPT. Không tự gửi lại hoặc mở task mới khi chưa xác minh lượt cũ.') : null)) : null,
            hub?.studio?.permissions?.executionPolicy==='full-access'?h('div',{className:'full-access-warning',role:'alert'},h(Icon,{name:'warning',size:18}),' FULL ACCESS đang bật — agent được dùng Internet và file toàn máy theo quyền Windows. ',h('button',{type:'button',onClick:()=>this.openSettings()},'Tắt trong Cài đặt')):null,
            this.stateBanner(selected,described),
            this.conversation(selected,events,described),
            this.approvalDock(pending),
            this.composer(ready,Boolean(wrongTransport))
          ),
          s.inspectorOpen?this.inspector(hub,selected):null
        ),
        s.toast?h('div',{className:`toast ${s.toast.error?'toast-error':''}`,role:'status'},h(Icon,{name:s.toast.error?'warning':'check',size:17}),s.toast.message,h('button',{onClick:()=>this.set({toast:null}),'aria-label':'Đóng thông báo'},'×')):null,
        this.palette(),
        s.onboardingOpen?Onboarding.render(h,this.onboardingContext(ready)):null
      );
    }
    header(hub){const connected=this.state.connected,loading=Boolean(this.state.busy);
      return h('header',{className:'main-header'},
        h('div',{className:'brand-block'},h('div',{className:'brand-icon'},h(Icon,{name:'code',size:19})),h('div',null,h('strong',null,'ChatMCP ',h('em',null,'Studio')),h('span',null,'AGENT WORKSPACE · v'+uiVersion))),
        h('div',{className:'header-center'},h(Icon,{name:'folder',size:16}),h('span',{title:hub?.workspace?.path||''},shortPath(hub?.workspace?.path)),h('span',{className:'header-divider'},'/'),h('span',null,hub?.publicMode?'Máy chủ công khai':'Local workspace')),
        h('div',{className:'header-actions'},
          h('span',{className:`dot-status ${connected?'online':'offline'}`}),h('span',{className:'connection-text'},connected?'Hub đã kết nối':'Hub ngoại tuyến'),
          h(Button,{variant:'outline',icon:'search',title:'Command Palette · Ctrl+K',onClick:()=>this.set({paletteOpen:true,paletteQuery:''})},'Lệnh · Ctrl K'),
          h(Button,{variant:'quiet',icon:'refresh',title:'Làm mới trạng thái',onClick:()=>void this.poll(true)},'Làm mới'),
          h(Button,{variant:'outline',icon:this.state.theme==='light'?'sun':'moon',title:'Đổi giao diện sáng/tối',onClick:()=>this.setTheme(this.state.theme==='light'?'dark':'light')},this.state.theme==='light'?'Sáng':'Tối'),
          h(Button,{variant:'outline',icon:'panel',onClick:()=>this.set({inspectorOpen:!this.state.inspectorOpen})},this.state.inspectorOpen?'Ẩn công cụ':'Hiện công cụ'),
          h(Button,{variant:'outline',icon:'settings',onClick:()=>{this.set({inspectorOpen:true});this.switchTab('settings');}},'Cài đặt'),
          hub?.publicMode?h(Button,{variant:'outline',icon:'lock',title:'Kết thúc phiên đăng nhập trên trình duyệt này',onClick:()=>void this.logout()},'Đăng xuất'):null,
          loading?h('div',{className:'action-spinner'},h('div',{className:'spin'}),str(this.state.busy)):null
        )
      );
    }
    sidebar(tasks,hub){return h('aside',{className:'sessions-col'},
      h('div',{className:'sidebar-pad'},
        h(Button,{variant:'primary',icon:'plus',className:'new-session-btn',onClick:()=>this.choose('')},'Hội thoại mới'),
        h('div',{className:'search-box'},h(Icon,{name:'search',size:15}),h('input',{placeholder:'Tìm hội thoại…',value:this.state.sessionQuery,onChange:e=>this.set({sessionQuery:e.target.value}),'aria-label':'Tìm hội thoại'})),
        h('div',{className:'sidebar-label'},h('span',null,'HỘI THOẠI'),h('span',null,tasks.length))
      ),
      h('div',{className:'session-scroll'},tasks.length?tasks.map(t=>{const d=UI.describeTask(t);
        return h('button',{type:'button',key:t.id,className:`session-item ${t.id===this.state.selectedId?'selected':''}`,onClick:()=>this.choose(t.id)},
          h(Icon,{name:'history',size:17}),h('span',{className:'session-item-body'},h('strong',null,str(t.prompt,'Cuộc hội thoại').replace(/\s+/g,' ').slice(0,65)),h('small',null,shortPath(t.workspace?.path),' · ',d.state?d.label:(t.status||'Đã lưu'))),h('span',{className:`session-indicator ${d.kind}`,title:d.hint}));
      }):h(Empty,{icon:'history',title:'Chưa có cuộc hội thoại',body:'Lịch sử được lưu khi bạn bắt đầu tác vụ.'})),
      h('div',{className:'sidebar-bottom'},
        h('div',{className:'side-workspace'},h(Icon,{name:'folder'}),h('div',null,h('b',null,shortPath(hub?.workspace?.path)),h('small',null,'Workspace hiện tại'))),
        h('div',{className:'sidebar-version'},'STUDIO ',uiVersion,' · REACT · LOCAL')
      )
    );}
    chatHeader(task,active,d){const selectedId=this.state.selectedId;
      return h('div',{className:'chat-header'},
        h('div',{className:'chat-header-title'},
          h('span',{className:'eyebrow'},h(Icon,{name:'spark',size:13}),' AI CODING AGENT'),
          h('h1',null,selectedId ? str(task?.prompt,'Đang tải hội thoại…').replace(/\s+/g,' ').slice(0,86) : 'Bạn muốn xây dựng điều gì?'),
          h('div',{className:'chat-meta'},h(Tag,{kind:d.kind,title:d.hint},d.label),task?.id?h('span',{className:'muted'},'Phiên ',task.id.slice(0,8)):null,
            task?.toolCalls!==undefined?h('span',{className:'muted'},'· ',task.toolCalls,' lần gọi công cụ'):null)
        ),
        h('div',{className:'chat-toolbar'},
          selectedId?h(Button,{variant:'quiet',icon:'trash',title:'Xóa lịch sử phiên cục bộ',disabled:this.isRunning()||!!this.state.busy,onClick:()=>this.deleteSession()},'Xóa phiên'):null,
          active?h(Button,{variant:'danger',icon:'stop',onClick:()=>this.cancel()},'Dừng tác vụ'):null,
          task?.chatUrl&&/^https:\/\/chatgpt\.com\/c\//.test(task.chatUrl)?h('a',{href:task.chatUrl,target:'_blank',rel:'noopener noreferrer',className:'btn btn-outline'},h(Icon,{name:'external',size:15}),' Mở ChatGPT'):null,
          selectedId?h('a',{className:'btn btn-quiet',href:'/api/tasks/'+encodeURIComponent(selectedId)+'/report',download:true},'Báo cáo ↗'):null
        )
      );
    }
    versionNotice(){const health=this.state.health;
      return h('div',{className:'version-alert',role:'alert'},h(Icon,{name:'warning',size:20}),h('div',null,
        h('strong',null,'Giao diện và tiến trình Hub không cùng phiên bản'),
        h('p',null,`React UI ${uiVersion} yêu cầu backend ${uiVersion}, nhưng máy đang chạy Hub ${health?.version||'không rõ'} (build ${health?.uiBuild||'cũ'}). Hãy dùng STOP-CHATMCP-HUB.cmd, sau đó START-CHATMCP-HUB.cmd và Ctrl+F5. Không gửi lệnh vào backend cũ.`)
      ));
    }
    conversation(task,events,d){const inProgress=d.active;
      let exchanges=[];
      const prompts=arr(task?.prompts).length?task.prompts:task?.prompt?[{text:task.prompt,at:task.startedAt}]:[];
      const runs=arr(task?.runs);
      const runLabel=run=>run&&run.status?UI.describeTask(run).label:'Đã xử lý';
      for(let i=0;i<prompts.length;i++){
        const promptText=str(prompts[i]?.text);exchanges.push(h('div',{className:'message message-user',key:'u'+i},h('span',{className:'message-role'},'BẠN · YÊU CẦU ',i+1),h('div',{className:'message-text'},promptText)));
        const result=str(runs[i]?.finalText);
        if(result)exchanges.push(h('div',{className:'message message-agent',key:'a'+i},h('div',{className:'agent-avatar'},h(Icon,{name:'bot',size:17})),h('div',{className:'message-card'},h('span',{className:'message-role'},'AGENT · ',runLabel(runs[i])),h('div',{className:'message-text'},result.slice(0,20000)))));
      }
      if(!exchanges.length && task?.finalText)exchanges.push(h('div',{className:'message message-agent',key:'final'},h('div',{className:'message-card'},h('span',{className:'message-role'},'AGENT'),h('div',{className:'message-text'},task.finalText))));
      return h('div',{className:'chat-scroll'},
        !task?h('div',{className:'welcome'},h('div',{className:'welcome-logo'},h(Icon,{name:'spark',size:28})),h('h2',null,'Một workspace. Một agent. Liên tục.'),h('p',null,'Giao việc, theo dõi file và công cụ, xem Git diff, kiểm thử, rồi tiếp tục ngay trong hội thoại cũ.'),
          h('div',{className:'suggestion-grid'},[
            ['Tìm hiểu dự án','Đọc README và cấu trúc thư mục, cho tôi biết dự án làm gì, cách chạy và cách kiểm thử. Chỉ đọc, không sửa file nào.'],
            ['Sửa lỗi','Tìm nguyên nhân của lỗi tôi sẽ mô tả, viết một test tái hiện lỗi, sửa tối thiểu rồi chạy kiểm thử và báo kết quả thực tế.'],
            ['Viết kiểm thử','Rà soát test hiện tại, bổ sung các regression test cần thiết cho phần chưa được kiểm tra và chạy bộ kiểm thử phù hợp.']
          ].map(([title,prompt])=>h('button',{key:title,onClick:()=>this.set({prompt})},h('strong',null,title),h('span',null,'↗'))))
        ):h('div',{className:'chat-stream'},this.planCard(),exchanges,
          inProgress?h('div',{className:'live-card',title:d.hint},h('div',{className:'spin'}),h('div',null,h('strong',null,d.label),h('p',null,str(events[events.length-1]?.message,'Đang chờ bước tiếp theo…')))):null,
          inProgress&&this.state.streamingToken?h('div',{className:'message message-agent streaming',key:'streaming'},h('div',{className:'agent-avatar'},h(Icon,{name:'bot',size:17})),h('div',{className:'message-card'},h('span',{className:'message-role'},'AGENT · Đang trả lời…'),h('div',{className:'message-text streaming-text'},this.state.streamingToken))):null,
          task?.error&&d.state!=='failed'?h('div',{className:'inline-error'},h(Icon,{name:'warning',size:16}),h('div',null,h('strong',null,task.errorCode||'Tác vụ cần xử lý'),h('p',null,task.error))):null,
          !inProgress&&task?.finalText&&!runs.some(r=>r.finalText)?h('div',{className:'message message-agent'},h('div',{className:'message-card'},h('div',{className:'message-text'},task.finalText))):null,
          this.resultFooter(task,d)
        ),
        task&&events.length?h('div',{className:'recent-work'},h('div',{className:'mini-section-title'},h(Icon,{name:'history',size:15}),' HOẠT ĐỘNG GẦN ĐÂY'),events.slice(-5).map((e,i)=>h('div',{className:'mini-event',key:i},h('span',null,formatTime(e.at)),h('span',null,str(e.toolName||e.type)),h('span',null,UI.eventText(e,130))))):null
      );
    }
    composer(ready,wrongMode){const s=this.state,hasTask=!!s.selectedId,running=this.isRunning(),canSend=ready.ready&&!running&&!s.busy&&!!s.prompt.trim();
      return h('div',{className:'composer-wrap'},
        wrongMode?h('div',{className:'composer-warning'},'Phiên này thuộc chế độ ',this.chosenSummary()?.transport,'. ',h('button',{onClick:()=>this.changeMode(this.chosenSummary().transport)},'Chuyển sang chế độ đó')):null,
        this.blockerStrip(ready),
        h('div',{className:'composer'},
          h('textarea',{id:'agent-prompt',rows:3,placeholder:hasTask?'Tiếp tục công việc trong đúng hội thoại này…':'Hãy mô tả tác vụ bạn muốn agent thực hiện…',value:s.prompt,onChange:e=>this.set({prompt:e.target.value}),onKeyDown:e=>{if(e.key==='Enter'&&!e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();this.send();}}}),
          h('div',{className:'composer-footer'},
            h('div',{className:'composer-config'},this.permissionSwitch(),this.providerChip()),
            h(Button,{variant:'primary',icon:'arrow',className:'send-btn',disabled:!canSend,onClick:()=>this.send()},hasTask?'Tiếp tục':'Bắt đầu')
          )
        ),
        h('p',{className:'composer-hint'},UI.composerHint(ready,{running,connected:s.connected,pending:this.pendingApprovals().length}))
      );
    }
    inspector(hub,task){const tabs=[['activity','Hoạt động','history'],['files','Files','folder'],['git','Git','git'],['terminal','Terminal','terminal'],['intelligence',hub?.publicMode?'Code':'Code / LSP','layers'],['preview','Preview','eye'],['plan','Plan','note'],['skills','Skills','spark'],['settings','Cài đặt','settings']].filter(([id])=>!(hub?.publicMode&&id==='preview'));
      return h('aside',{className:'inspector-col'},
        h('div',{className:'inspector-top'},h('div',{className:'inspector-label'},'CÔNG CỤ DỰ ÁN'),
          h('nav',{className:'inspector-tabs','aria-label':'Công cụ coding'},tabs.map(([id,title,icon])=>h('button',{key:id,className:this.state.tab===id?'active':'',title,onClick:()=>this.switchTab(id)},h(Icon,{name:icon,size:17}),h('span',null,title)))))
        ,h('div',{className:'inspector-content'},
          this.state.tab==='activity'?this.activityPanel(hub,task):null,
          this.state.tab==='files'?this.filesPanel():null,
          this.state.tab==='git'?this.gitPanel():null,
          this.state.tab==='terminal'?this.terminalPanel():null,
          this.state.tab==='intelligence'?this.intelligencePanel():null,
          this.state.tab==='preview'?this.previewPanel():null,
          this.state.tab==='plan'?this.planPanel():null,
          this.state.tab==='skills'?this.skillsPanel():null,
          this.state.tab==='settings'?this.settingsPanel(hub):null
        )
      );
    }
    activityPanel(hub,task){const events=arr(task?.events),d=UI.describeTask(task),tools=UI.toolsState(hub),history=arr(task?.stateHistory);
      return h('div',{className:'panel-content'},
        h(Section,{title:'Agent status',action:h(Tag,{kind:d.kind,title:d.hint},task?d.label:'Chờ tác vụ')},
          task?.stateReason?h('p',{className:'small-note'},UI.reasonText(task.stateReason)):null,
          h('div',{className:'metrics-row'},h('div',null,h('b',null,task?.steps||0),h('span',null,'Phản hồi AI')),h('div',null,h('b',null,task?.toolCalls||0),h('span',null,'Lần gọi công cụ')),h('div',null,h('b',null,arr(task?.prompts).length),h('span',null,'Yêu cầu'))),
          history.length?h('details',{className:'state-history'},h('summary',null,'Lịch sử trạng thái ('+history.length+')'),
            h('ul',null,history.slice(-8).reverse().map((entry,i)=>h('li',{key:i},h('time',null,formatTime(entry.at)),' ',UI.STATES[entry.to]?.label||str(entry.to),entry.reason?h('small',null,' · '+UI.reasonText(entry.reason)):null)))):null,
          task?.id?h('div',{className:'toggle-row'},h('div',null,h('strong',null,'Tự tiếp tục sau restart'),h('small',null,'Chỉ khi thao tác cũ đã xác minh an toàn')),h('input',{type:'checkbox',checked:!!task.autoResume,disabled:this.isRunning(),onChange:e=>this.sessionRecovery(e.target.checked)})):null
        ),
        h(Section,{title:'Timeline',action:h('span',{className:'muted'},events.length+' sự kiện')},
          events.length?h('div',{className:'timeline'},events.slice(-80).reverse().map((e,i)=>h('div',{className:'timeline-row',key:i},h('div',{className:'timeline-dot '+(e.toolName?'tool':'')}),h('div',null,h('time',null,formatTime(e.at)),e.toolName?h('code',null,e.toolName):null,h('p',null,UI.eventText(e,600)))))):h(Empty,{icon:'history',title:'Chưa có hoạt động',body:'Model và các lần gọi công cụ sẽ hiện ở đây.'})
        ),
        tools.backend==='local'
          ?h(Section,{title:'Công cụ dự án'},h('div',{className:'service-grid'},h('div',{className:'service-row'},h('span',{className:`status-circle ${statusKind(tools.state)}`}),'Công cụ cục bộ',h(Tag,{kind:statusKind(tools.state)},tools.state||'—'))),
            tools.detail?h('p',{className:'small-note'},tools.detail):null)
          :h(Section,{title:'MCP Services'},h('div',{className:'service-grid'},Object.entries(serviceNames).map(([id,name])=>h('div',{className:'service-row',key:id},h('span',{className:`status-circle ${statusKind(hub?.services?.[id]?.state)}`}),name,h(Tag,{kind:statusKind(hub?.services?.[id]?.state)},hub?.services?.[id]?.state||'—'))))),
        h(Section,{title:'Hub Logs'},h('pre',{className:'log-display'},arr(hub?.logs).slice(-24).join('\n')||'Chưa có log.'))
      );
    }
    filesPanel(){const s=this.state;
      return h('div',{className:'panel-content'},
        h(Section,{title:'Explorer',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>this.loadTree()},'Tải lại')},
          h('div',{className:'folder-path'},h('button',{onClick:()=>this.loadTree(s.workspaceFolder.split('/').slice(0,-1).join('/'))},'←'),s.workspaceFolder||'/'),
          h('div',{className:'file-list'},s.fileEntries.map(e=>h('button',{key:e.path,onClick:()=>e.kind==='directory'?this.loadTree(e.path):e.kind==='file'?this.openFile(e.path):null},h(Icon,{name:e.kind==='directory'?'folder':'file',size:14}),h('span',null,e.name),e.kind==='directory'?h('b',null,'›'):null))),
          !s.fileEntries.length?h(Empty,{icon:'folder',title:'Chưa tải cây file',body:'Chọn workspace và bấm Tải lại.'}):null
        ),
        h(Section,{title:'Tìm codebase'},h('div',{className:'search-tools'},h('input',{value:s.codeQuery,placeholder:'Function, class hoặc từ khóa...',onChange:e=>this.set({codeQuery:e.target.value}),onKeyDown:e=>e.key==='Enter'&&this.searchCode()}),h('select',{value:s.codeSearchMode,onChange:e=>this.set({codeSearchMode:e.target.value})},[['text','Text'],['symbol','Symbol'],['filename','Filename']].map(([v,label])=>h('option',{value:v,key:v},label))),h(Button,{variant:'outline',icon:'search',onClick:()=>this.searchCode()},'Tìm')),
          h('div',{className:'search-results'},s.codeMatches.slice(0,70).map((m,i)=>h('button',{key:i,onClick:()=>this.openFile(m.path)},h('strong',null,m.path,m.line?':'+m.line:''),h('span',null,str(m.text).slice(0,170)))))
        ),
        h(Section,{title:s.file?'Editor · '+s.file.path:'Code Editor',action:s.file?h(Button,{variant:'quiet',onClick:()=>this.set({editing:!s.editing,fileDraft:s.file.content})},s.editing?'Hủy sửa':'Sửa file'):null},
          s.file?h('div',{className:'code-view'},h('div',{className:'code-meta'},'SHA-256 ',s.file.sha256?.slice(0,14),' · ',s.file.size,' bytes'),s.editing?h('textarea',{className:'code-editor',spellCheck:false,value:s.fileDraft,onChange:e=>this.set({fileDraft:e.target.value})}):h('pre',null,s.file.content),s.editing?h(Button,{variant:'primary',icon:'save',onClick:()=>this.saveFile()},'Lưu có checkpoint'):null):h(Empty,{icon:'code',title:'Chọn file để xem',body:'Bạn có thể sửa file thủ công với kiểm tra checksum trước khi ghi.'})
        )
      );
    }
    gitPanel(){const s=this.state;
      return h('div',{className:'panel-content'},
        h(Section,{title:'Git changes',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>this.loadGit()},'Tải lại')},
          h('div',{className:'button-row'},h(Button,{variant:'outline',onClick:()=>this.gitDiff()},'Diff'),h(Button,{variant:'outline',onClick:()=>this.diffCheck()},'Diff check'),h(Button,{variant:'primary',onClick:()=>this.checkpoint()},'Checkpoint')),
          h('p',{className:'small-note'},s.gitStatus?.head?'HEAD · '+s.gitStatus.head.slice(0,12):'Chưa đọc Git HEAD'),
          h('pre',{className:'git-lines'},arr(s.gitStatus?.entries).join('\n')||'Không có thay đổi được Git nhận diện.'),
          s.gitDiff?h('pre',{className:'diff-view'},s.gitDiff.diff||'Không có tracked unstaged diff.'):null
        ),
        h(Section,{title:'Snapshot review'},
          h('div',{className:'button-row'},h('select',{value:s.checkpointId,onChange:e=>this.set({checkpointId:e.target.value,review:null})},h('option',{value:''},'Chọn checkpoint'),s.checkpoints.map(c=>h('option',{value:c.id,key:c.id},formatTime(c.at)+' · '+c.label))),h(Button,{variant:'outline',onClick:()=>this.loadReview()},'Review')),
          h('p',{className:'small-note'},'Snapshot chỉ sao lưu một số file văn bản, không thay thế Git hoặc backup toàn bộ.'),
          s.review?h('div',{className:'review-list'},!s.review.changes.length?h('p',null,'Không có file khác so với checkpoint.'):null,s.review.changes.map(change=>h('div',{className:'review-card',key:change.path},h('strong',null,change.path),h('pre',{className:'diff-view'},change.diff||'File khác checkpoint.'),change.currentSha?h('div',{className:'button-row'},h(Button,{variant:'outline',onClick:()=>this.decideReview('accept',change)},'Accept'),h(Button,{variant:'danger',onClick:()=>this.decideReview('restore',change)},'Restore')):null))):null
        )
      );
    }
    terminalPanel(){const s=this.state, selected=s.terminals.find(x=>x.id===s.currentTerminalId)||s.terminals[s.terminals.length-1], pub=s.hub?.publicMode, noShell=pub&&pub.execMode!=='broker';
      return h('div',{className:'panel-content'},
        h(Section,{title:pub?'Terminal · Lệnh trên máy chủ':'Terminal · Windows local',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>this.loadTerminal()},'Tải lại')},
          pub?h('p',{className:'small-note'},noShell?'Máy chủ này không tách được quyền cho lệnh của agent nên chạy lệnh đã bị tắt. Agent vẫn đọc/sửa file và dùng công cụ Git.':'Mỗi lệnh chạy bằng một tài khoản riêng, không đọc được bí mật của Hub, từng lệnh một; mọi tiến trình con bị dừng khi lệnh kết thúc. Lệnh cần bạn xác nhận ở chế độ Review.')
          :h('p',{className:'small-note danger-text'},this.state.terminalSandbox?'Docker sandbox: mã chạy trong Linux container không mạng, chỉ đọc workspace.':'Host Windows: không sandbox; mỗi lệnh cần xác nhận.'),
          pub?null:h('div',{className:'terminal-options'},
            h('label',null,h('input',{type:'checkbox',checked:s.terminalSandbox,onChange:e=>this.set({terminalSandbox:e.target.checked,terminalInteractive:e.target.checked?false:s.terminalInteractive})}),' Docker sandbox (read-only)'),
            h('label',null,h('input',{type:'checkbox',checked:s.terminalInteractive,disabled:s.terminalSandbox,onChange:e=>this.set({terminalInteractive:e.target.checked})}),' Shell tương tác'),
            h('span',{className:'muted'},s.terminalSandbox?'Không mạng · Giới hạn tài nguyên':'Quyền Windows hiện tại')),
          h('div',{className:'terminal-input'},h('input',{placeholder:s.terminalInteractive?'Lệnh khởi tạo (có thể để trống)':'python -m pytest -q',value:s.terminalCommand,onChange:e=>this.set({terminalCommand:e.target.value}),onKeyDown:e=>e.key==='Enter'&&this.startTerminal()}),h(Button,{variant:'primary',icon:'play',disabled:this.isRunning()||noShell,onClick:()=>this.startTerminal()},'Run')),
          selected?h('div',{className:'terminal-box'},h('div',{className:'terminal-head'},h(Tag,{kind:statusKind(selected.status)},selected.status),h('span',null,'Exit ',selected.exitCode??'…'),h(Button,{variant:'quiet',icon:'stop',onClick:()=>this.stopTerminal()},'Stop')),h('pre',null,'$ ',selected.command,'\n',arr(selected.logs).map(x=>str(x.message)).join('')),
            h('div',{className:'terminal-mode'},'Mode: ',selected.mode||'host',selected.mode==='pipes'?' · ConPTY chưa được cài':''),
            selected.interactive&&selected.status==='running'?h('div',{className:'terminal-input'},h('input',{placeholder:'Nhập vào shell rồi Enter…',value:s.terminalInput,onChange:e=>this.set({terminalInput:e.target.value}),onKeyDown:e=>e.key==='Enter'&&this.writeTerminal()}),h(Button,{variant:'outline',onClick:()=>this.writeTerminal()},'Gửi stdin')):null):h(Empty,{icon:'terminal',title:'Terminal trống',body:'Chạy một lệnh để xem đầu ra tại đây.'})
        ),
        h(Section,{title:'Project Verification · bằng chứng kiểm thử'},
          h('p',{className:'small-note'},'Chỉ chạy lệnh gợi ý được phát hiện từ cấu hình dự án. Bạn phải xác nhận; exit code và tóm tắt output được lưu qua lần khởi động lại Hub.'),
          arr(s.suggestedChecks).length?h('div',{className:'verify-suggestions'},s.suggestedChecks.map((item,i)=>h('div',{className:'verify-suggestion',key:i},h('code',null,item.command),h('small',null,item.from),h(Button,{variant:'outline',icon:'play',onClick:()=>this.verifyProject(item.command),disabled:this.isRunning()},'Run check')))):h('p',{className:'small-note'},'Chưa tìm thấy file cấu hình kiểm thử phổ biến. Bạn vẫn có thể chạy lệnh trong Terminal thủ công.'),
          h('div',{className:'verification-history'},arr(s.verificationRuns).map(run=>h('div',{className:'verification-row',key:run.id},
            h('div',{className:'verification-head'},h(Tag,{kind:run.status==='completed'&&run.exitCode===0?'success':run.status==='running'?'working':'error'},run.status==='completed'&&run.exitCode===0?'PASS':run.status==='running'?'RUNNING':run.status==='interrupted'?'UNCONFIRMED':'FAIL'),h('code',null,run.command)),
            h('small',null,formatTime(run.startedAt),' · ',run.exitCode===null?'Exit ?':`Exit ${run.exitCode}`),run.outputPreview?h('pre',null,run.outputPreview):null
          )))
        )
      );
    }
    planPanel(){
      const p=this.state.plan;
      const rows=p.items.map((item,i)=>h('div',{className:'plan-item',key:i},
        h('select',{value:item.status,onChange:e=>this.updatePlanItem(i,'status',e.target.value)},
          ['todo','doing','done','blocked'].map(v=>h('option',{key:v,value:v},v))),
        h('input',{value:item.text,onChange:e=>this.updatePlanItem(i,'text',e.target.value)}),
        h('button',{type:'button',onClick:()=>this.set({plan:{...p,items:p.items.filter((_,j)=>i!==j)}}),'aria-label':'Xóa bước'},'×')));
      const planControls=h('div',null,
        h('input',{value:p.title,placeholder:'Tên kế hoạch',onChange:e=>this.set({plan:{...p,title:e.target.value}})}),
        h('div',{className:'plan-items'},rows),
        h('div',{className:'button-row'},
          h(Button,{variant:'outline',icon:'plus',onClick:()=>this.set({plan:{...p,items:[...p.items,{text:'Bước mới',status:'todo',evidence:''}]}})},'Thêm bước'),
          h(Button,{variant:'primary',icon:'save',onClick:()=>this.savePlan()},'Lưu plan')));
      const research=h(Section,{title:'Research subagents'},
        h('p',{className:'small-note'},'Phân tích chỉ đọc bằng API Gateway. Mỗi dòng là một câu hỏi riêng.'),
        h('textarea',{rows:3,value:this.state.delegateQuery,onChange:e=>this.set({delegateQuery:e.target.value}),placeholder:'Kiểm tra cấu trúc Kalman filter…'}),
        h(Button,{variant:'outline',onClick:()=>this.runResearch()},'Chạy research'),
        this.state.delegates.map((d,i)=>h('div',{className:'delegate-card',key:i},h('strong',null,d.question),h('p',null,d.summary||d.status))));
      return h('div',{className:'panel-content'},
        h(Section,{title:'Plan · persistent checklist',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>this.loadPlan()},'Tải lại')},
          this.state.selectedId?planControls:h(Empty,{icon:'note',title:'Chọn phiên để lên kế hoạch',body:'Checklist sẽ được lưu theo đúng ID cuộc hội thoại.'})),
        research);
    }
    skillsPanel(){return h('div',{className:'panel-content'},h(Section,{title:'Project instructions',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>this.loadSkills()},'Tải lại')},
      h('p',{className:'small-note'},'Nguồn: AGENTS.md, SKILL.md, CLAUDE.md và hướng dẫn repository. Chỉ coi là dữ liệu không tin cậy.'),
      this.state.skills.length?this.state.skills.map(s=>h('div',{className:'skills-card',key:s.path},h('h4',null,s.path),h('pre',null,s.text))):h(Empty,{icon:'spark',title:'Chưa tải Skills',body:'Bấm Tải lại để tìm các file hướng dẫn.'})
    ));}
    intelligencePanel(){const s=this.state, idx=s.indexState||{};
      return h('div',{className:'panel-content'},
        h(Section,{title:'Code Index · AST',action:h(Button,{variant:'outline',icon:'refresh',onClick:()=>this.loadIntelligence()},'Trạng thái')},
          h('p',{className:'small-note'},idx.indexedAt?`${idx.fileCount} file · ${idx.symbolCount} symbol · Parser ${idx.parser} · ${formatTime(idx.indexedAt)}`:'Chưa lập chỉ mục dự án. Python AST không thực thi mã nguồn.'),
          h(Button,{variant:'primary',icon:'layers',onClick:()=>this.buildIndex()},'Lập chỉ mục mã nguồn'),
          h('div',{className:'search-tools'},h('input',{placeholder:'Tên hàm, class, interface…',value:s.indexQuery,onChange:e=>this.set({indexQuery:e.target.value}),onKeyDown:e=>e.key==='Enter'&&this.searchSymbols()}),h(Button,{variant:'outline',icon:'search',onClick:()=>this.searchSymbols()},'Tìm')),
          h('div',{className:'semantic-matches'},s.indexMatches.map((item,i)=>h('div',{className:'semantic-row',key:i},h('button',{onClick:()=>{this.switchTab('files');this.openFile(item.path);}},h('strong',null,item.name),h('small',null,`${item.path}:${item.line} · ${item.kind} · ${item.precision}`)),h(Button,{variant:'quiet',onClick:()=>this.findReferences(item.name)},'Refs')))),
          s.referenceMatches.length?h('div',{className:'semantic-matches'},h('h4',null,'Tham chiếu theo tên (chưa type-resolve)'),s.referenceMatches.map((r,i)=>h('button',{key:i,onClick:()=>{this.switchTab('files');this.openFile(r.path);}},`${r.path}:${r.line} · ${r.name}`))):null
        ),
        s.hub?.publicMode?null:h(Section,{title:'Language Server Protocol (LSP)'},
          h('p',{className:'small-note'},'Cần cài Pyright hoặc TypeScript Language Server trên Windows. LSP cung cấp definition, references, hover và diagnostics có ngữ nghĩa khi server sẵn sàng.'),
          h('label',{className:'form-field'},'Language Server',h('select',{value:s.lspLanguage,onChange:e=>this.set({lspLanguage:e.target.value})},h('option',{value:'python'},'Python · pyright-langserver'),h('option',{value:'typescript'},'TypeScript · typescript-language-server'))),
          h(Button,{variant:'outline',icon:'play',onClick:()=>this.lspStart()},'Khởi động LSP'),
          h('div',{className:'search-tools'},h('input',{placeholder:'File tương đối (ví dụ student/kalman.py)',value:s.lspFile,onChange:e=>this.set({lspFile:e.target.value})})),
          h('div',{className:'search-tools'},h('label',null,'Dòng ',h('input',{type:'number',min:1,value:s.lspLine,onChange:e=>this.set({lspLine:e.target.value})})),h('label',null,'Cột ',h('input',{type:'number',min:1,value:s.lspColumn,onChange:e=>this.set({lspColumn:e.target.value})}))),
          h('div',{className:'button-row'},['definition','references','hover','diagnostics'].map(m=>h(Button,{variant:'outline',key:m,onClick:()=>this.lspJump(m)},m))),
          s.lspResult?h('pre',{className:'code-view'},JSON.stringify(s.lspResult.result??s.lspResult.diagnostics,null,2).slice(0,14000)):null,
          h('p',{className:'small-note'},'Không cài language server: vẫn dùng tìm kiếm AST, nhưng không có rename/refactor bảo đảm đúng kiểu.')
        )
      );
    }
    previewPanel(){const s=this.state,info=s.previewInfo;
      return h('div',{className:'panel-content'},
        h(Section,{title:'Local App Preview'},
          h('p',{className:'small-note'},'Khởi động dev server qua Terminal trước. Chỉ xem localhost, iframe không được truy cập Origin của dashboard.'),
          h('div',{className:'search-tools'},h('label',null,'Cổng ',h('input',{type:'number',min:1024,max:65535,value:s.previewPort,onChange:e=>this.set({previewPort:e.target.value})})),h('label',null,'Đường dẫn ',h('input',{value:s.previewPath,onChange:e=>this.set({previewPath:e.target.value})}))),
          h(Button,{variant:'primary',icon:'refresh',onClick:()=>this.checkPreview()},'Kiểm tra preview'),
          info?h('p',{className:'small-note'},info.ready?'● Dev server đang chạy':'Chưa kết nối: '+info.detail):null,
          info?.ready?h('div',{className:'preview-frame'},h('div',{className:'preview-toolbar'},h('span',null,info.url),h('a',{href:info.url,target:'_blank',rel:'noopener noreferrer'},'Mở tab ↗')),
            h('iframe',{title:'Local app preview',src:info.url,sandbox:'allow-scripts allow-forms',referrerPolicy:'no-referrer'})):h(Empty,{icon:'eye',title:'Chưa có ứng dụng để xem',body:'Khởi động npm run dev hoặc python -m http.server trên máy rồi nhập port.'})
        )
      );
    }
    // ---- the workspace list of the public server (also the "project folder" step of the first-run wizard) ----
    workspacePanel(){const s=this.state,hub=s.hub,pub=hub?.publicMode,list=s.wsList,items=arr(list?.items),busy=!!s.busy,running=this.isRunning(),pushed=s.wsPushed;
      return h('div',{className:'workspace-panel'},
        h('p',{className:'small-note'},'Workspace nằm trên máy chủ này, không phải trên máy bạn. Hãy clone một kho GitHub hoặc tạo kho trống; agent chỉ làm việc trong workspace đang chọn.'),
        pub?.storageNote?h('p',{className:'small-note danger-text'},str(pub.storageNote)):null,
        h('div',{className:'workspace-list'},items.length?items.map(item=>h('div',{key:item.name,className:`workspace-item${item.current?' current':''}`},
          h('div',null,h('b',null,item.name),h('small',null,item.origin?`${item.origin.host}/${item.origin.owner}/${item.origin.repo}`:'Kho trống do Hub tạo',item.branch?` · nhánh ${item.branch}`:'')),
          h('div',{className:'button-row'},
            item.current?h(Tag,{kind:'success'},'Đang dùng'):h(Button,{variant:'outline',disabled:busy||running,onClick:()=>void this.useWorkspace(item.path)},'Chọn'),
            h('a',{className:'inline-link',href:`/api/workspace/export?name=${encodeURIComponent(item.name)}`,download:`${item.name}.tar.gz`,title:'Tải working tree (.tar.gz, không gồm .git)'},'Tải về'),
            item.origin&&list?.pushEnabled?h(Button,{variant:'outline',disabled:busy||running,title:'Đẩy các commit mới lên một nhánh chatmcp/… mới của kho gốc',onClick:()=>void this.pushWorkspace(item.name)},'Push'):null,
            h(Button,{variant:'danger',disabled:busy||running,onClick:()=>void this.deleteWorkspace(item.name)},'Xóa')))):h(Empty,{icon:'folder',title:'Chưa có workspace',body:'Clone một kho GitHub hoặc tạo kho trống bên dưới.'})),
        list?h('p',{className:'small-note'},`${list.count}/${list.max} workspace · máy chủ Git cho phép: ${arr(list.gitHosts).join(', ')} · ${list.pushEnabled?'Push lên GitHub: đã bật':'Push lên GitHub: tắt (chưa đặt GITHUB_TOKEN)'}`):null,
        list?.pushEnabled?h('label',{className:'form-field'},'Tên nhánh khi push (tùy chọn)',h('input',{value:s.wsPushBranch,placeholder:'để trống = tự đặt chatmcp/ngày-giờ',spellCheck:false,onChange:e=>this.set({wsPushBranch:e.target.value})})):null,
        pushed?h('div',{className:'onboarding-status ok',role:'status'},h(Icon,{name:'check',size:15}),h('span',null,`Đã đẩy ${pushed.commits} commit lên nhánh `,h('code',null,pushed.branch),pushed.compareUrl?h('span',null,' · ',h('a',{className:'inline-link',href:pushed.compareUrl,target:'_blank',rel:'noopener noreferrer'},'Mở trên GitHub ↗')):null),
          ...(arr(pushed.warnings).map((warning,index)=>h('small',{key:index},' '+warning)))):null,
        h('div',{className:'workspace-form'},
          h('label',{className:'form-field'},'Clone từ GitHub',h('input',{id:'workspace-clone-url',value:s.wsCloneUrl,placeholder:'https://github.com/chu-so-huu/ten-kho',spellCheck:false,autoComplete:'off',onChange:e=>this.set({wsCloneUrl:e.target.value}),onKeyDown:e=>{if(e.key==='Enter'&&s.wsCloneUrl.trim()&&!busy&&!running){e.preventDefault();void this.cloneWorkspace();}}})),
          h('label',{className:'form-field'},'Nhánh (tùy chọn)',h('input',{value:s.wsCloneBranch,placeholder:'mặc định của kho',spellCheck:false,onChange:e=>this.set({wsCloneBranch:e.target.value})})),
          h(Button,{variant:'primary',icon:'git',disabled:busy||running||!s.wsCloneUrl.trim(),onClick:()=>void this.cloneWorkspace()},'Clone')),
        h('div',{className:'workspace-form'},
          h('label',{className:'form-field'},'Hoặc tạo workspace trống',h('input',{id:'workspace-new-name',value:s.wsNewName,placeholder:'ten-du-an (chữ thường, số, . _ -)',spellCheck:false,autoComplete:'off',onChange:e=>this.set({wsNewName:e.target.value}),onKeyDown:e=>{if(e.key==='Enter'&&s.wsNewName.trim()&&!busy&&!running){e.preventDefault();void this.createWorkspace();}}})),
          h(Button,{variant:'outline',icon:'plus',disabled:busy||running||!s.wsNewName.trim(),onClick:()=>void this.createWorkspace()},'Tạo')));
    }
    publicSettingsPanel(hub){const s=this.state,pub=hub.publicMode,perm=this.permMode(),execLabel={broker:'Lệnh của agent chạy bằng tài khoản riêng qua môi giới lệnh',['no-shell']:'Chạy lệnh đã tắt (không tách được quyền): chỉ công cụ file và Git','same-user':'KHÔNG AN TOÀN: lệnh chạy cùng tài khoản với Hub (chỉ để thử)'}[pub.execMode]||pub.execMode;
      return h('div',{className:'panel-content'},
        h(Section,{title:'Workspace',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>void this.loadWorkspaces()},'Tải lại')},this.workspacePanel()),
        h(Section,{title:'Nhà cung cấp AI'},this.providerForm()),
        h(Section,{title:'Quyền của agent'},
          h('label',{className:'form-field'},'Chế độ phê duyệt',h('select',{id:'permission-mode',disabled:!!s.busy,value:perm,onChange:e=>this.setPermission(e.target.value)},UI.PERMISSION_MODES.map(entry=>h('option',{key:entry.id,value:entry.id},entry.id==='review'?entry.label+' (khuyến nghị)':entry.label)))),
          h('p',{className:'small-note'},UI.modeInfo(perm).hint),
          h('p',{className:'small-note'},'Máy chủ công khai luôn ở chính sách host-review: không có Full Access và không có Docker sandbox. Agent không đọc được token đăng nhập, khóa model hay GitHub token của Hub.')),
        h(Section,{title:'Giao diện'},h('div',{className:'theme-switch'},[['light','Sáng','sun'],['dark','Tối','moon'],['system','Theo máy','settings']].map(([v,label,ico])=>h('button',{type:'button',key:v,className:s.theme===v?'active':'',onClick:()=>this.setTheme(v)},h(Icon,{name:ico,size:16}),label)))),
        h(Section,{title:'Máy chủ'},
          h('p',{className:'small-note'},execLabel),
          h('p',{className:'small-note'},str(pub.storageNote)),
          h('p',{className:'small-note'},'Đã tắt vì không phù hợp khi công khai: '+arr(pub.disabled).join(', ')+'.'),
          h('div',{className:'button-row'},h(Button,{variant:'outline',icon:'lock',onClick:()=>void this.logout()},'Đăng xuất'))),
        h(Section,{title:'Phiên bản hệ thống'},h('p',{className:'small-note'},`UI ${uiVersion} · Backend ${hub?.version||'…'} · Build ${this.state.health?.uiBuild||'…'}`)));
    }
    settingsPanel(hub){if(hub?.publicMode)return this.publicSettingsPanel(hub);const s=this.state, local=UI.backendOf(hub)==='local', tools=UI.toolsState(hub), guide=UI.onboarding(hub,{dismissed:false}), mode=this.mode(), perm=this.permMode();
      return h('div',{className:'panel-content'},
        local?h(Section,{title:'Thiết lập nhanh',action:h(Tag,{kind:guide.complete?'success':'warn'},guide.complete?'Sẵn sàng':'Chưa xong')},
          h('div',{className:'checklist'},guide.steps.filter(step=>step.id==='workspace'||step.id==='ai').map(step=>h('div',{className:'check-row',key:step.id},h(Icon,{name:step.done?'check':'warning',size:15}),h('span',null,step.title),h(Tag,{kind:step.done?'success':'warn'},step.done?'Xong':'Cần làm')))),
          h(Button,{variant:'outline',icon:'spark',onClick:()=>this.set({onboardingOpen:true,onboardingStep:guide.current})},'Mở trình hướng dẫn')):null,
        h(Section,{title:'Workspace'},h('div',{className:'settings-input'},h('input',{value:s.workspaceDraft,placeholder:'F:\\Projects\\repo',onChange:e=>this.set({workspaceDraft:e.target.value})}),h('div',{className:'button-row'},h(Button,{variant:'outline',onClick:()=>this.browseWorkspace()},'Chọn thư mục'),h(Button,{variant:'primary',onClick:()=>this.changeWorkspace(),disabled:this.isRunning()},'Áp dụng')))),
        h(Section,{title:'Nhà cung cấp AI'},
          mode==='chatgpt-web'?h('p',{className:'small-note'},'Đang ở chế độ ChatGPT Web: cấu hình dưới đây chỉ được dùng khi bạn chuyển sang chế độ API.'):null,
          this.providerForm()),
        h(Section,{title:'Quyền của agent'},
          h('label',{className:'form-field'},'Chế độ phê duyệt',h('select',{id:'permission-mode',disabled:s.executionPolicy==='full-access'||!!s.busy,value:perm,onChange:e=>this.setPermission(e.target.value)},UI.PERMISSION_MODES.map(entry=>h('option',{key:entry.id,value:entry.id},entry.id==='review'?entry.label+' (khuyến nghị)':entry.label)))),
          h('p',{className:'small-note'},UI.modeInfo(perm).hint),
          h('p',{className:'small-note'},s.executionPolicy==='full-access'?'Full Access ghi đè cơ chế này: tất cả công cụ được chấp nhận không hỏi thêm. Không cấp quyền administrator hay vượt qua ACL Windows.':'Agent làm việc bằng quyền Windows của bạn; chọn workspace không tạo sandbox hệ điều hành. Lệnh shell và thao tác nguy hiểm luôn cần bạn xác nhận ở chế độ Review. File nhạy cảm (.env, khóa, .git) được bảo vệ.')),
        h(Section,{title:'AI mode'},h('div',{className:'mode-grid'},[['chatgpt-web','ChatGPT Web','Chế độ cũ, thử nghiệm: bạn tự đăng nhập, dùng Companion'],['api','API Gateway','Gemini, OpenAI, Anthropic, Ollama và gateway tương thích']].map(([id,title,description])=>h('button',{key:id,className:`mode-option ${mode===id?'active':''}`,disabled:this.isRunning()||!!s.busy,onClick:()=>this.changeMode(id)},h(Icon,{name:id==='api'?'bot':'external',size:18}),h('div',null,h('strong',null,title),h('small',null,description)),h('span',{className:'mode-mark'},mode===id?'✓':''))))),
        h(Section,{title:'Giao diện'},h('div',{className:'theme-switch'},[['light','Sáng','sun'],['dark','Tối','moon'],['system','Theo máy','settings']].map(([v,label,ico])=>h('button',{type:'button',key:v,className:s.theme===v?'active':'',onClick:()=>this.setTheme(v)},h(Icon,{name:ico,size:16}),label)))),
        h(Section,{title:'Tính năng trên máy này',action:h(Button,{variant:'quiet',icon:'refresh',onClick:()=>this.loadCapabilities()},'Kiểm tra')},
          h('div',{className:'capability-list'},
            h('div',null,h('strong',null,'Docker sandbox lệnh'),h(Tag,{kind:s.sandboxStatus?.ready?'success':'neutral'},s.sandboxStatus?.ready?'Sẵn sàng':'Cần Docker Desktop Linux')),
            h('div',null,h('strong',null,'Terminal PTY (ConPTY)'),h(Tag,{kind:s.terminalCaps?.nativeConPTY?'success':'neutral'},s.terminalCaps?.nativeConPTY?'Sẵn sàng':'Cần node-pty native')),
            h('div',null,h('strong',null,'Python AST index'),h(Tag,{kind:s.indexState?.indexedAt?'success':'neutral'},s.indexState?.indexedAt?'Đã lập chỉ mục':'Chưa lập chỉ mục')),
            h('div',null,h('strong',null,'Language Server'),h(Tag,{kind:arr(s.indexState?.lsp).some(x=>x.state==='ready')?'success':'neutral'},arr(s.indexState?.lsp).some(x=>x.state==='ready')?'Đang chạy':'Chưa chạy / chưa cài')),
            h('div',null,h('strong',null,'Desktop Commander sandbox OS'),h(Tag,{kind:'error'},'Không · host quyền Windows')),
            h('div',null,h('strong',null,'Kiểm chứng Windows/Edge nhiều giờ'),h(Tag,{kind:'neutral'},'Cần chạy soak test thực tế'))
          ),h('p',{className:'small-note'},'Không ghi “sẵn sàng” nếu thiếu điều kiện trên máy thật. Xem docs/WINDOWS-SETUP.md để chạy kiểm tra Windows.')),
        h(Section,{title:local?'Công cụ cục bộ':'MCP Services'},h('div',{className:'button-row'},h(Button,{variant:'primary',onClick:()=>this.service('/api/services/start',local?'Khởi động công cụ':'Khởi động MCP'),disabled:this.isRunning()},local?'Khởi động công cụ':'Khởi động MCP'),h(Button,{variant:'outline',onClick:()=>this.service('/api/services/stop',local?'Dừng công cụ':'Dừng MCP'),disabled:this.isRunning()},local?'Dừng công cụ':'Dừng MCP')),
          local?h('div',{className:'service-grid'},h('div',{className:'service-row'},'Công cụ cục bộ',h(Tag,{kind:statusKind(tools.state)},tools.state||'—'))):h('div',{className:'service-grid'},Object.entries(serviceNames).map(([id,name])=>h('div',{className:'service-row',key:id},name,h(Tag,{kind:statusKind(hub?.services?.[id]?.state)},hub?.services?.[id]?.state||'—')))),
          local?h('p',{className:'small-note'},'Công cụ chạy ngay trong tiến trình Hub và chỉ thao tác trong thư mục dự án. Gửi một yêu cầu cũng tự khởi động chúng.'):null),
        h(Section,{title:'Browser Companion'},h('p',{className:'small-note'},'Chỉ dùng với chế độ ChatGPT Web (cũ); cần Edge/Chrome cùng profile đã ghép.'),
          h('div',{className:'button-row'},h(Tag,{kind:hub?.browser?.paired?'success':'neutral'},hub?.browser?.paired?'Đã ghép':'Chưa ghép'),h(Button,{variant:'outline',onClick:()=>this.pair(),disabled:hub?.browser?.paired},'Tạo mã ghép'),hub?.browser?.paired?h(Button,{variant:'danger',onClick:()=>this.unpair()},'Ngắt ghép'):null),
          s.pairCode?h('div',{className:'pair-code'},'Mã ghép: ',h('strong',null,s.pairCode),h('small',null,s.pairedExpiresAt?'Hết hạn '+formatTime(s.pairedExpiresAt):'')):null),
        h(Section,{title:'Windows host & sandbox'},
          h('label',{className:'form-field'},'Quyền chạy MCP',h('select',{value:s.executionPolicy,onChange:e=>this.setExecutionPolicy(e.target.value)},h('option',{value:'host-review'},'Host review · có thể dùng Desktop Commander'),h('option',{value:'sandbox-only'},'Sandbox-only · chặn external MCP tools'),h('option',{value:'full-access'},'Full Access · toàn bộ máy + Internet · không hỏi quyền'))),
          s.executionPolicy==='full-access'?h('div',{className:'full-access-warning',role:'alert'},h('strong',null,'FULL ACCESS ĐANG BẬT'),h('p',null,'Agent có thể tự dùng MCP/PowerShell để đọc, sửa, xóa file ngoài workspace và truy cập Internet. Chỉ giới hạn bởi quyền Windows, firewall và giới hạn hệ điều hành. Tắt trong Settings khi không sử dụng.')):null,
          h('p',{className:'small-note'},'Sandbox-only chỉ cho phép built-in Studio read tools và Docker sandbox terminal; không biến Desktop Commander thành sandbox.')),
        h(Section,{title:'Phiên bản hệ thống'},h('p',{className:'small-note'},`UI ${uiVersion} · Backend ${hub?.version||'…'} · Build ${this.state.health?.uiBuild||'…'}`),h('p',{className:'small-note'},'Gặp lỗi “Không tìm thấy thao tác”? STOP Hub đang chạy nền, START bản mới và Ctrl+F5.'),
          h('a',{className:'inline-link',href:'/legacy',target:'_blank',rel:'noopener noreferrer'},'Giao diện cũ (dự phòng) ↗'))
      );
    }
  }
  R.Component.prototype.isReactComponent = R.Component.prototype.isReactComponent || {};
  window.__CHATMCP_UI_BUILD__ = BUILD;
  window.__CHATMCP_REACT_APP__ = StudioApp;
  ReactDOM.render(h(StudioApp),document.getElementById('root'));
})();
