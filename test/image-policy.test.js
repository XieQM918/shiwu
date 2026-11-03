import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {ImageTracePolicy,ImageTraceMonitor,imageFailure} from '../server/image-trace.js';
import {frozenStyle} from '../server/image-style.js';
import {hashBuffer,planCandidates,candidateInput} from '../server/generation-input.js';
import {CodexImageRunner,usageSummary} from '../server/generation.js';
import {CodexClient} from '../server/codex-client.js';
import {fakeTraceFactory} from './helpers/image-trace.js';
const call=(name,id,input)=>({type:'response_item',payload:{type:'custom_tool_call',name,call_id:id,input}});
const output=(id,text)=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output:text}});
const imageCall=()=>call('exec','image','// @exec: {"yield_time_ms":120000}\nconst result=await tools.image_gen__imagegen({});generatedImage(result);');
const running=()=>output('image','Script running with cell ID image:1\nOutput:\n');
const wait=(id='wait1',ms=120000)=>call('wait',id,JSON.stringify({cell_id:'image:1',yield_time_ms:ms}));

test('首次等待加唯一一次补查，重复通知不重复计数，返回图片后不误触超时',()=>{
 let now=0;const p=new ImageTracePolicy({now:()=>now});p.feed(imageCall());p.feed(running());now=120000;p.feed(wait());p.feed(wait());assert.equal(p.state.additionalWaits,1);assert.equal(p.state.imageCalls,1);assert.equal(p.error,undefined);p.returnedImage();now=250000;p.tick();assert.equal(p.error,undefined);
});
test('第二次补查、短轮询、错误任务和第二次生图均触发可诊断中断',()=>{
 for(const [record,code] of [[wait('wait2'),'poll_limit'],[wait('wait2',1000),'poll_limit'],[call('exec','image2',imageCall().payload.input),'image_call_limit']]){const p=new ImageTracePolicy();p.feed(imageCall());p.feed(running());p.feed(wait());p.feed(record);assert.equal(p.error.failureCode,code);assert.equal(p.state.additionalWaits,1);}
 const short=new ImageTracePolicy();short.feed(imageCall());short.feed(running());short.feed(wait('wait1',1000));assert.equal(short.error.failureCode,'poll_protocol');
 const invalid=new ImageTracePolicy();invalid.feed(imageCall());invalid.feed(running());invalid.feed(call('wait','w',JSON.stringify({cell_id:'other',yield_time_ms:120000})));assert.equal(invalid.error.failureCode,'poll_protocol');
 const redraw=new ImageTracePolicy();redraw.feed(call('exec','x','await tools.image_gen__imagegen({});'));assert.equal(redraw.error.failureCode,'poll_protocol');
});
test('四分钟截止和一分钟准备上限由本机计时触发；明示连接错误即时停止',()=>{
 let now=0;const p=new ImageTracePolicy({now:()=>now});p.feed(imageCall());now=239999;p.tick();assert.equal(p.error,undefined);now=240000;p.tick();assert.equal(p.error.failureCode,'image_timeout');
 now=0;const prep=new ImageTracePolicy({now:()=>now});now=60000;prep.tick();assert.equal(prep.error.failureCode,'preparation_timeout');
 const bad=new ImageTracePolicy();bad.feed(imageCall());bad.feed(output('image','image generation failed: connection failed: error sending request'));assert.equal(bad.error.failureCode,'image_connection');
});
test('回放42次及47次旧式短轮询记录，首次违规即停止，不继续消耗',()=>{
 for(const count of [42,47]){const p=new ImageTracePolicy();p.feed(imageCall());p.feed(running());let accepted=0;for(let n=0;n<count;n++){if(p.error)break;p.feed(wait('w'+n,n<3?1000:10000));accepted++;}assert.equal(accepted,1);assert.equal(p.error.failureCode,'poll_protocol');assert.equal(p.state.additionalWaits,0);}
});
test('追加视觉查看与打印完整图片对象会被识别，正常generatedImage返回允许',()=>{
 const view=new ImageTracePolicy();view.feed(call('exec','v','image(await tools.view_image({path:"a"}));'));assert.equal(view.error.failureCode,'review_limit');
 const text=new ImageTracePolicy();text.feed(call('exec','x',imageCall().payload.input+'text(result);'));assert.equal(text.error.failureCode,'output_protocol');
});
test('增量读取真实JSONL：中文跨块、未写完的行、路径越界及截断均正确处理',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw 监测-'));let monitor;try{
  const file=path.join(dir,'rollout-thread1.jsonl');await writeFile(file,'{"type":"session_meta"}\n');monitor=new ImageTraceMonitor({allowedRoot:dir,intervalMs:10000});await monitor.start(file,'thread1');
  const bytes=Buffer.from(JSON.stringify(imageCall())+'\n');await appendFile(file,bytes.subarray(0,7));await monitor.flush();assert.equal(monitor.state.imageCalls,0);await appendFile(file,bytes.subarray(7));await monitor.flush();assert.equal(monitor.state.imageCalls,1);
  await appendFile(file,JSON.stringify(running())+'\n'+JSON.stringify(wait())+'\n');await monitor.flush();assert.equal(monitor.state.additionalWaits,1);
  await writeFile(file,'');await monitor.flush();assert.equal(monitor.error.failureCode,'trace_unavailable');await monitor.stop();
  const outside=await mkdtemp(path.join(os.tmpdir(),'outside-'));try{const other=path.join(outside,'thread1.jsonl');await writeFile(other,'');await symlink(outside,path.join(dir,'escape'),'junction');await assert.rejects(()=>new ImageTraceMonitor({allowedRoot:dir}).start(path.join(dir,'escape/thread1.jsonl'),'thread1'),e=>e.failureCode==='trace_unavailable');}finally{await rm(outside,{recursive:true,force:true});}
 }finally{await monitor?.stop();await rm(dir,{recursive:true,force:true});}
});
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-medium-'));await mkdir(path.join(dir,'input'));await mkdir(path.join(dir,'skill/references'),{recursive:true});
 const skill='# Skill\n## 3. 真实感与候选变化\n- 自然皮肤纹理、金属明暗过渡，左侧柔光。\n- 三张角度图分别完成正面、侧面、背面任务。\n## 4. 逐张生成与检查\n旧严格流程';
 const guide='## 配色、光线与质感\n奶油白与暖石色，接触阴影。\n## 本地参考图索引\nnot a fact';await writeFile(path.join(dir,'skill/SKILL.md'),skill);await writeFile(path.join(dir,'skill/references/scene-guide.md'),guide);
 const source=await sharp({create:{width:8,height:8,channels:3,background:'#0000aa'}}).png().toBuffer();await writeFile(path.join(dir,'input/a.png'),source);
 const snapshot={title:'测试胸针',skuId:'purple',skuLabel:'紫色',fields:{},category:'brooch',refs:[{imageId:'a',path:'input/a.png',hash:hashBuffer(source)}],angleRefs:[],styleRefs:[],skill:{path:'skill/SKILL.md',sha256:hashBuffer(Buffer.from(skill)),guideSha256:hashBuffer(Buffer.from(guide))}};
 return {dir,snapshot,clean:()=>rm(dir,{recursive:true,force:true})};
}
test('本机编译保留Etsy摄影规范而不注入旧流程，缺尺寸警告不回填事实',async()=>{
 const f=await fixture();try{const profile=await frozenStyle(f.snapshot,f.dir);assert.match(profile.text,/自然皮肤纹理/);assert.match(profile.text,/奶油白/);assert.doesNotMatch(profile.text,/旧严格流程|三张角度图分别/);assert.deepEqual(await frozenStyle(f.snapshot,f.dir),profile);
  const c=planCandidates(f.snapshot)[0];assert.equal(c.status,'pending');assert.equal(c.warnings[0].code,'scale_unverified');const input=candidateInput({snapshot:f.snapshot,styleProfile:profile},c,f.dir);assert.match(input[0].text,/缺少长宽仍按实图/);assert.equal(input.some(i=>i.type==='skill'),false);assert.equal(f.snapshot.fields.length,undefined);
  await writeFile(path.join(f.dir,'skill/SKILL.md'),'changed');await assert.rejects(()=>frozenStyle(f.snapshot,f.dir),/冻结的Skill/);
 }finally{await f.clean();}
});
test('无法读取当前会话工具记录时，实际生图调用为零',async()=>{
 const f=await fixture();let calls=0;const runner=new CodexImageRunner({ocr:{}});runner.threadId='unavailable';runner.client={async threadPath(){return null;},async runTurn(){calls++;}};
 try{await assert.rejects(()=>runner.generate({snapshot:f.snapshot},planCandidates(f.snapshot)[0],f.dir),e=>e.failureCode==='trace_unavailable');assert.equal(calls,0);}finally{await f.clean();}
});
test('未核验、低分辨率和非方图仍保存；JSON缺失不触发额外审核，返回medium及一次生成记录',async()=>{
 const f=await fixture();const runner=new CodexImageRunner({traceFactory:fakeTraceFactory,ocr:{dimensions:async file=>sharp(file).metadata()}});runner.threadId='native';
 try{
  const native=path.join(f.dir,'native.png');await sharp({create:{width:320,height:200,channels:3,background:'#aa0000'}}).png().toFile(native);
  const sent=[];runner.client={async runTurn(options){sent.push(options);options.onEvent({method:'item/completed',params:{item:{type:'imageGeneration',id:'g',status:'completed',savedPath:native}}});return {messages:['invalid-json'],items:[],usage:{tokensKnown:true,inputTokens:100,cachedInputTokens:80,imageCalls:1}};}};
  const events=[];const r=await runner.generate({snapshot:f.snapshot},planCandidates(f.snapshot)[0],f.dir,{onEvent:e=>events.push(e)});assert.equal(r.status,'completed');assert.equal(r.reviewState,'pending_user');assert.equal(r.pauseReason,undefined);assert.equal(sent.length,1);assert.equal(sent[0].effort,'medium');assert.equal(sent[0].maxModelSteps,8);assert.deepEqual(r.warnings.map(w=>w.code).slice(0,4),['scale_unverified','low_resolution','non_square','review_unavailable']);assert.ok((await readFile(path.join(f.dir,r.file))).length);assert.equal(events.find(e=>e.usage).usage.imageCalls,1);
 }finally{await f.clean();}
});
test('八轮模型输入硬保护、去重token通知、非缓存与推理强度记录不遗漏',async()=>{
 const c=new CodexClient();const interrupts=[];c.request=async(method,params)=>{
  if(method==='account/rateLimits/read')return null;if(method==='turn/interrupt'){interrupts.push(params);return {};}
  if(method==='turn/start'){queueMicrotask(()=>{for(let n=1;n<=10;n++){const event={method:'thread/tokenUsage/updated',params:{threadId:'t',turnId:'v',tokenUsage:{total:{inputTokens:100*n,cachedInputTokens:80*n,outputTokens:n,totalTokens:101*n}}}};c.emit('notification',event);c.emit('notification',event);}});return {turn:{id:'v'}};}
 };
 try{await assert.rejects(()=>c.runTurn({threadId:'t',input:[],collectUsage:true,maxModelSteps:8,effort:'medium'}),e=>e.failureCode==='model_step_limit'&&e.usage.modelSteps===8&&e.usage.uncachedInputTokens===160&&e.usage.reasoningEffort==='medium');assert.ok(interrupts.length);assert.equal(c.listenerCount('notification'),0);}finally{c.close();}
});
test('用量汇总将缓存与非缓存分开，旧记录不伪造内部轮数',()=>{
 const u=usageSummary({id:'j',candidates:[{usageHistory:[{tokensKnown:true,inputTokens:3513280,cachedInputTokens:3317248,outputTokens:7949,imageCalls:4}]}]});assert.equal(u.uncachedInputTokens,196032);assert.equal(u.modelStepRecordedTurns,0);
});

test('达到保护上限时仍保存本次实际返回图片，同时要求暂停整批',async()=>{
 const f=await fixture();const runner=new CodexImageRunner({traceFactory:fakeTraceFactory,ocr:{dimensions:async file=>sharp(file).metadata()}});runner.threadId='guard';
 try{
  const native=path.join(f.dir,'returned.png');await sharp({create:{width:32,height:32,channels:3,background:'#22aa33'}}).png().toFile(native);
  runner.client={async runTurn(o){o.onEvent({method:'item/completed',params:{item:{type:'imageGeneration',id:'only',status:'completed',savedPath:native}}});throw imageFailure('model_step_limit','达到八轮上限');}};
  const r=await runner.generate({snapshot:f.snapshot},planCandidates(f.snapshot)[0],f.dir);assert.equal(r.status,'completed');assert.equal(r.pauseReason,'model_step_limit');assert.ok((await readFile(path.join(f.dir,r.file))).length);
 }finally{await f.clean();}
});

test('选定原素材裁切也不能作为生成结果，原始输入不能冒充成品',async()=>{
 const f=await fixture();const runner=new CodexImageRunner({traceFactory:fakeTraceFactory,ocr:{dimensions:async file=>sharp(file).metadata()}});runner.threadId='crop';
 try{const crop=await sharp({create:{width:20,height:10,channels:3,background:'#ffee11'}}).png().toBuffer(),file=path.join(f.dir,'crop.png');await writeFile(file,crop);runner.client={async runTurn(){return {messages:[JSON.stringify({path:file})],items:[{type:'imageGeneration',id:'bad',status:'completed',savedPath:file}]};}};
  await assert.rejects(()=>runner.generate({snapshot:f.snapshot},{...planCandidates(f.snapshot)[0],angleSource:{hash:hashBuffer(crop)}},f.dir),e=>e.failureCode==='file_invalid');
 }finally{await f.clean();}
});
