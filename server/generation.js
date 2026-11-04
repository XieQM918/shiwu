import path from 'node:path';
import {mkdir,readFile,writeFile,stat,rename,realpath,copyFile,cp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {spawn} from 'node:child_process';
import archiver from 'archiver';
import {cleanDownloadFiles} from './download-cleaner.js';
import {CODEX_IMAGE_MODEL,IMAGE_REASONING_EFFORT,IMAGE_EXECUTION_POLICY} from './image-model.js';
import {imageCodexExecutable} from './platform.js';
import {CodexClient,finalJson} from './codex-client.js';
import {freezeInput,planCandidates,confirmedField,candidateInput,RESULT_SCHEMA,containedFile,hashBuffer,profileKey} from './generation-input.js';
import {SOURCE_ANGLE_MODE,ANGLE_SOURCE_SCHEMA,angleRefs,anglePlanKey,selectionPreviewInput,materializeAnglePlan,readAnglePlan,saveAnglePlan} from './angle-sources.js';

import {ImageTraceMonitor,imageFailure} from './image-trace.js';
import {frozenStyle} from './image-style.js';

const traceUsage=(usage,state={})=>({...usage,model:usage.model||CODEX_IMAGE_MODEL,reasoningEffort:IMAGE_REASONING_EFFORT,additionalWaits:state.additionalWaits||0,phase:state.phase,failureCode:state.failureCode,imageCalls:Math.max(usage.imageCalls||0,state.imageCalls||0)});
const ACTIVE=['queued','running'];
export const IMAGE_TURN_TIMEOUT_MS=5*60*1000;
const connectionFailure=reason=>/连接|超时|登录|auth|rate.limit|quota|usage.limit|not available|not supported|工具不可用|未收到内置生图|未返回图片|connection failed|error sending request/i.test(reason||'');
export function usageSummary(job){
  const selection=job.anglePlan?.jobId===job.id&&job.anglePlan.usage?[job.anglePlan.usage]:[];
  const records=[...job.candidates.flatMap(c=>c.usageHistory||[]),...selection].sort((a,b)=>(a.startedAt||'').localeCompare(b.startedAt||''));
  if(!records.length)return null;
  const known=records.filter(r=>r.tokensKnown);
  return {recordedTurns:records.length,tokenRecordedTurns:known.length,uncachedInputTokens:known.reduce((n,r)=>n+Math.max(0,(r.inputTokens||0)-(r.cachedInputTokens||0)),0),modelStepRecordedTurns:records.filter(r=>Number.isFinite(r.modelSteps)).length,...Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens','imageCalls','imageViews','commands','durationMs','modelSteps','additionalWaits'].map(k=>[k,records.reduce((n,r)=>n+(Number(r[k])||0),0)])),quotaBefore:records[0].quotaBefore||null,quotaAfter:records.at(-1).quotaAfter||null};
}
export function imageJobSummary(job){
  const completed=job.candidates.filter(c=>c.status==='completed').length;
  return {id:job.id,productId:job.productId,skuId:job.skuId,skuLabel:job.snapshot.skuLabel,status:job.status,message:job.message,
    createdAt:job.createdAt,updatedAt:job.updatedAt,completed,total:job.candidates.length,
    blocked:job.candidates.filter(c=>c.status==='blocked').length,failed:job.candidates.filter(c=>c.status==='failed').length,
    skipped:job.candidates.filter(c=>c.status==='skipped').length,
    previews:job.candidates.filter(c=>c.preview&&c.status!=='completed').length,
    kind:job.kind||'batch',parentJobId:job.parentJobId,parentCandidateId:job.parentCandidateId,
    provider:job.provider||'codex',requestedModel:job.requestedModel||null,waitReason:job.waitReason||null,usage:job.usage||null,planVersion:job.planVersion||1,
    current:job.candidates.find(c=>c.status==='running')?.id||null};
}
export function imageType(buffer){
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return 'jpg';
  if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'webp';
  throw new Error('输出不是支持的真实图片文件');
}

export class CodexImageRunner {
  constructor({ocr,clientFactory=options=>new CodexClient(options),traceFactory=options=>new ImageTraceMonitor(options)}={}){Object.assign(this,{ocr,clientFactory,traceFactory});}
  async open(job,batchDir,onEvent){
    this.usedThread=false;
    if(process.platform==='darwin'){
      // Let the display sleep while keeping an explicitly started batch running.
      this.keepAwake=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});this.keepAwake.on('error',()=>{});
    }
    this.client=this.clientFactory({cwd:batchDir,executable:imageCodexExecutable()});await this.client.connect();
    const models=await this.client.request('model/list',{includeHidden:false});
    const requested=job.requestedModel||CODEX_IMAGE_MODEL;
    if(requested!==CODEX_IMAGE_MODEL)throw new Error('此为历史模型批次，请重新生成以使用 '+CODEX_IMAGE_MODEL+'。');
    const selected=models.data?.find(m=>(m.model||m.id)===requested);
    if(!selected)throw new Error('当前Codex入口未提供 GPT-6.1 Sol。请升级Codex或设置 WORKBENCH_IMAGE_CODEX_BIN；不回退5.6或其他模型。');
    this.model=selected.model||selected.id;
    const instructions='你只负责当前一张商品摄影。摄影规范、原图和参考图已提供，不搜索目录、Skill、指南或记忆库，不重复view_image。只调用一次内置生图；exec首行必须设置yield_time_ms:120000；只允许一次wait补查且也必须120000；仍无结果立即failed。已展示结果简短核对一次，不追加审图或重画。不text输出完整工具结果或base64；返回实际图片路径，由工作台保存。缺尺寸不阻止出图，尺度仅供参考，不推算数值或隐藏结构。不读凭据、改设置、发消息或创建代理。';
    this.instructions=instructions;
    // A fresh runtime thread on recovery avoids accidentally continuing an interrupted tool call.
    this.threadId=await this.client.startThread({cwd:batchDir,developerInstructions:instructions,model:this.model,expectedModel:this.model,historyMode:'legacy'});
    onEvent({threadId:this.threadId,model:this.model});return this.threadId;
  }
  async prepareSourceAngles(job,batchDir,{signal,onEvent}){
    for(const ref of angleRefs(job.snapshot))if(hashBuffer(await readFile(await containedFile(batchDir,ref.path)))!==ref.hash)throw new Error('冻结的选角原图发生变化，请新建批次。');
    let plan=await readAnglePlan(job.snapshot,batchDir);
    if(!plan){
      onEvent({message:'正在一次性选择原素材视角（不生图，后续复用选角结果）'});
      const threadId=await this.client.startThread({cwd:batchDir,model:this.model,expectedModel:this.model,historyMode:'legacy',developerInstructions:'仅分析已附商品照片，返回指定JSON。不调用工具、不生图、不执行命令、不创建代理。仅识别实际拍到的视角与裁切区域，不推造新视角。'});
      onEvent({threadId});
      const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
      let forbidden=false,result;
      try{
        result=await this.client.runTurn({threadId,input:await selectionPreviewInput(job.snapshot,batchDir),outputSchema:ANGLE_SOURCE_SCHEMA,effort:IMAGE_REASONING_EFFORT,collectUsage:true,signal:controller.signal,timeoutMs:180000,timeoutMessage:'原素材选角超时；已暂停，继续时可重试。',onEvent:event=>{
          if(event.method==='item/started'&&['imageGeneration','mcpToolCall','commandExecution','fileChange','collabAgentToolCall','webSearch'].includes(event.params?.item?.type)){forbidden=true;controller.abort();}
        }});
        if(forbidden)throw new Error('选角任务请求了不允许的工具；未进入角度生图。');
        const answer=finalJson(result);
        plan=await materializeAnglePlan(job.snapshot,answer,batchDir,{jobId:job.id,model:this.model,usage:result.usage?{...result.usage,purpose:'angle_source_selection'}:null});
      }catch(error){
        if(signal?.aborted){if(error.usage)error.usage.purpose='angle_source_selection_interrupted';throw error;}
        // Persist a failed selection once: A/B/C must not each rerun the same
        // analysis. Only an explicit retry can discard this failed plan.
        plan={key:anglePlanKey(job.snapshot),jobId:job.id,model:this.model,createdAt:new Date().toISOString(),scanned:angleRefs(job.snapshot).length,selectionFailed:true,
          usage:error.usage||result?.usage||null,slots:['A','B','C'].map(letter=>({letter,status:'blocked',reason:'原素材选角未完成：'+(forbidden?'选角请求了不允许的工具。':error.message)}))};
        await saveAnglePlan(batchDir,plan);onEvent({anglePlan:plan});
        const wait=new Error(plan.slots[0].reason);wait.waitReason='angle_selection';throw wait;
      }finally{signal?.removeEventListener('abort',abort);}
    }
    onEvent({anglePlan:plan});
    if(plan.selectionFailed){const e=new Error(plan.slots[0].reason);e.waitReason='angle_selection';throw e;}
    return plan;
  }
  async generate(job,candidate,batchDir,{signal,onEvent=()=>{}}={}){
    if(candidate.view==='source'){
      const plan=await this.prepareSourceAngles(job,batchDir,{signal,onEvent});
      const source=candidate.angleSource||plan.slots.find(s=>s.letter===candidate.letter);
      if(!source||source.status!=='ready')return {status:'skipped',reasonCode:'source_missing',reason:source?.reason||'缺少当前规格的实际视角原图，此位置留空。',attempts:0};
      candidate={...candidate,angleSource:source};onEvent({angleSource:source});
    }
    if(['side','back'].includes(candidate.view)&&!job.viewEvidence?.[candidate.view]?.length)return {status:'skipped',reasonCode:'source_missing',reason:'当前规格缺少'+candidate.viewLabel+'原图，此位置留空。',attempts:0};
    for(const ref of [...job.snapshot.refs,...job.snapshot.styleRefs])if(ref.hash&&hashBuffer(await readFile(await containedFile(batchDir,ref.path)))!==ref.hash)throw new Error('冻结的参考图片发生变化，请重新建立批次。');
    job={...job,styleProfile:await frozenStyle(job.snapshot,batchDir)};
    if(this.usedThread){this.threadId=await this.client.startThread({cwd:batchDir,developerInstructions:this.instructions,model:this.model,expectedModel:this.model,historyMode:'legacy'});onEvent({threadId:this.threadId});}
    this.usedThread=true;
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    let trace,latestPreview,result,error,answer={};const nativeItems=new Map(),attempts=new Set(),previewTasks=[];const startedAt=Date.now();
    try{
      trace=this.traceFactory({onViolation:()=>controller.abort(),onChange:value=>onEvent({trace:value})});
      onEvent({message:'正在初始化本地监测记录（不调用模型）'});
      const traceFile=this.client.prepareTrace?await this.client.prepareTrace(this.threadId):await this.client.threadPath?.(this.threadId);
      await trace.start(traceFile,this.threadId,{signal:controller.signal});
      result=await this.client.runTurn({threadId:this.threadId,input:candidateInput(job,candidate,batchDir),outputSchema:RESULT_SCHEMA,signal:controller.signal,effort:IMAGE_REASONING_EFFORT,collectUsage:true,maxModelSteps:IMAGE_EXECUTION_POLICY.maxModelSteps,timeoutMs:IMAGE_TURN_TIMEOUT_MS,timeoutMessage:'本张任务准备及保存超过5分钟，已停止；生图等待上限为4分钟。',onEvent:event=>{
        const item=event.params?.item;
        if(item?.type==='imageGeneration'){
          attempts.add(item.id);nativeItems.set(item.id,item);
          if(attempts.size>1){error=imageFailure('image_call_limit','本张只允许生成一次，已停止额外生图。');controller.abort();return;}
          onEvent({attempts:attempts.size,message:event.method==='item/started'?'正在调用内置生图 · 本张仅一次':'图片已返回，正在保存'});
          if(event.method==='item/completed'&&item.status==='completed'&&item.savedPath){
            trace.returnedImage();previewTasks.push(this.publishPreview(item.savedPath,job,candidate,batchDir).then(preview=>{latestPreview=preview;if(!signal?.aborted)onEvent({preview,message:'图片已返回，可预览 · 待人工核对'});}).catch(()=>{}));
          }
        }
      }});
      await trace.flush();if(trace.error)throw trace.error;
      if(result.usage)onEvent({usage:traceUsage(result.usage,trace.state)});
      try{answer=finalJson(result);}catch(e){error=e;error.recoverableMetadata=true;}
    }catch(e){error=trace?.error||error||e;const usage=e.usage||result?.usage;if(usage)error.usage=traceUsage(usage,trace?.state);}
    finally{await trace?.stop();signal?.removeEventListener('abort',abort);await Promise.all(previewTasks);}
    const traceState=trace?.state||{};
    if(error?.usage){onEvent({usage:error.usage});delete error.usage;}
    if(signal?.aborted)throw new Error('任务已停止');
    const items=[...(result?.items||[]),...nativeItems.values()];
    const generation=[...new Map(items.filter(i=>i.type==='imageGeneration'&&i.status==='completed').map(i=>[i.id,i])).values()];
    const mcpGeneration=items.filter(i=>i.type==='mcpToolCall'&&/imagegen|image_gen/.test(`${i.server} ${i.tool}`)&&i.status==='completed');
    const pathValue=latestPreview?.file?path.join(batchDir,latestPreview.file):generation.find(i=>i.savedPath)?.savedPath||answer.path;
    const productBrief=typeof answer.productBrief==='string'?answer.productBrief.slice(0,600):'';
    if(!pathValue){
      const e=error||imageFailure(connectionFailure(answer.reason)?'image_connection':'image_failed',answer.reason||'生图未返回图片或可保存路径；没有自动重发。');
      e.failureCode||='image_failed';e.waitReason||=e.failureCode;e.trace=traceState;throw e;
    }
    if(!generation.length&&!mcpGeneration.length){const e=imageFailure('generation_unverified','未收到实际生图调用记录，不能把现有文件列为成品。');e.trace=traceState;throw e;}
    const file=await realpath(path.resolve(batchDir,String(pathValue)));
    const batchRoot=await realpath(batchDir),generatedRoot=await realpath(path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images')).catch(()=>null);
    if(!file.startsWith(batchRoot+path.sep)&&!(generatedRoot&&file.startsWith(generatedRoot+path.sep)))throw imageFailure('file_invalid','图片路径不属于本任务或本机生图目录。');
    const info=await stat(file);if(!info.isFile())throw imageFailure('file_invalid','生成图片文件不存在。');
    const buffer=await readFile(file),hash=hashBuffer(buffer);
    if([...angleRefs(job.snapshot),...job.snapshot.styleRefs,candidate.angleSource||{}].some(r=>r.hash===hash))throw imageFailure('file_invalid','返回文件与输入原图、选角裁切或风格参考相同，不能冒充生成成品。');
    let matchesNative=latestPreview?.hash===hash;
    for(const item of generation.filter(i=>i.savedPath))try{if(hashBuffer(await readFile(item.savedPath))===hash)matchesNative=true;}catch{}
    if(!matchesNative&&!(mcpGeneration.length&&generatedRoot&&file.startsWith(path.join(generatedRoot,this.threadId)+path.sep)&&info.mtimeMs>=startedAt-2000))throw imageFailure('generation_unverified','该文件无法关联本次实际生成结果。');
    let ext,dimensions;try{ext=imageType(buffer);dimensions=await this.ocr.dimensions(file);}catch{throw imageFailure('file_invalid','返回的图片无法正常读取。');}
    if(!dimensions.width||!dimensions.height)throw imageFailure('file_invalid','返回的图片无法读取尺寸。');
    const warnings=[...(candidate.warnings||[]).filter(w=>w.code==='scale_unverified')];
    if(Math.min(dimensions.width,dimensions.height)<512)warnings.push({code:'low_resolution',message:'图片分辨率偏低，请确认后使用。'});
    if(Math.abs(dimensions.width/dimensions.height-1)>.025)warnings.push({code:'non_square',message:'图片不是方图，可下载后确认构图。'});
    if(answer.reviewed!==true)warnings.push({code:'review_unavailable',message:'未完成画面核对，请人工确认。'});
    if(answer.reason&&answer.status!=='completed')warnings.push({code:'visual_issue',message:answer.reason});
    if(error)warnings.push({code:error.failureCode||'result_metadata',message:error.message});
    const filename=`${candidate.filename}.${ext}`,target=path.join(batchDir,'results',filename);await mkdir(path.dirname(target),{recursive:true});if(file!==target)await copyFile(file,target);
    return {status:'completed',reviewState:'pending_user',reason:answer.reason||'图片已生成，待人工核对。',recommendation:answer.recommendation||'',warnings,attempts:1,
      file:`results/${filename}`,hash,bytes:buffer.length,width:dimensions.width,height:dimensions.height,modelReviewed:answer.reviewed===true,
      generationEvidence:generation.map(i=>({id:i.id,status:i.status})),turnId:result?.turnId,productBrief,trace:traceState,
      ...(error&&!error.recoverableMetadata?{pauseReason:error.failureCode||'image_failed',failureCode:error.failureCode||'image_failed'}:{}),...(candidate.angleSource?{angleSource:candidate.angleSource}:{})};
  }
  async publishPreview(source,job,candidate,batchDir){
    const file=await realpath(source);const generatedRoot=await realpath(path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images')).catch(()=>null);
    if(!(generatedRoot&&file.startsWith(generatedRoot+path.sep))&&!file.startsWith(await realpath(batchDir)+path.sep))throw new Error('预览文件超出允许范围');
    const buffer=await readFile(file);if(!buffer.length)throw new Error('图片尚未保存完整');
    const hash=hashBuffer(buffer);if([...angleRefs(job.snapshot),candidate.angleSource||{}].some(r=>r.hash===hash))throw new Error('不能把原图作为预览');
    const ext=imageType(buffer);const relative=`drafts/${candidate.filename}-${hash.slice(0,12)}.${ext}`;
    await mkdir(path.join(batchDir,'drafts'),{recursive:true});const target=path.join(batchDir,relative);await copyFile(file,target);
    const size=await this.ocr.dimensions(target);if(!size.width||!size.height)throw new Error('预览文件无法读取');
    return {file:relative,hash,width:size.width,height:size.height,bytes:buffer.length,createdAt:new Date().toISOString(),review:'pending'};
  }
  close(){this.client?.close();this.keepAwake?.kill();}
}

export class GenerationService {
  constructor({store,dataDir,outputRoot,skillPath,ocr,review,runnerFactory=null}){
    Object.assign(this,{store,dataDir,outputRoot,skillPath,runnerFactory,review});
    this.customRunner=Boolean(runnerFactory);this.runnerFactory=runnerFactory||(()=>new CodexImageRunner({ocr}));
    this.active=null;this.creating=new Map();this.closing=false;
    if(!this.customRunner)for(const job of this.store.imageJobs())if(job.provider==='chatgpt_web'&&['queued','running','paused'].includes(job.status)){job.status='stopped';delete job.waitReason;job.message='网页生图方案已停用；保留历史，请重新生成以使用Codex GPT-6.1 Sol。';this.store.saveImageJob(job);}
  }
  queueBlocker(){return this.store.imageJobs().find(j=>j.queueHold===true&&j.waitReason&&j.status==='paused'&&(this.customRunner||j.provider==='codex'));}
  summaries(){
    const blocker=this.queueBlocker();
    return this.store.imageJobs().map(job=>({...imageJobSummary(job),...(job.status==='queued'&&blocker?{queueBlockedBy:{id:blocker.id,productId:blocker.productId,skuLabel:blocker.snapshot?.skuLabel||blocker.skuId,reason:blocker.message,waitReason:blocker.waitReason}}:{})}));
  }
  async create(productId,skuId,options={}){
    const key=`${productId}/${skuId}`;
    if(this.creating.has(key))return this.creating.get(key);
    const pending=this.createLocked(productId,skuId,options);this.creating.set(key,pending);
    try{return await pending;}finally{this.creating.delete(key);}
  }
  async createLocked(productId,skuId,options){
    const existing=this.store.imageJobs().find(j=>j.productId===productId&&j.skuId===skuId&&j.provider==='codex'&&j.requestedModel===CODEX_IMAGE_MODEL&&(ACTIVE.includes(j.status)||j.waitReason&&j.status==='paused'));
    if(existing)return existing;
    const product=this.store.product(productId);if(!product)throw new Error('商品不存在');
    if(['running','queued','waiting'].includes(product.status))throw new Error('请等待此商品采集完成后再生成');
    const variant=product.variants.find(v=>v.id===skuId);if(!variant)throw new Error('规格不存在');
    const id=randomUUID();const createdAt=new Date().toISOString();
    const safeName=`${productId}-${skuId}`.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,140);
    const directory=path.join(safeName,`${createdAt.replace(/[:.]/g,'-')}-${id.slice(0,8)}`);
    const batchDir=path.join(this.outputRoot,directory);
    const snapshot=await freezeInput({product,variant,dataDir:this.dataDir,batchDir,skillPath:this.skillPath});
    await mkdir(path.join(batchDir,'results'),{recursive:true});
    const job={provider:'codex',requestedModel:CODEX_IMAGE_MODEL,reasoningEffort:IMAGE_REASONING_EFFORT,executionPolicy:{...IMAGE_EXECUTION_POLICY,reasoningEffort:IMAGE_REASONING_EFFORT},angleMode:SOURCE_ANGLE_MODE,viewEvidence:{},id,productId,skuId,createdAt,directory,snapshot,candidates:planCandidates(snapshot),planVersion:4,status:'queued',message:'已加入GPT-6.1 Sol中等推理队列：每张一稿，最多补查一次',threadIds:[],kind:'batch',options:{autoRepair:false}};
    this.freezeRules(job);
    this.store.saveImageJob(job);this.kick();return job;
  }
  get(id){const job=this.store.imageJob(id);if(!job)throw new Error('生图任务不存在');return job;}
  preferences(){return this.store.stylePreferences();}
  setPreference(id,enabled){
    if(typeof enabled!=='boolean')throw new Error('偏好状态必须为启用或停用');
    const p=this.preferences().find(p=>p.id===id);if(!p)throw new Error('风格偏好不存在');
    p.enabled=enabled;p.updatedAt=new Date().toISOString();return this.store.saveStylePreference(p);
  }
  async setOptions(id,{autoRepair}){
    if(typeof autoRepair!=='boolean')throw new Error('自动修正选项必须为开或关');
    if(autoRepair)throw new Error('自动重画已关闭；如需调整，请使用单张修改或重新生成。');
    const job=this.active?.id===id?this.active.job:this.get(id);job.options={autoRepair};await this.persist(job);return job;
  }
  async adjust(id,candidateId,instruction){
    const text=typeof instruction==='string'?instruction.trim():'';
    if(!text||text.length>1000)throw new Error('请填写1–1000字的摄影风格调整要求。');
    const key=`adjust/${id}/${candidateId}/${hashBuffer(Buffer.from(text))}`;
    if(this.creating.has(key))return this.creating.get(key);
    const work=this.adjustLocked(id,candidateId,text);this.creating.set(key,work);
    try{return await work;}finally{this.creating.delete(key);}
  }
  async adjustLocked(id,candidateId,instruction){
    const existing=this.store.imageJobs().find(j=>ACTIVE.includes(j.status)&&j.parentJobId===id&&j.parentCandidateId===candidateId&&j.adjustment?.instruction===instruction);if(existing)return existing;
    const parent=this.get(id);const original=parent.candidates.find(c=>c.id===candidateId);if(!original)throw new Error('场景图不存在');
    const usePreview=original.status!=='completed';
    const {file}=await this.imageFile(id,candidateId,{preview:usePreview});
    const idNew=randomUUID(),createdAt=new Date().toISOString();
    const directory=path.join(path.dirname(parent.directory),`${createdAt.replace(/[:.]/g,'-')}-${idNew.slice(0,8)}-style`),batchDir=path.join(this.outputRoot,directory);
    const parentDir=await this.directory(parent);await mkdir(batchDir,{recursive:true});
    for(const folder of ['input','skill'])await cp(await containedFile(parentDir,folder),path.join(batchDir,folder),{recursive:true});
    for(const folder of ['angle-input','angle-sources']){const source=await containedFile(parentDir,folder).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(source)await cp(source,path.join(batchDir,folder),{recursive:true});}
    const sourcePlan=await readAnglePlan(parent.snapshot,parentDir);
    if(sourcePlan)await saveAnglePlan(batchDir,sourcePlan);
    const buffer=await readFile(file),ext=imageType(buffer);const sourceFile=`input/style-target.${ext}`;await copyFile(file,path.join(batchDir,sourceFile));
    await mkdir(path.join(batchDir,'results'),{recursive:true});
    const snapshot=structuredClone(parent.snapshot);snapshot.fields={...snapshot.fields,...parent.confirmedUpdates};snapshot.frozenAt=createdAt;
    const job={provider:'codex',requestedModel:CODEX_IMAGE_MODEL,reasoningEffort:IMAGE_REASONING_EFFORT,viewEvidence:structuredClone(parent.viewEvidence||{}),id:idNew,productId:parent.productId,skuId:parent.skuId,createdAt,directory,snapshot,kind:'adjustment',parentJobId:id,parentCandidateId:candidateId,
      adjustment:{instruction,sourceFile,sourceHash:hashBuffer(buffer),sourceImageHash:usePreview?original.preview.hash:original.hash},
      planVersion:parent.planVersion||1,executionPolicy:{...IMAGE_EXECUTION_POLICY,reasoningEffort:IMAGE_REASONING_EFFORT},angleMode:parent.angleMode,options:{autoRepair:false},status:'queued',message:'风格要求已记录，当前图片结束后优先调整',threadIds:[],
      candidates:[{id:original.id,scene:original.scene,label:original.label,letter:original.letter,view:original.view,viewLabel:original.viewLabel,viewBrief:original.viewBrief,angleSource:original.angleSource,warnings:original.warnings?.filter(w=>w.code==='scale_unverified')||[],filename:original.filename,status:'pending',reason:'',attempts:0}]};
    this.freezeRules(job);
    if(this.review)job.feedbackId=this.review.imageCreated(job,parent,original).id;
    let root=parent;while(root.parentJobId)root=this.get(root.parentJobId);
    const liveRoot=this.active?.id===root.id?this.active.job:root;
    if(liveRoot.chosenVersions?.[candidateId]){delete liveRoot.chosenVersions[candidateId];await this.persist(liveRoot);}
    await writeFile(path.join(batchDir,'input-snapshot.json'),JSON.stringify(snapshot,null,2));
    await this.persist(job);this.kick();return job;
  }
  freezeRules(job){job.rulesVersion=this.store.ruleVersion().version;job.rulesSnapshot=Object.fromEntries(['use','overview','angle','scale'].map(scene=>[scene,this.store.applicableStyles(job.snapshot.category,scene).map(({id,instruction,createdAt,origin})=>({id,instruction,createdAt,origin}))]));}
  async selectVersion(rootId,candidateId,assetJobId){
    const root=this.get(rootId),asset=this.get(assetJobId);if(root.parentJobId)throw new Error('请选择完整批次。');
    let ancestor=asset;const seen=new Set();while(ancestor.parentJobId&&!seen.has(ancestor.id)){seen.add(ancestor.id);ancestor=this.get(ancestor.parentJobId);}
    if(ancestor.id!==root.id||!root.candidates.some(c=>c.id===candidateId)||!asset.candidates.some(c=>c.id===candidateId&&(c.status==='completed'||c.preview)))throw new Error('图片版本不属于此场景，或尚未返回。');
    const target=this.active?.id===root.id?this.active.job:root;target.chosenVersions={...target.chosenVersions,[candidateId]:assetJobId};await this.persist(target);this.review?.refreshImageAdoption();return target;
  }
  async directory(job){
    await mkdir(this.outputRoot,{recursive:true});return containedFile(this.outputRoot,job.directory);
  }
  async persist(job){
    this.store.saveImageJob(job);
    this.review?.syncImage(job);
    // Atomic manifest is also usable independently of the database.
    const dir=await this.directory(job);const temp=path.join(dir,`manifest.${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(job,null,2));await rename(temp,path.join(dir,'manifest.json'));
  }
  async resume(id,{retry=false}={}){
    let job=this.get(id);
    if(ACTIVE.includes(job.status))return job;
    // The DB can show a terminal status just before its manifest finishes flushing.
    // Wait for that flush, otherwise a quick "continue" can be silently discarded.
    if(this.active?.id===id){await this.active.finished;job=this.get(id);}
    if(job.status==='done')return job;
    if(!this.customRunner&&(job.provider==='chatgpt_web'||job.requestedModel!==CODEX_IMAGE_MODEL))throw new Error('这是网页或历史模型批次；请重新生成以创建Codex GPT-6.1 Sol新批次，历史成品会保留。');
    if(job.anglePlan?.selectionFailed){
      const {unlink}=await import('node:fs/promises');await unlink(path.join(await this.directory(job),'angle-source-plan.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
      // Keep failed selection usage in the audit trail when explicitly retrying.
      if(job.anglePlan.usage){job.candidates.find(c=>c.scene==='angle').usageHistory||=[];job.candidates.find(c=>c.scene==='angle').usageHistory.push(job.anglePlan.usage);}
      delete job.anglePlan;
    }
    delete job.waitReason;delete job.queueHold;
    job.executionPolicy={...IMAGE_EXECUTION_POLICY,reasoningEffort:IMAGE_REASONING_EFFORT};
    job.policyHistory||=[];job.policyHistory.push({at:new Date().toISOString(),...job.executionPolicy});
    const current=this.store.product(job.productId)?.variants.find(v=>v.id===job.skuId);
    const updates={};
    for(const [key,field] of Object.entries(current?.fields||{}))if(field.status==='manual'&&confirmedField(field))updates[key]=structuredClone(field);
    if(Object.keys(updates).length){
      job.confirmationHistory||=[];job.confirmationHistory.push({at:new Date().toISOString(),fields:updates});
      job.confirmedUpdates={...job.confirmedUpdates,...updates};
      await writeFile(path.join(await this.directory(job),'input-updates.json'),JSON.stringify(job.confirmationHistory,null,2));
    }
    const replanned=planCandidates({...job.snapshot,fields:{...job.snapshot.fields,...job.confirmedUpdates}},{legacy:!job.planVersion||job.planVersion<2,sourceAngles:job.angleMode===SOURCE_ANGLE_MODE});
    for(const c of job.candidates){
      if(c.status==='completed')continue;
      const fresh=replanned.find(p=>p.id===c.id);
      if(fresh)c.warnings=fresh.warnings;
      if(['side','back'].includes(c.view)&&job.viewEvidence?.[c.view]?.length&&c.status==='blocked'){c.status='pending';c.reason='';}
      if(c.status==='blocked'&&fresh?.status!=='blocked'&&(retry||c.scene==='use'||c.scene==='scale')){c.status='pending';c.reason='';}
      if(retry&&c.status==='failed'){
        c.attemptHistory||=[];c.attemptHistory.push({status:c.status,reason:c.reason,failureCode:c.failureCode,traceDiagnostics:c.traceDiagnostics,trace:c.trace,execution:c.execution,at:new Date().toISOString()});
        c.status='pending';c.reason='';delete c.failureCode;delete c.traceDiagnostics;delete c.trace;
      }
    }
    if(!job.candidates.some(c=>c.status==='pending')){
      job.message='没有可继续的候选；缺少依据的场景请先在规格行确认参数。';await this.persist(job);return job;
    }
    job.status='queued';job.message='已加入继续队列';await this.persist(job);this.kick();return job;
  }
  async stop(id){
    const job=this.get(id);if(job.status==='done')return job;
    if(this.active?.id===id){this.active.stop=true;this.active.controller.abort();this.active.runner.close();}
    delete job.waitReason;delete job.queueHold;job.status='stopped';job.message='已停止，已完成图片保留。';
    for(const c of job.candidates)if(c.status==='running')c.status='pending';
    await this.persist(job);this.kick();return job;
  }
  async setEvidence(id,view,imageIds){
    if(!['side','back'].includes(view)||!Array.isArray(imageIds))throw new Error('视角依据格式不正确');
    const job=this.get(id);if(ACTIVE.includes(job.status))throw new Error('请先停止任务再修改视角依据');
    if(imageIds.some(id=>!job.snapshot.refs.some(r=>r.imageId===id)))throw new Error('只能使用本批当前规格原图');
    job.viewEvidence={...job.viewEvidence,[view]:[...new Set(imageIds)]};job.evidenceHistory||=[];job.evidenceHistory.push({view,imageIds:job.viewEvidence[view],at:new Date().toISOString()});await this.persist(job);return job;
  }
  async sourceAngles(id){
    let job=this.get(id);if(ACTIVE.includes(job.status))throw new Error('请先停止任务再应用新角度规则。');
    if(this.active?.id===id){await this.active.finished;job=this.get(id);}
    if(job.parentJobId)throw new Error('请在原始完整批次应用新规则。');
    if(job.provider==='chatgpt_web'||job.requestedModel!==CODEX_IMAGE_MODEL)throw new Error('历史模型批次请点重新生成，新批次使用原素材视角。');
    const fresh=planCandidates(job.snapshot);
    for(const c of job.candidates.filter(c=>c.scene==='angle'&&c.status!=='completed')){
      const next=fresh.find(f=>f.id===c.id);c.previousView={view:c.view,viewLabel:c.viewLabel,reason:c.reason};
      Object.assign(c,{view:next.view,viewLabel:next.viewLabel,viewBrief:next.viewBrief,status:'pending',reason:''});
    }
    job.angleMode=SOURCE_ANGLE_MODE;job.planVersion=3;job.status='paused';delete job.waitReason;
    job.message='未完成角度位已改为原素材视角；点击继续后选角，已完成图片保留。沿用本批冻结素材，重新生成可使用最新共用详情图。';await this.persist(job);return job;
  }
  kick(){if(this.active||this.closing)return;queueMicrotask(()=>this.drain().catch(e=>{this.problem=e.message;}));}
  async drain(){
    if(this.active||this.closing)return;
    // A historical paused batch is not a perpetual global queue lock. Only a
    // failure in this queue policy holds following work until stop/continue.
    if(this.queueBlocker())return;
    const job=this.store.imageJobs().filter(j=>j.status==='queued').sort((a,b)=>(a.kind==='adjustment'?0:1)-(b.kind==='adjustment'?0:1)||a.createdAt.localeCompare(b.createdAt))[0];if(!job)return;
    const runner=this.runnerFactory();const active={id:job.id,job,controller:new AbortController(),runner};let yielded=false;
    active.finished=new Promise(resolve=>{active.resolve=resolve;});this.active=active;
    try{
      const dir=await this.directory(job);job.status='running';job.message=job.provider==='chatgpt_web'?'正在连接ChatGPT会员网页':'正在连接本机 Codex';await this.persist(job);
      if(!this.customRunner&&(job.provider==='chatgpt_web'||job.requestedModel!==CODEX_IMAGE_MODEL))throw new Error('网页及历史模型批次不自动执行；请新建Codex GPT-6.1 Sol批次。');
      if(!job.rulesSnapshot)this.freezeRules(job);
      if(active.stop||this.closing)throw new Error('任务已停止');
      const threadId=await runner.open(job,dir,({model})=>{if(model)job.model=model;});if(threadId){job.threadIds.push(threadId);job.threadId=threadId;}await this.persist(job);
      const factsSnapshot={...job.snapshot,fields:{...job.snapshot.fields,...job.confirmedUpdates}};
      const factsKey=profileKey(factsSnapshot);job.profile=this.store.imageProfile(factsKey)||null;
      for(const c of job.candidates){
        if(active.stop||this.closing)break;if(c.status!=='pending')continue;
        c.preferences=structuredClone(job.rulesSnapshot[c.scene]||[]);
        c.status='running';job.message=`${c.label} ${c.letter} · 正在生成`;await this.persist(job);
        const effective={...job,snapshot:{...job.snapshot,fields:{...job.snapshot.fields,...job.confirmedUpdates}}};
        try{
          c.execution={...job.executionPolicy,model:CODEX_IMAGE_MODEL,reasoningEffort:IMAGE_REASONING_EFFORT,startedAt:new Date().toISOString()};
          const result=await runner.generate(effective,c,dir,{signal:active.controller.signal,onEvent:({message,attempts,preview,threadId,usage,model,anglePlan,angleSource,trace})=>{
            if(model)job.model=model;
            if(angleSource)c.angleSource=angleSource;
            if(trace){c.trace=trace;this.store.saveImageJob(job);}
            if(anglePlan){job.anglePlan=anglePlan;job.usage=usageSummary(job);this.store.saveImageJob(job);}
            if(threadId){job.threadIds.push(threadId);job.threadId=threadId;}
            if(usage){c.usageHistory||=[];c.usageHistory.push(usage);job.usage=usageSummary(job);this.store.saveImageJob(job);}
            if(!active.stop&&!this.closing&&message){if(attempts)c.attempts=attempts;if(preview)c.preview=preview;job.message=`${c.label} ${c.letter} · ${message}`;this.store.saveImageJob(job);}
          }});
          if(active.stop||this.closing){c.status='pending';break;}
          Object.assign(c,result);c.execution.finishedAt=new Date().toISOString();c.execution.durationMs=Date.now()-Date.parse(c.execution.startedAt);
          if(result.pauseReason){const e=imageFailure(result.pauseReason,'图片已保存，但执行触及保护上限；本批已暂停，请核对后再决定是否继续。');throw e;}
          // Models may report transport failures as blocked JSON instead of throwing.
          // Pause here too, before a second image request consumes the same broken connection.
          if(result.status!=='completed'&&connectionFailure(result.reason)){
            c.status='failed';const error=new Error(result.reason);error.waitReason='image_connection';throw error;
          }
          if(result.productBrief){job.profile={brief:result.productBrief,productId:job.productId,skuId:job.skuId,createdAt:new Date().toISOString()};this.store.saveImageProfile(factsKey,job.profile);}
        }catch(e){
          if(c.execution){c.execution.finishedAt=new Date().toISOString();c.execution.durationMs=Date.now()-Date.parse(c.execution.startedAt);c.execution.failureCode=e.failureCode||e.waitReason||'image_failed';}
          if(e.usage){c.usageHistory||=[];c.usageHistory.push(e.usage);job.usage=usageSummary(job);}
          if(active.stop||this.closing){c.status='pending';break;}
          if(e.failureCode){c.failureCode=e.failureCode;if(e.trace)c.trace=e.trace;if(e.traceDiagnostics)c.traceDiagnostics=e.traceDiagnostics;if(c.status==='running')c.status='failed';}
          if(e.waitReason){if(c.status==='running')c.status='pending';if(c.status!=='completed')c.reason=e.message;throw e;}
          c.status='failed';c.reason=e.message;
          // A broken transport/auth connection cannot be repaired by generating the next eleven images.
          if(connectionFailure(e.message)||/等待超过|超过5分钟/.test(e.message)){e.waitReason='image_connection';throw e;}
          if(/冻结/.test(e.message))throw e;
        }
        await this.persist(job);
        if(job.kind!=='adjustment'&&this.store.imageJobs().some(j=>j.status==='queued'&&j.kind==='adjustment')){yielded=true;break;}
      }
      if(this.closing){job.status='paused';job.message='服务停止，已完成图片保留，点击继续。';}
      else if(active.stop){delete job.waitReason;job.status='stopped';job.message='已停止，已完成图片保留。';}
      else if(yielded){job.status='queued';job.message='先处理风格调整，随后继续此批次';}
      else {const summary=imageJobSummary(job);job.status=summary.completed+summary.skipped===summary.total?'done':summary.completed?'partial':summary.failed?'failed':'blocked';job.message=`已生成 ${summary.completed}/${summary.total} 张${summary.skipped?`，${summary.skipped} 个位置缺素材留空`:''}${summary.blocked?`，${summary.blocked} 张缺少依据`:''}${summary.failed?`，${summary.failed} 张失败`:''}`;}
    }catch(e){
      job.waitReason=e.waitReason||null;job.queueHold=Boolean(e.waitReason);job.status=this.closing||e.waitReason?'paused':active.stop?'stopped':job.candidates.some(c=>c.status==='completed')?'partial':'failed';job.message=e.message;
      for(const c of job.candidates)if(c.status==='running')c.status='pending';
    }finally{
      runner.close();try{await this.persist(job);}finally{this.active=null;active.resolve();if(!this.closing)this.kick();}
    }
  }
  async imageFile(id,candidateId,{preview=false}={}){
    const job=this.get(id);const c=job.candidates.find(c=>c.id===candidateId&&(preview?c.preview:c.status==='completed'));
    const asset=preview?c?.preview:c;
    if(!asset?.file)throw new Error('图片尚未返回或不存在');
    const file=await containedFile(await this.directory(job),asset.file);
    const dir=await realpath(path.join(await this.directory(job),preview?'drafts':'results'));
    if(!file.startsWith(dir+path.sep))throw new Error('不允许访问此文件');
    return {file,candidate:preview?{...c,...asset}:c};
  }
  async zip(id,res){
    const job=this.get(id);const files=[];
    for(const c of job.candidates)if(c.status==='completed')files.push({...await this.imageFile(id,c.id),name:path.basename(c.file)});
    if(!files.length)throw new Error('还没有可下载的合格成品');
    const cleaned=await cleanDownloadFiles(files);let disposed=false;const dispose=()=>{if(!disposed){disposed=true;cleaned.cleanup().catch(()=>{});}};res.once('finish',dispose);res.once('close',dispose);
    if(!cleaned.report.success){dispose();throw new Error('没有成功清理的成品，请检查图片清理报告或ExifTool。');}
    res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="etsy-${job.productId}-${job.skuId}.zip"`);res.setHeader('X-Image-Metadata-Cleanup','completed');
    const archive=archiver('zip',{zlib:{level:5}});archive.on('error',e=>res.destroy(e));res.on('close',()=>{if(!res.writableFinished)archive.abort();});archive.pipe(res);
    for(const f of cleaned.files)if(f.file)archive.file(f.file,{name:f.name});
    archive.append(JSON.stringify(cleaned.report,null,2),{name:'元数据清理报告.json'});
    archive.append(JSON.stringify({task:imageJobSummary(job),candidates:job.candidates.map(({file,hash,...c})=>({...c,originalHash:hash,filename:cleaned.files.find(f=>f.candidate.id===c.id)?.file&&file?path.basename(file):null,metadataCleanup:cleaned.files.find(f=>f.candidate.id===c.id)?.cleaning||null})),skill:job.snapshot.skill.sha256},null,2),{name:'成品清单.json'});
    await archive.finalize();
  }
  async close(){this.closing=true;if(this.active){this.active.controller.abort();this.active.runner.close();}while(this.active)await new Promise(r=>setTimeout(r,30));}
}
