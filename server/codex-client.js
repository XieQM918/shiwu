import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';
import {codexLaunch,runtimeEnv} from './platform.js';
export {codexExecutable} from './platform.js';

// Store counters and quota windows only, never account identity, tokens or tool arguments.
export function quotaWindows(value){
  if(!value)return null;
  const buckets=value.rateLimitsByLimitId?Object.values(value.rateLimitsByLimitId):[value.rateLimits||value];
  return buckets.filter(Boolean).map(b=>({limitId:b.limitId||null,...Object.fromEntries(['primary','secondary'].map(k=>[k,b[k]?{usedPercent:b[k].usedPercent,windowDurationMins:b[k].windowDurationMins,resetsAt:b[k].resetsAt}:null]))}));
}

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
  async startThread({cwd=this.cwd,developerInstructions,model,expectedModel,historyMode}={}){
    const result=await this.request('thread/start',{cwd,sandbox:'workspace-write',approvalPolicy:'never',developerInstructions,model,historyMode,ephemeral:false,allowProviderModelFallback:false,
      config:{'features.apps':false,'features.plugins':false,'features.multi_agent':false,'features.browser_use':false,'features.computer_use':false}});
    this.lastThreadModel=result.model||result.thread?.model||null;
    this.threadPaths||=new Map();if(result.thread?.path)this.threadPaths.set(result.thread.id,result.thread.path);
    if(expectedModel&&this.lastThreadModel!==expectedModel)throw new Error('Codex未确认指定模型 '+expectedModel+'；未启动生图，不回退其他模型。');
    if(historyMode&&result.thread?.historyMode&&result.thread.historyMode!==historyMode){const e=new Error('Codex未启用本任务要求的JSONL监测记录；未启动生图。');e.failureCode=e.waitReason='trace_unavailable';e.traceDiagnostics={stage:'history_mode',actual:result.thread.historyMode};throw e;}
    return result.thread.id;
  }
  async threadPath(threadId,{refresh=false}={}){
    if(!refresh&&this.threadPaths?.has(threadId))return this.threadPaths.get(threadId);
    const result=await this.request('thread/read',{threadId,includeTurns:false},5000);const file=result.thread?.path||null;
    if(file){this.threadPaths||=new Map();this.threadPaths.set(threadId,file);}return file;
  }
  async prepareTrace(threadId){
    // Empty threads can advertise a rollout path before the file exists. A
    // local injection materializes history without starting a model turn.
    this.tracePrepared||=new Set();
    try{
      if(!this.tracePrepared.has(threadId)){
        await this.request('thread/inject_items',{threadId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'本机工作台：本会话只处理当前一张图片，实际工具记录由本机监测。'}]}]},5000);
        this.tracePrepared.add(threadId);
      }
      return await this.threadPath(threadId,{refresh:true});
    }catch(cause){const e=new Error('无法初始化本任务的本地监测记录；未启动生图，请查看日志初始化诊断。');e.failureCode=e.waitReason='trace_unavailable';e.traceDiagnostics={stage:'bootstrap',causeCode:/method.*not found|unsupported|不支持/i.test(cause.message)?'UNSUPPORTED':/超时|timeout/i.test(cause.message)?'TIMEOUT':'CODEX_REQUEST_FAILED'};throw e;}
  }
  async runTurn({threadId,input,outputSchema,onEvent=()=>{},signal,effort='low',collectUsage=false,maxModelSteps,timeoutMs=25*60*1000,timeoutMessage='本张图片生成超时；可重试未完成项。'}){
    let turnId;let timer;const items=[];const messages=[];
    const started=Date.now(),calls=new Map();this.tokenTotals||=new Map();const baseline=this.tokenTotals.get(threadId)||{};
    const usage={threadId,model:this.lastThreadModel||null,reasoningEffort:effort,startedAt:new Date(started).toISOString(),tokensKnown:false,modelSteps:0};let latest,priorInput=baseline.inputTokens||0;
    const snapshotUsage=()=>{const types=[...calls.values()];return {...usage,turnId,durationMs:Date.now()-started,
      imageCalls:types.filter(t=>t==='imageGeneration').length||types.filter(t=>t==='mcpImage').length,
      imageViews:types.filter(t=>t==='imageView').length,commands:types.filter(t=>t==='commandExecution').length};};
    let completed=false,budgetStopped=false;
    const done=new Promise((resolve,reject)=>{
      this.turnReject=reject;
      this.turnListener=event=>{
        if(budgetStopped)return;
        const p=event.params||{};
        if(collectUsage&&event.method==='account/rateLimits/updated'){usage.quotaAfter=quotaWindows(p);return;}
        if(p.threadId!==threadId)return;
        if(collectUsage&&event.method==='thread/tokenUsage/updated'&&p.tokenUsage?.total){
          latest=p.tokenUsage.total;usage.tokensKnown=true;
          if((latest.inputTokens||0)>priorInput){usage.modelSteps++;priorInput=latest.inputTokens||0;}
          for(const k of ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'])usage[k]=Math.max(0,(latest[k]||0)-(baseline[k]||0));
          usage.uncachedInputTokens=Math.max(0,usage.inputTokens-usage.cachedInputTokens);
          if(maxModelSteps&&usage.modelSteps>=maxModelSteps&&!items.some(i=>i.type==='agentMessage'&&i.phase==='final')){
            budgetStopped=true;
            const error=new Error(`本张已达到${maxModelSteps}轮模型续跑上限，已停止，不自动重发。`);error.failureCode='model_step_limit';error.waitReason='model_step_limit';
            const id=p.turnId||turnId;if(id)this.request('turn/interrupt',{threadId,turnId:id},5000).catch(()=>{});reject(error);return;
          }
        }
        if(collectUsage&&event.method.startsWith('item/')&&p.item?.id){const i=p.item;calls.set(i.id,i.type==='mcpToolCall'&&/imagegen|image_gen/.test(`${i.server} ${i.tool}`)?'mcpImage':i.type);}
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
      if(collectUsage)usage.quotaBefore=quotaWindows(await this.request('account/rateLimits/read',{},4000).catch(()=>null));
      const r=await this.request('turn/start',{threadId,input,outputSchema,effort});turnId=r.turn.id;
      if(signal?.aborted)abort();
      const result=await done;
      if(collectUsage){usage.quotaAfter=quotaWindows(await this.request('account/rateLimits/read',{},4000).catch(()=>null))||usage.quotaAfter;result.usage=snapshotUsage();}
      return result;
    }catch(e){if(collectUsage)e.usage=snapshotUsage();throw e;
    }finally{
      if(latest)this.tokenTotals.set(threadId,latest);
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
