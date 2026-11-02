import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {anglePlanKey,materializeAnglePlan,readAnglePlan,selectionPreviewInput} from '../server/angle-sources.js';
import {candidateInput,planCandidates,freezeInput,hashBuffer} from '../server/generation-input.js';
import {CodexImageRunner,usageSummary} from '../server/generation.js';

async function fixture(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-angles-'));await mkdir(path.join(dir,'input'));
  const rgb=Buffer.alloc(800*400*3);for(let y=0;y<400;y++)for(let x=0;x<800;x++){const i=(y*800+x)*3;rgb[i]=x<400?200:20;rgb[i+1]=y%255;rgb[i+2]=x%255;}
  const image=await sharp(rgb,{raw:{width:800,height:400,channels:3}}).png().toBuffer();await writeFile(path.join(dir,'input/one.png'),image);
  await writeFile(path.join(dir,'input/shared.png'),image);await mkdir(path.join(dir,'skill'));await writeFile(path.join(dir,'skill/SKILL.md'),'# style');
  const snapshot={skuId:'purple',skuLabel:'浅紫色',title:'花朵胸针',fields:{},refs:[{imageId:'anchor',path:'input/one.png',hash:hashBuffer(image)}],angleRefs:[{imageId:'shared',path:'input/shared.png',hash:hashBuffer(image),requiresSkuMatch:true}],styleRefs:[],skill:{path:'skill/SKILL.md',sha256:hashBuffer(Buffer.from('# style'))}};
  return {dir,snapshot,clean:()=>rm(dir,{recursive:true,force:true})};
}
const slot=(letter,imageId,crop=[0,0,1,1],extra={})=>({letter,imageId,crop,matchesSku:true,nonFrontal:true,viewDescription:'原图轻微斜拍，保持花瓣连接',reason:'',...extra});
const none=letter=>slot(letter,null,[0,0,1,1],{matchesSku:false,nonFrontal:false,reason:'无更多非正视角'});

test('新角度位接受实际轻斜拍，原像素裁切保留来源，重叠区域和不匹配规格不会凑数',async()=>{
  const f=await fixture();try{
    assert.deepEqual(planCandidates(f.snapshot).filter(c=>c.scene==='angle').map(c=>c.viewLabel),['原素材视角 1','原素材视角 2','原素材视角 3']);
    const plan=await materializeAnglePlan(f.snapshot,{slots:[slot('A','anchor',[0,0,.5,1]),slot('B','shared',[.05,0,.45,1]),slot('C','shared',[.5,0,.5,1],{matchesSku:false})]},f.dir);
    assert.equal(plan.slots[0].status,'ready');assert.match(plan.slots[1].reason,/重复/);assert.match(plan.slots[2].reason,/未确认/);
    const expected=await sharp(path.join(f.dir,'input/one.png')).extract({left:0,top:0,width:400,height:400}).png().toBuffer();assert.deepEqual(await readFile(path.join(f.dir,plan.slots[0].file)),expected);
    assert.equal((await readAnglePlan(f.snapshot,f.dir)).key,anglePlanKey(f.snapshot));
    await writeFile(path.join(f.dir,plan.slots[0].file),'tampered');await assert.rejects(()=>readAnglePlan(f.snapshot,f.dir),/冻结的角度裁切/);
  }finally{await f.clean();}
});

test('一个照片中不同区域可提供不同实际角度；非法来源、越界裁切和正面会明确跳过',async()=>{
 const f=await fixture();try{
  const plan=await materializeAnglePlan(f.snapshot,{slots:[slot('A','anchor',[0,0,.5,1]),slot('B','shared',[.5,0,.5,1]),none('C')]},f.dir);
  assert.equal(plan.slots.filter(s=>s.status==='ready').length,2);
  const input=candidateInput({snapshot:f.snapshot}, {...planCandidates(f.snapshot)[2],angleSource:plan.slots[0]},f.dir);
  assert.deepEqual(input.filter(i=>i.type==='localImage').map(i=>i.path),[path.join(f.dir,'angle-sources/A.png')]);assert.match(input[0].text,/不旋转商品/);assert.match(input[0].text,/Etsy自然实拍风格/);assert.doesNotMatch(input[0].text,/不用轻微斜角冒充侧面/);
  const invalid=await materializeAnglePlan(f.snapshot,{slots:[slot('A','other-sku'),slot('B','anchor',[.8,0,.5,1]),slot('C','anchor',[0,0,1,1],{nonFrontal:false})]},f.dir);
  assert.ok(invalid.slots.every(s=>s.status==='blocked'));
  await assert.rejects(()=>materializeAnglePlan(f.snapshot,{slots:[none('A'),none('A'),none('C')]},f.dir),/格式无效/);
 }finally{await f.clean();}
});

test('选角只执行一次，重启复用；缺口不调用生图，实际生成只收到选中裁切，用量包含一次选角',async()=>{
 const f=await fixture();const calls=[],events=[];let threads=0;
 const client={async startThread(){return 't'+(++threads);},async runTurn(options){calls.push(options);
  if(options.outputSchema.properties.slots)return {messages:[JSON.stringify({slots:[slot('A','anchor',[0,0,.5,1]),slot('B','shared',[.5,0,.5,1]),none('C')]})],items:[],usage:{tokensKnown:true,inputTokens:99,totalTokens:100,imageCalls:0,threadId:'selector',turnId:'selection'}};
  return {messages:[JSON.stringify({status:'blocked',reviewed:false,reason:'fixture—not a generated image',attempts:0,productBrief:''})],items:[],usage:{tokensKnown:true,inputTokens:5,totalTokens:6,imageCalls:0}};
 }};
 const job={id:'batch1',snapshot:f.snapshot,angleMode:'source_photos',candidates:planCandidates(f.snapshot)};
 const runner=new CodexImageRunner();runner.client=client;runner.model='gpt-6.1-sol';runner.threadId='initial';
 try{
  for(const c of job.candidates.filter(c=>c.scene==='angle')){const r=await runner.generate(job,c,f.dir,{onEvent:e=>{events.push(e);if(e.anglePlan)job.anglePlan=e.anglePlan;}});assert.equal(r.attempts,0);}
  assert.equal(calls.filter(c=>c.outputSchema.properties.slots).length,1);assert.equal(calls.length,3);assert.equal(new Set(calls.map(c=>c.threadId)).size,3);
  for(const [index,turn] of calls.slice(1).entries())assert.deepEqual(turn.input.filter(i=>i.type==='localImage').map(i=>i.path),[path.join(f.dir,`angle-sources/${['A','B'][index]}.png`)]);
  const recovered=new CodexImageRunner();recovered.client=client;recovered.model='gpt-6.1-sol';await recovered.generate(job,job.candidates.find(c=>c.id==='angle-C'),f.dir,{onEvent:()=>{}});assert.equal(calls.length,3);
  assert.equal(usageSummary(job).recordedTurns,1);assert.equal(usageSummary(job).totalTokens,100);
  const adjustment={...job,id:'child'};assert.equal(usageSummary(adjustment),null);
 }finally{await f.clean();}
});

test('选角连接失败暂停且不被三个槽位反复重试，失败用量保留',async()=>{
 const f=await fixture();let calls=0;const events=[];const runner=new CodexImageRunner();runner.client={async startThread(){return 's';},async runTurn(){calls++;const e=new Error('quota limit');e.usage={totalTokens:12,tokensKnown:true};throw e;}};
 const job={id:'b',snapshot:f.snapshot};const c=planCandidates(f.snapshot)[2];
 try{
  for(let i=0;i<2;i++)await assert.rejects(()=>runner.generate(job,c,f.dir,{onEvent:e=>events.push(e)}),e=>e.waitReason==='angle_selection');assert.equal(calls,1);assert.equal(events[0].message.includes('一次性'),true);assert.equal(events.find(e=>e.anglePlan).anglePlan.usage.totalTokens,12);
 }finally{await f.clean();}
});

test('冻结选角池排除其他规格独占图，共用图仅供匹配选角；预览限制尺寸，高清来源保留',async()=>{
 const f=await fixture();try{
  const data=path.join(f.dir,'data');await mkdir(path.join(data,'images'),{recursive:true});await copyFile(path.join(f.dir,'input/one.png'),path.join(data,'images/all.png'));
  await mkdir(path.join(f.dir,'skill/references'));await writeFile(path.join(f.dir,'skill/references/scene-guide.md'),'guide');
  const images=[['a',['purple']],['blue',['blue']],['shared',[]],['multi',['purple','blue']]].map(([id,skuIds],order)=>({id,skuIds,order,status:'downloaded',relativePath:'all.png',qualityStatus:'original'}));
  const snapshot=await freezeInput({product:{id:'p',title:'测试商品',fields:{},images},variant:{id:'purple',label:'浅紫色',fields:{}},dataDir:data,batchDir:path.join(f.dir,'batch'),skillPath:path.join(f.dir,'skill/SKILL.md')});
  assert.deepEqual(snapshot.refs.map(r=>r.imageId),['a']);assert.deepEqual(snapshot.angleRefs.map(r=>r.imageId),['shared','multi']);assert.ok(snapshot.angleRefs.every(r=>r.requiresSkuMatch));
  const input=await selectionPreviewInput(snapshot,path.join(f.dir,'batch'));assert.equal(input.filter(i=>i.type==='localImage').length,3);const meta=await sharp(input[1].path).metadata();assert.ok(meta.width<=1280&&meta.height<=1600);assert.equal((await sharp(path.join(f.dir,'batch',snapshot.refs[0].path)).metadata()).width,800);
 }finally{await f.clean();}
});
