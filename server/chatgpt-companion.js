import path from 'node:path';
import os from 'node:os';
import {mkdir,readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import sharp from 'sharp';
import {WebWait,webPrompt} from './chatgpt-web.js';
import {WEB_IMAGE_MODEL,webModel} from './image-model.js';
import {containedFile,hashBuffer} from './generation-input.js';

const SETUP='请在日常Chrome启用“拾物 ChatGPT 连接”扩展并输入本机连接码，然后点击继续；无需在专用窗口重新登录。';
const chatUrl=u=>/^https:\/\/chatgpt\.com\/c\/[\w-]+$/.test(u||'');
export class ChatGPTCompanion{
  constructor({dataDir,downloadsRoot=path.join(os.homedir(),'Downloads')}){
    this.dataDir=dataDir;this.downloadsRoot=downloadsRoot;this.pending=null;this.client=null;
    this.secret=(async()=>{await mkdir(dataDir,{recursive:true});const file=path.join(dataDir,'chatgpt-companion-key');let key=await readFile(file,'utf8').catch(()=>null);if(!/^[a-f0-9]{64}$/.test(key||'')){key=randomBytes(32).toString('hex');await writeFile(file,key,{mode:0o600});}return key;})();
  }
  async setup(){return {code:await this.secret,extensionPath:path.resolve(import.meta.dirname,'../browser-extension'),downloadsRoot:this.downloadsRoot,message:SETUP};}
  async status(){return {open:this.connected(),connected:this.connected(),transport:'chrome_extension',extensionVersion:this.client?.version||null,nativeInput:this.client?.nativeInput===true,ready:this.connected()&&this.client?.nativeInput===true,requestedModel:WEB_IMAGE_MODEL,message:this.connected()?(this.client?.nativeInput?'日常Chrome原生交互已连接；每张提交前仍核对模型和登录。':'浏览器已连接，但需要升级扩展至1.0.3并审核新增的原生交互权限。'):SETUP};}
  connected(){return Boolean(this.client&&Date.now()-this.client.seenAt<85000);}
  async open(){if(!this.connected())throw new WebWait('bridge',SETUP);if(!this.client.nativeInput)throw new WebWait('bridge','请将扩展升级到1.0.3，并在Chrome审核原生交互权限后继续。');return this.status();}
  async manualLogin(){throw new WebWait('bridge',SETUP);}
  async finishManualLogin(){return this.open();}
  async close(){this.pending?.reject(new WebWait('bridge','服务连接已停止；已提交的图片保留在原ChatGPT会话中。'));await this.secret;}
  async handle(req,res){
    const origin=req.get('origin');
    if(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return res.status(403).json({error:'仅接受本机浏览器连接扩展。'});
    if(req.method==='OPTIONS'){if(origin)res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Shiwu-Client');res.setHeader('Access-Control-Allow-Methods','GET, POST');return res.sendStatus(204);}
    const supplied=Buffer.from((req.get('authorization')||'').replace(/^Bearer /,'')),expected=Buffer.from(await this.secret);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(401).json({error:'本机连接码不正确。'});
    if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
    const route=req.path.replace(/^\/api\/chatgpt\/companion\/bridge/,'');
    const clientId=req.get('x-shiwu-client');
    if(!/^[\w-]{10,80}$/.test(clientId||''))return res.status(400).json({error:'连接标识不正确。'});
    if(this.connected()&&this.client.id!==clientId)return res.status(409).json({error:'另一浏览器已连接，请先在原浏览器断开。'});
    this.client={...(this.client?.id===clientId?this.client:{}),id:clientId,seenAt:Date.now()};
    if(route==='/hello'){this.client.version=/^\d+\.\d+\.\d+$/.test(req.body?.extensionVersion||'')?req.body.extensionVersion:null;this.client.nativeInput=req.body?.nativeInput===true;}
    if(req.method==='POST'&&route==='/disconnect'){this.client=null;this.pending?.reject(new WebWait('bridge','浏览器扩展已断开，请连接后继续原任务。'));return res.json({connected:false});}
    if(req.method==='POST'&&route==='/hello')return res.json({connected:true,requestedModel:WEB_IMAGE_MODEL});
    if(req.method==='GET'&&route==='/task')return res.json({task:this.pending?.payload||null});
    const match=route.match(/^\/task\/([\w-]+)(\/event)?$/);
    if(!match||!this.pending||match[1]!==this.pending.payload.id)return res.status(404).json({error:'任务已停止或服务已重启，不要继续发送。'});
    // Keep the frozen task in status responses for already-installed 1.0.3 clients.
    if(req.method==='GET'&&!match[2])return res.json({active:true,id:this.pending.payload.id,task:this.pending.payload});
    if(req.method!=='POST'||!match[2])return res.sendStatus(405);
    const task=this.pending;
    try{const result=await task.event(req.body||{});res.json({ok:true});if(result){task.resolve(result);}}
    catch(e){task.reject(e);res.status(409).json({error:e.message});}
  }
}

export async function readRegisteredDownload(filename,root,taskId){
  if(typeof filename!=='string'||!path.isAbsolute(filename))throw new Error('下载文件地址不正确');
  const base=await realpath(root),file=await realpath(filename),relative=path.relative(base,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)||path.dirname(relative)!==path.join('shiwu-results',taskId))throw new Error('只能读取本次任务在Downloads登记的图片');
  const info=await stat(file);if(!info.isFile()||info.size>40*1024*1024)throw new Error('下载文件过大或不是普通图片');
  return readFile(file);
}

export class CompanionImageRunner{
  constructor({browser}){this.browser=browser;this.closed=false;}
  async open(){this.closed=false;await this.browser.open();return null;}
  close(){this.closed=true;this.cancel?.();}
  async generate(job,candidate,dir,{signal,onEvent}){
    const proof=job.viewEvidence?.[candidate.view]||[];
    if(['side','back'].includes(candidate.view)&&!proof.length)return {status:'blocked',reason:'当前规格缺少已确认的'+candidate.viewLabel+'原图。',attempts:0};
    const journalFile=path.join(dir,candidate.filename+'-web.json');
    candidate.web||=await readFile(journalFile,'utf8').then(JSON.parse).catch(()=>null);
    const requested=job.requestedModel||candidate.web?.modelEvidence?.requested||WEB_IMAGE_MODEL,model=webModel(requested);
    const save=async patch=>{candidate.web={...candidate.web,...patch};await writeFile(journalFile,JSON.stringify(candidate.web,null,2));onEvent({message:candidate.web.phase==='submitted'?'ChatGPT已提交，等待原会话生成':'正在通过日常Chrome连接',model:requested});};
    if(candidate.web?.phase==='downloaded'){
      const buffer=await readFile(await containedFile(dir,candidate.web.file)),meta=await sharp(buffer).metadata();
      if(!candidate.web.file?.startsWith('results/')||hashBuffer(buffer)!==candidate.web.hash||Math.min(meta.width||0,meta.height||0)<512)throw new Error('已登记图片核验失败');
      return {status:'completed',file:candidate.web.file,hash:candidate.web.hash,bytes:buffer.length,width:meta.width,height:meta.height,attempts:1,model:requested,reviewState:'pending_user',reason:'已恢复本机成品，待核对商品细节',web:candidate.web};
    }
    await this.browser.open();
    if(this.browser.pending)throw new WebWait('bridge','连接扩展正在处理上一张图片，请稍后继续。');
    const refs=[];
    for(const ref of job.snapshot.refs){const nativePath=await containedFile(dir,ref.path);const bytes=await readFile(nativePath);if(hashBuffer(bytes)!==ref.hash)throw new Error('冻结原图已变化');refs.push({nativePath,name:path.basename(ref.path),mime:(await sharp(bytes).metadata()).format==='jpeg'?'image/jpeg':'image/'+(await sharp(bytes).metadata()).format});}
    if(job.adjustment?.sourceFile){const nativePath=await containedFile(dir,job.adjustment.sourceFile);const bytes=await readFile(nativePath);if(hashBuffer(bytes)!==job.adjustment.sourceHash)throw new Error('冻结的调整图片已变化');refs.push({nativePath,name:path.basename(job.adjustment.sourceFile),mime:'image/'+(await sharp(bytes).metadata()).format.replace('jpeg','jpeg')});}
    const marker=`SHIWU-${job.id}-${candidate.id}`,prompt=await webPrompt(job,candidate,dir)+'\n\n任务编号（无需绘入图片）：'+marker;
    const previous=candidate.web?.phase;
    const resume=Boolean(previous&&previous!=='prepared');
    if(resume&&(!chatUrl(candidate.web.conversationUrl)||candidate.web.modelEvidence?.requested!==requested||!model.pattern.test(candidate.web.modelEvidence?.observed||'')))throw new WebWait('ambiguous','上次可能已提交，但缺少可核实的原会话或模型记录。请先核对原会话，不自动重复生成。');
    const payload={id:randomUUID(),marker,prompt,files:refs,requestedModel:requested,modelLabel:model.label,resume,conversationUrl:resume?candidate.web.conversationUrl:null};
    await save({transport:'chrome_extension',phase:previous||'prepared',marker,promptHash:hashBuffer(Buffer.from(prompt))});
    await writeFile(path.join(dir,candidate.filename+'-prompt.txt'),prompt);
    return new Promise((resolve,reject)=>{
      let finished=false;
      const done=(error,value)=>{if(finished)return;finished=true;clearTimeout(timeout);clearInterval(heartbeat);signal?.removeEventListener('abort',abort);if(this.browser.pending?.payload.id===payload.id)this.browser.pending=null;this.cancel=null;error?reject(error):resolve(value);};
      const abort=()=>done(new WebWait('bridge','任务已停止，已提交的网页生成保留在原会话。'));
      const timeout=setTimeout(()=>done(new WebWait('timeout','等待超过20分钟；保留原会话，继续时仅检查原结果，不重复发送。')),20*60*1000);
      const heartbeat=setInterval(()=>{if(!this.browser.connected())done(new WebWait('bridge','日常Chrome扩展已断开，请连接后继续原任务。'));},5000);
      this.cancel=abort;signal?.addEventListener('abort',abort,{once:true});
      this.browser.pending={payload,resolve:v=>done(null,v),reject:e=>done(e),event:async event=>{
        if(finished)throw new Error('任务已结束');
        if(event.type==='error')throw new WebWait(['login','quota','model','page','verification','download','ambiguous'].includes(event.reason)?event.reason:'page',String(event.message||'浏览器连接异常').slice(0,600));
        if(event.type==='blocked')return {status:'blocked',reason:'ChatGPT报告缺少视角依据，未计为生成完成。',attempts:0,web:candidate.web};
        if(event.type==='submitting'){
          if(resume||candidate.web.phase!=='prepared')throw new Error('拒绝重复提交');
          if(!model.pattern.test(String(event.observedModel||'')))throw new WebWait('model','网页未证明所选模型，未允许发送。');
          await save({phase:'submitting',submittedAt:new Date().toISOString(),modelEvidence:{requested,observed:event.observedModel,source:'visible_web_label'}});return;
        }
        if(event.type==='submitted'){
          if(!['submitting','submitted'].includes(candidate.web.phase)||!chatUrl(event.conversationUrl))throw new WebWait('ambiguous','未取得本次生成的原会话地址');
          await save({phase:'submitted',conversationUrl:event.conversationUrl});payload.resume=true;payload.conversationUrl=event.conversationUrl;return;
        }
        if(event.type==='complete'){
          if(candidate.web.phase!=='submitted')throw new Error('尚未登记提交，拒绝导入');
          const bytes=await readRegisteredDownload(event.filePath,this.browser.downloadsRoot,payload.id),meta=await sharp(bytes).metadata(),hash=hashBuffer(bytes);
          if(bytes.length<1024||!['png','jpeg','webp'].includes(meta.format)||Math.min(meta.width||0,meta.height||0)<512||Math.abs(meta.width/meta.height-1)>.025||[...job.snapshot.refs,...job.snapshot.styleRefs].some(r=>r.hash===hash))throw new WebWait('download','下载文件未通过原图、格式及方图检查，未计为成品');
          const file='results/'+candidate.filename+'.'+(meta.format==='jpeg'?'jpg':meta.format);
          await writeFile(path.join(dir,file),bytes);await save({phase:'downloaded',file,hash,downloadedAt:new Date().toISOString()});
          return {status:'completed',file,hash,bytes:bytes.length,width:meta.width,height:meta.height,attempts:1,model:requested,reviewState:'pending_user',reason:'已下载ChatGPT原图，待核对商品细节',web:candidate.web};
        }
        if(event.type==='stage'){onEvent({message:String(event.message||'正在处理').slice(0,80),model:requested});return;}
        if(event.type!=='heartbeat')throw new Error('未知任务事件');
      }};
      if(signal?.aborted||this.closed)abort();
    });
  }
}
