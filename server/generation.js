import path from 'node:path';
import {mkdir,readFile,writeFile,stat,rename,realpath,copyFile,cp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {spawn} from 'node:child_process';
import archiver from 'archiver';
import {cleanDownloadFiles} from './download-cleaner.js';
import {ChatGPTBrowser,ChatGPTImageRunner} from './chatgpt-web.js';
import {CodexClient,finalJson} from './codex-client.js';
import {freezeInput,planCandidates,confirmedField,candidateInput,RESULT_SCHEMA,containedFile,hashBuffer,profileKey} from './generation-input.js';

const ACTIVE=['queued','running'];
export function usageSummary(job){
  const records=job.candidates.flatMap(c=>c.usageHistory||[]);
  if(!records.length)return null;
  const known=records.filter(r=>r.tokensKnown);
  return {recordedTurns:records.length,tokenRecordedTurns:known.length,...Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens','imageCalls','imageViews','commands','durationMs'].map(k=>[k,records.reduce((n,r)=>n+(Number(r[k])||0),0)])),quotaBefore:records[0].quotaBefore||null,quotaAfter:records.at(-1).quotaAfter||null};
}
export function imageJobSummary(job){
  const completed=job.candidates.filter(c=>c.status==='completed').length;
  return {id:job.id,productId:job.productId,skuId:job.skuId,skuLabel:job.snapshot.skuLabel,status:job.status,message:job.message,
    createdAt:job.createdAt,updatedAt:job.updatedAt,completed,total:job.candidates.length,
    blocked:job.candidates.filter(c=>c.status==='blocked').length,failed:job.candidates.filter(c=>c.status==='failed').length,
    previews:job.candidates.filter(c=>c.preview&&c.status!=='completed').length,
    kind:job.kind||'batch',parentJobId:job.parentJobId,parentCandidateId:job.parentCandidateId,
    provider:job.provider||'codex',waitReason:job.waitReason||null,usage:job.usage||null,planVersion:job.planVersion||1,
    current:job.candidates.find(c=>c.status==='running')?.id||null};
}
export function imageType(buffer){
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return 'jpg';
  if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'webp';
  throw new Error('输出不是支持的真实图片文件');
}

export class CodexImageRunner {
  constructor({ocr,clientFactory=options=>new CodexClient(options)}={}){this.ocr=ocr;this.clientFactory=clientFactory;}
  async open(job,batchDir,onEvent){
    this.usedThread=false;
    if(process.platform==='darwin'){
      // Let the display sleep while keeping an explicitly started batch running.
      this.keepAwake=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});this.keepAwake.on('error',()=>{});
    }
    this.client=this.clientFactory({cwd:batchDir});await this.client.connect();
    const models=await this.client.request('model/list',{includeHidden:false});
    const selected=models.data?.find(m=>m.isDefault)||models.data?.[0];
    if(!selected)throw new Error('当前 Codex 账号没有可用模型，请检查本机登录状态。');
    this.model=selected.model||selected.id;
    const instructions='你只负责当前一张商品摄影，使用独立短会话，不需要前面成品的历史。原图已在输入展示，不重复打开；Skill/指南至多各读取一次，风格参考最多一张。快速出图并做一次简短核对，默认不自动重画，不写长篇分析。内置生图返回图片已在视觉上下文中时不再重复view_image。只在当前任务目录保存，不改代码、设置、不读凭据、不发消息、不创建子代理；缺少指定视角依据时直接返回blocked，不耗费生图。';
    this.instructions=instructions;
    // A fresh runtime thread on recovery avoids accidentally continuing an interrupted tool call.
    this.threadId=await this.client.startThread({cwd:batchDir,developerInstructions:instructions,model:this.model});
    onEvent({threadId:this.threadId,model:this.model});return this.threadId;
  }
  async generate(job,candidate,batchDir,{signal,onEvent}){
    for(const ref of [...job.snapshot.refs,...job.snapshot.styleRefs]){
      if(ref.hash&&hashBuffer(await readFile(await containedFile(batchDir,ref.path)))!==ref.hash)throw new Error('冻结的参考图片发生变化，请重新建立批次。');
    }
    if(hashBuffer(await readFile(path.join(batchDir,job.snapshot.skill.path)))!==job.snapshot.skill.sha256)throw new Error('冻结的 Skill 版本发生变化，请重新建立批次。');
    // Never replay the previous generated images into the next photograph.
    if(this.usedThread){this.threadId=await this.client.startThread({cwd:batchDir,developerInstructions:this.instructions,model:this.model});onEvent({threadId:this.threadId});}
    this.usedThread=true;
    const attempts=new Set(),previewTasks=[];const maxAttempts=job.options?.autoRepair?3:1;
    const result=await this.client.runTurn({threadId:this.threadId,input:candidateInput(job,candidate,batchDir),outputSchema:RESULT_SCHEMA,signal,collectUsage:true,onEvent:event=>{
      const item=event.params?.item;
      if(item?.type==='imageGeneration'){
        attempts.add(item.id);
        if(attempts.size>maxAttempts){this.client.request('turn/interrupt',{threadId:this.threadId,turnId:event.params.turnId},5000).catch(()=>{});return;}
        onEvent({attempts:attempts.size,message:event.method==='item/started'?`正在调用内置生图${attempts.size>1?` · 第${attempts.size-1}次修正`:''}`:'图片已返回，正在检查'});
        if(event.method==='item/completed'&&item.status==='completed'&&item.savedPath){
          const task=this.publishPreview(item.savedPath,job,candidate,batchDir).then(preview=>{if(!signal?.aborted)onEvent({preview,message:'图片已返回，可预览 · 正在核对'});}).catch(()=>{});previewTasks.push(task);
        }
      }
      else if(item?.type==='imageView')onEvent({message:'正在对照原图检查'});
    }});
    await Promise.all(previewTasks);
    if(result.usage)onEvent({usage:result.usage});
    const answer=finalJson(result);
    const productBrief=typeof answer.productBrief==='string'?answer.productBrief.slice(0,600):'';
    if(!['completed','blocked','failed'].includes(answer.status))throw new Error('Codex 返回的任务状态无效');
    if(answer.status!=='completed')return {status:answer.status,reason:answer.reason||'缺少生成依据',attempts:answer.attempts||0,productBrief};
    if(answer.reviewed!==true)throw new Error('输出尚未经过逐张检查，未列为合格成品');
    if(!answer.path) return {status:'failed',reason:answer.reason||'本张未形成合格图片文件',attempts:answer.attempts||0};
    const generation=result.items.filter(i=>i.type==='imageGeneration'&&i.status!=='failed');
    // Native image generation must have really happened, not just a copied source file.
    const mcpGeneration=result.items.filter(i=>i.type==='mcpToolCall'&&/imagegen|image_gen/.test(`${i.server} ${i.tool}`)&&i.status==='completed');
    if(!generation.length&&!mcpGeneration.length)throw new Error('未收到内置生图调用记录，不能将现有图片或文字列为生成成功');
    const resultsRoot=path.join(batchDir,'results');
    const output=await containedFile(resultsRoot,path.relative(resultsRoot,String(answer.path||'')));
    const info=await stat(output);if(!info.isFile()||info.size<1024)throw new Error('生成图片文件缺失或不完整');
    const buffer=await readFile(output);const hash=hashBuffer(buffer);
    if([...job.snapshot.refs,...job.snapshot.styleRefs].some(r=>r.hash===hash))throw new Error('输出与输入参考图相同，未视为生成成品');
    let viewed=false;
    const generatedRoot=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images');
    // The native tool supplies its returned image in the model's visual context.
    // A matching saved native result plus reviewed:true is sufficient; reopening
    // the identical file with view_image would repeat the same visual inspection.
    for(const item of generation.filter(i=>i.status==='completed'&&i.savedPath)){
      const nativePath=path.resolve(item.savedPath);
      if(!nativePath.startsWith(generatedRoot+path.sep)&&!nativePath.startsWith(path.resolve(batchDir)+path.sep))continue;
      try{if(hashBuffer(await readFile(nativePath))===hash){viewed=true;break;}}catch{}
    }
    for(const item of result.items.filter(i=>i.type==='imageView')){
      const viewedPath=path.resolve(item.path);
      if(!viewedPath.startsWith(path.resolve(batchDir)+path.sep)&&!viewedPath.startsWith(generatedRoot+path.sep))continue;
      try{if(hashBuffer(await readFile(viewedPath))===hash){viewed=true;break;}}catch{}
    }
    if(!viewed)throw new Error('没有实际查看该成品文件的记录，未列为合格成品');
    const ext=imageType(buffer);const filename=`${candidate.filename}.${ext}`;const target=path.join(resultsRoot,filename);
    if(output!==target)await rename(output,target);
    const dimensions=await this.ocr.dimensions(target);
    if(!dimensions.width||!dimensions.height||Math.min(dimensions.width,dimensions.height)<512)throw new Error('生成图片像素过小或无法读取');
    if(Math.abs(dimensions.width/dimensions.height-1)>.025)throw new Error('生成图片不是约定的方形，未列为合格成品');
    return {status:'completed',reason:answer.reason||'已查看并核对',recommendation:answer.recommendation||'',attempts:answer.attempts||1,
      file:`results/${filename}`,hash,bytes:info.size,width:dimensions.width,height:dimensions.height,reviewedAt:new Date().toISOString(),
      generationEvidence:generation.map(i=>({id:i.id,status:i.status})),turnId:result.turnId,productBrief};
  }
  async publishPreview(source,job,candidate,batchDir){
    const file=await realpath(source);const generatedRoot=await realpath(path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images')).catch(()=>null);
    if(!(generatedRoot&&file.startsWith(generatedRoot+path.sep))&&!file.startsWith(await realpath(batchDir)+path.sep))throw new Error('预览文件超出允许范围');
    const buffer=await readFile(file);if(buffer.length<1024)throw new Error('图片尚未保存完整');
    const hash=hashBuffer(buffer);if(job.snapshot.refs.some(r=>r.hash===hash))throw new Error('不能把原图作为预览');
    const ext=imageType(buffer);const relative=`drafts/${candidate.filename}-${hash.slice(0,12)}.${ext}`;
    await mkdir(path.join(batchDir,'drafts'),{recursive:true});const target=path.join(batchDir,relative);await copyFile(file,target);
    const size=await this.ocr.dimensions(target);if(Math.min(size.width||0,size.height||0)<512)throw new Error('预览像素异常');
    return {file:relative,hash,width:size.width,height:size.height,bytes:buffer.length,createdAt:new Date().toISOString(),review:'pending'};
  }
  close(){this.client?.close();this.keepAwake?.kill();}
}

export class GenerationService {
  constructor({store,dataDir,outputRoot,skillPath,ocr,review,runnerFactory=null}){
    Object.assign(this,{store,dataDir,outputRoot,skillPath,runnerFactory,review});
    this.customRunner=Boolean(runnerFactory);this.chatgpt=new ChatGPTBrowser({dataDir});this.runnerFactory=runnerFactory||(()=>new ChatGPTImageRunner({browser:this.chatgpt}));
    this.active=null;this.creating=new Map();this.closing=false;
  }
  summaries(){return this.store.imageJobs().map(imageJobSummary);}
  async create(productId,skuId,options={}){
    const key=`${productId}/${skuId}`;
    if(this.creating.has(key))return this.creating.get(key);
    const pending=this.createLocked(productId,skuId,options);this.creating.set(key,pending);
    try{return await pending;}finally{this.creating.delete(key);}
  }
  async createLocked(productId,skuId,options){
    const existing=this.store.imageJobs().find(j=>j.productId===productId&&j.skuId===skuId&&(ACTIVE.includes(j.status)||j.provider==='chatgpt_web'&&j.waitReason&&j.status==='paused'));
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
    const job={provider:'chatgpt_web',requestedModel:'gpt-6-luna',viewEvidence:{},id,productId,skuId,createdAt,directory,snapshot,candidates:planCandidates(snapshot),planVersion:2,status:'queued',message:'已加入精简生图队列：最多6张，角度为正面/侧面/背面',threadIds:[],kind:'batch',options:{autoRepair:options?.autoRepair===true}};
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
    const buffer=await readFile(file),ext=imageType(buffer);const sourceFile=`input/style-target.${ext}`;await copyFile(file,path.join(batchDir,sourceFile));
    await mkdir(path.join(batchDir,'results'),{recursive:true});
    const snapshot=structuredClone(parent.snapshot);snapshot.fields={...snapshot.fields,...parent.confirmedUpdates};snapshot.frozenAt=createdAt;
    const job={provider:'chatgpt_web',requestedModel:'gpt-6-luna',viewEvidence:structuredClone(parent.viewEvidence||{}),id:idNew,productId:parent.productId,skuId:parent.skuId,createdAt,directory,snapshot,kind:'adjustment',parentJobId:id,parentCandidateId:candidateId,
      adjustment:{instruction,sourceFile,sourceHash:hashBuffer(buffer),sourceImageHash:usePreview?original.preview.hash:original.hash},
      planVersion:parent.planVersion||1,options:{autoRepair:false},status:'queued',message:'风格要求已记录，当前图片结束后优先调整',threadIds:[],
      candidates:[{id:original.id,scene:original.scene,label:original.label,letter:original.letter,view:original.view,viewLabel:original.viewLabel,viewBrief:original.viewBrief,filename:original.filename,status:'pending',reason:'',attempts:0}]};
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
    if(!this.customRunner&&job.provider!=='chatgpt_web')throw new Error('这是历史Codex批次；请重新生成以创建ChatGPT会员网页批次，不会自动继续消耗Codex额度。');
    delete job.waitReason;
    const current=this.store.product(job.productId)?.variants.find(v=>v.id===job.skuId);
    const updates={};
    for(const [key,field] of Object.entries(current?.fields||{}))if(field.status==='manual'&&confirmedField(field))updates[key]=structuredClone(field);
    if(Object.keys(updates).length){
      job.confirmationHistory||=[];job.confirmationHistory.push({at:new Date().toISOString(),fields:updates});
      job.confirmedUpdates={...job.confirmedUpdates,...updates};
      await writeFile(path.join(await this.directory(job),'input-updates.json'),JSON.stringify(job.confirmationHistory,null,2));
    }
    const replanned=planCandidates({...job.snapshot,fields:{...job.snapshot.fields,...job.confirmedUpdates}},{legacy:!job.planVersion||job.planVersion<2});
    for(const c of job.candidates){
      if(c.status==='completed')continue;
      const fresh=replanned.find(p=>p.id===c.id);
      if(job.provider==='chatgpt_web'&&['side','back'].includes(c.view)&&job.viewEvidence?.[c.view]?.length&&c.status==='blocked'){c.status='pending';c.reason='';}
      if(c.status==='blocked'&&fresh?.status!=='blocked'&&(retry||c.scene==='use'||c.scene==='scale')){c.status='pending';c.reason='';}
      if(retry&&c.status==='failed'){c.status='pending';c.reason='';}
    }
    if(!job.candidates.some(c=>c.status==='pending')){
      job.message='没有可继续的候选；缺少依据的场景请先在规格行确认参数。';await this.persist(job);return job;
    }
    job.status='queued';job.message='已加入继续队列';await this.persist(job);this.kick();return job;
  }
  async stop(id){
    const job=this.get(id);if(job.status==='done')return job;
    if(this.active?.id===id){this.active.stop=true;this.active.controller.abort();this.active.runner.close();}
    delete job.waitReason;job.status='stopped';job.message='已停止，已完成图片保留。';
    for(const c of job.candidates)if(c.status==='running')c.status='pending';
    await this.persist(job);this.kick();return job;
  }
  async setEvidence(id,view,imageIds){
    if(!['side','back'].includes(view)||!Array.isArray(imageIds))throw new Error('视角依据格式不正确');
    const job=this.get(id);if(ACTIVE.includes(job.status))throw new Error('请先停止任务再修改视角依据');
    if(imageIds.some(id=>!job.snapshot.refs.some(r=>r.imageId===id)))throw new Error('只能使用本批当前规格原图');
    job.viewEvidence={...job.viewEvidence,[view]:[...new Set(imageIds)]};job.evidenceHistory||=[];job.evidenceHistory.push({view,imageIds:job.viewEvidence[view],at:new Date().toISOString()});await this.persist(job);return job;
  }
  kick(){if(this.active||this.closing)return;queueMicrotask(()=>this.drain().catch(e=>{this.problem=e.message;}));}
  async drain(){
    if(this.active||this.closing)return;
    if(this.store.imageJobs().some(j=>j.provider==='chatgpt_web'&&j.waitReason&&j.status==='paused'))return;
    const job=this.store.imageJobs().filter(j=>j.status==='queued').sort((a,b)=>(a.kind==='adjustment'?0:1)-(b.kind==='adjustment'?0:1)||a.createdAt.localeCompare(b.createdAt))[0];if(!job)return;
    const runner=this.runnerFactory();const active={id:job.id,job,controller:new AbortController(),runner};let yielded=false;
    active.finished=new Promise(resolve=>{active.resolve=resolve;});this.active=active;
    try{
      const dir=await this.directory(job);job.status='running';job.message=job.provider==='chatgpt_web'?'正在连接ChatGPT会员网页':'正在连接本机 Codex';await this.persist(job);
      if(!this.customRunner&&job.provider!=='chatgpt_web')throw new Error('历史Codex批次不会自动执行；请新建ChatGPT网页批次。');
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
          const result=await runner.generate(effective,c,dir,{signal:active.controller.signal,onEvent:({message,attempts,preview,threadId,usage,model})=>{
            if(model)job.model=model;
            if(threadId){job.threadIds.push(threadId);job.threadId=threadId;}
            if(usage){c.usageHistory||=[];c.usageHistory.push(usage);job.usage=usageSummary(job);this.store.saveImageJob(job);}
            if(!active.stop&&!this.closing&&message){if(attempts)c.attempts=attempts;if(preview)c.preview=preview;job.message=`${c.label} ${c.letter} · ${message}`;this.store.saveImageJob(job);}
          }});
          if(active.stop||this.closing){c.status='pending';break;}
          Object.assign(c,result);
          if(result.productBrief){job.profile={brief:result.productBrief,productId:job.productId,skuId:job.skuId,createdAt:new Date().toISOString()};this.store.saveImageProfile(factsKey,job.profile);}
        }catch(e){
          if(e.usage){c.usageHistory||=[];c.usageHistory.push(e.usage);job.usage=usageSummary(job);}
          if(active.stop||this.closing){c.status='pending';break;}
          if(e.waitReason){c.status='pending';c.reason=e.message;throw e;}
          c.status='failed';c.reason=e.message;
          // A broken transport/auth connection cannot be repaired by generating the next eleven images.
          if(/连接|超时|登录|冻结|auth|rate.limit|quota|usage.limit|not available|not supported|工具不可用|未收到内置生图/i.test(e.message))throw e;
        }
        await this.persist(job);
        if(job.kind!=='adjustment'&&this.store.imageJobs().some(j=>j.status==='queued'&&j.kind==='adjustment')){yielded=true;break;}
      }
      if(this.closing){job.status='paused';job.message='服务停止，已完成图片保留，点击继续。';}
      else if(active.stop){delete job.waitReason;job.status='stopped';job.message='已停止，已完成图片保留。';}
      else if(yielded){job.status='queued';job.message='先处理风格调整，随后继续此批次';}
      else {const summary=imageJobSummary(job);job.status=summary.completed===summary.total?'done':summary.completed?'partial':summary.failed?'failed':'blocked';job.message=`已完成 ${summary.completed}/${summary.total} 张${summary.blocked?`，${summary.blocked} 张缺少依据`:''}${summary.failed?`，${summary.failed} 张失败`:''}`;}
    }catch(e){
      job.waitReason=e.waitReason||null;job.status=this.closing||e.waitReason?'paused':active.stop?'stopped':job.candidates.some(c=>c.status==='completed')?'partial':'failed';job.message=e.message;
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
  async close(){this.closing=true;if(this.active){this.active.controller.abort();this.active.runner.close();}while(this.active)await new Promise(r=>setTimeout(r,30));await this.chatgpt.close();}
}
