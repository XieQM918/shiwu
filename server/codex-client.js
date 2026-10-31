import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';
import {codexLaunch,runtimeEnv} from './platform.js';
export {codexExecutable} from './platform.js';

// A private stdio connection: no shell interpolation, public socket or API key.
export class CodexClient extends EventEmitter {
  constructor({cwd,executable,spawnProcess=spawn}={}){
    super();this.cwd=cwd;const launch=codexLaunch(executable);this.executable=launch.command;this.executableArgs=launch.args;this.spawnProcess=spawnProcess;
    this.nextId=0;this.pending=new Map();this.closed=false;
  }
  async connect(){
    this.child=this.spawnProcess(this.executable,[...this.executableArgs,'app-server','--listen','stdio://'],{cwd:this.cwd,env:runtimeEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',()=>{}); // Do not expose auth/runtime diagnostics to the browser.
    createInterface({input:this.child.stdout}).on('line',line=>{try{this.receive(JSON.parse(line));}catch{/* Ignore non-protocol diagnostics. */}});
    this.child.on('error',e=>this.fail(new Error(e.code==='ENOENT'?'未找到本机 Codex，请先安装并登录。':`Codex 无法启动：${e.message}`)));
    this.child.on('exit',()=>this.fail(new Error('Codex 连接已结束；已完成图片保留，可稍后继续。')));
    await this.request('initialize',{clientInfo:{name:'shiw_etsy_workbench',title:'拾物 Etsy 图片工作台',version:'1.1.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});
    return this;
  }
  send(message){if(this.closed||!this.child?.stdin.writable)throw new Error('Codex 连接不可用');this.child.stdin.write(JSON.stringify(message)+'\n');}
  request(method,params={},timeout=45000){
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex 请求超时：${method}`));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  receive(message){
    if(message.id!=null&&!message.method){const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);return;}
    if(message.id!=null&&message.method){
      // Never grant arbitrary elevated access on behalf of the user.
      const method=message.method;
      if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval')this.send({id:message.id,result:{decision:'decline'}});
      else if(method==='item/permissions/requestApproval')this.send({id:message.id,result:{permissions:{},scope:'turn'}});
      else if(method==='item/tool/requestUserInput')this.send({id:message.id,result:{answers:{}}});
      else this.send({id:message.id,error:{code:-32601,message:'工作台仅允许当前图片任务，不支持此交互。'}});
      this.emit('interaction',method);return;
    }
    this.emit('notification',message);
  }
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('disconnect',error);}
  async startThread({cwd=this.cwd,developerInstructions,model}={}){
    const result=await this.request('thread/start',{cwd,sandbox:'workspace-write',approvalPolicy:'never',developerInstructions,model,
      config:{'features.apps':false,'features.plugins':false,'features.multi_agent':false,'features.browser_use':false,'features.computer_use':false}});
    return result.thread.id;
  }
  async runTurn({threadId,input,outputSchema,onEvent=()=>{},signal,effort='low',timeoutMs=25*60*1000,timeoutMessage='本张图片生成超时；可重试未完成项。'}){
    let turnId;let timer;const items=[];const messages=[];
    let completed=false;
    const done=new Promise((resolve,reject)=>{
      this.turnReject=reject;
      this.turnListener=event=>{
        const p=event.params||{};if(p.threadId!==threadId)return;
        onEvent(event);
        if(event.method==='item/completed'){
          items.push(p.item);
          if(p.item.type==='agentMessage')messages.push(p.item.text);
        }
        if(event.method==='turn/completed'){
          completed=true;
          if(p.turn.status==='completed')resolve({turnId:p.turn.id,items,messages});
          else reject(new Error(p.turn.error?.message|| (p.turn.status==='interrupted'?'任务已停止':'Codex 未完成本次生图')));
        }
      };
      this.on('notification',this.turnListener);
      this.disconnectListener=e=>reject(e);this.on('disconnect',this.disconnectListener);
      timer=setTimeout(()=>{if(turnId)this.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});reject(new Error(timeoutMessage));},timeoutMs);
    });
    // Attach immediately, including while turn/start is still awaiting a response.
    done.catch(()=>{});
    const abort=()=>{if(turnId)this.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});this.turnReject?.(new Error('任务已停止'));};
    signal?.addEventListener('abort',abort,{once:true});
    try{
      if(signal?.aborted)throw new Error('任务已停止');
      const r=await this.request('turn/start',{threadId,input,outputSchema,effort});turnId=r.turn.id;
      if(signal?.aborted)abort();
      return await done;
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      this.off('notification',this.turnListener);this.off('disconnect',this.disconnectListener);
      if(!completed&&turnId)this.request('turn/interrupt',{threadId,turnId},5000).catch(()=>{});
    }
  }
  close(){if(this.closed)return;this.closed=true;this.fail(new Error('Codex 连接已关闭'));this.child?.stdin.end();this.child?.kill('SIGTERM');}
}

export function finalJson(result){
  for(const text of [...result.messages].reverse()){
    try{return JSON.parse(text);}catch{}
    const match=text.match(/```(?:json)?\s*([\s\S]*?)```/);if(match){try{return JSON.parse(match[1]);}catch{}}
  }
  throw new Error('Codex 未返回可核验的图片结果；未将文字当作成品。');
}
