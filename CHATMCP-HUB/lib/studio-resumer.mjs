/**
 * Opt-in crash recovery. This is NOT blind tool replay. A previously in-flight
 * write or browser delivery is unverified and must be examined by a human;
 * the scheduler will not resume such runs automatically.
 *
 * The resume is a NEW user-facing run in the SAME durable conversation ID and
 * same canonical ChatGPT URL, not a new task or a replayed protocol message.
 */
const AUTO_PROMPT = 'Hub đã khởi động lại sau gián đoạn. Hãy tiếp tục phần còn dang dở TRONG CÙNG HỘI THOẠI. Trước tiên đọc lại checkpoint, kiểm tra trạng thái thật các file và kết quả test. Không lặp lại thao tác ghi chưa xác minh; sửa tiếp, kiểm thử và báo cáo tiến độ.';

export class RecoveryScheduler {
  constructor({agent,manager,provider,browser,log=()=>{},intervalMs=12000}) {
    this.agent=agent;this.manager=manager;this.provider=provider;this.browser=browser;this.log=log;
    this.intervalMs=intervalMs;this.timer=null;this.busy=false;this.attempted=new Set();this.stopped=false;
  }
  start(){ if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>void this.tick(),this.intervalMs);this.timer.unref?.(); }
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;}
  async tick(){
    if(this.stopped||this.busy)return false;
    this.busy=true;
    try{
      const a=this.agent.state(), m=this.manager.state();
      if(a.activeTaskId||!m.workspace?.path)return false;
      if(m.services && (m.services.proxy?.state!=='ready'||m.services.desktop?.state!=='ready'))return false;
      for(const item of a.tasks ?? []){
        if(!item.autoResume ||item.status!=='paused'||this.attempted.has(item.id) ||item.transport!==a.mode)continue;
        const original=this.agent.get(item.id);
        if(!original ||original.workspace?.path!==m.workspace.path)continue;
        if(item.transport==='api'){
          if(item.errorCode!=='process_interrupted'||item.pendingCall||item.pendingOperation||original.pendingCall||
             (original.unverifiedOperations||[]).length)continue;
          if(!this.provider.ready())continue;
        }else{
          if(original.errorCode!=='hub_restarted'||original.unverifiedDelivery||original.pendingOperation||
             original.pendingCall|| (original.unverifiedOperations||[]).length)continue;
          if(!this.browser.browserState().connected)continue;
          if(!/^https:\/\/chatgpt\.com\/c\/[a-f\d-]{36}(?:[?#]|$)/i.test(original.chatUrl||''))continue;
        }
        this.attempted.add(item.id);
        // Mark as consumed BEFORE attempting to send a continuation. If a crash
        // happens mid-flight, a second restart cannot resend it blindly.
        await this.agent.setAutoResume({id:item.id,enabled:false});
        try {
          await this.agent.continue({id:item.id,prompt:AUTO_PROMPT});
          this.log(`Khôi phục an toàn phiên ${item.id} sau restart (không replay thao tác cũ).`);
          return true;
        }catch(error){
          this.log(`Không tự khôi phục được ${item.id}: ${error.message}. Phiên được giữ nguyên để tiếp tục thủ công.`);
        }
      }
      return false;
    }catch(error){this.log(`Kiểm tra tự khôi phục: ${error.message}`);return false;}
    finally {this.busy=false;}
  }
}
