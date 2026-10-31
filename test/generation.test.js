import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../server/db.js';
import {ReviewService} from '../server/review.js';
import {newProduct,extractFields} from '../server/domain.js';
import {GenerationService,CodexImageRunner,imageJobSummary,imageType} from '../server/generation.js';
import {freezeInput,planCandidates,containedFile,candidateInput} from '../server/generation-input.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO/kAAAAASUVORK5CYII=','base64');
async function setup(){
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-gen-'));const dataDir=path.join(dir,'data');const outputRoot=path.join(dir,'output');
  const store=new Store(dataDir);const skillPath=path.join(dir,'skill/SKILL.md');await mkdir(path.join(dir,'skill/references'),{recursive:true});await writeFile(skillPath,'# test skill');await writeFile(path.join(dir,'skill/references/scene-guide.md'),'# test guide');
  const p=newProduct({id:'123',url:'https://detail.1688.com/offer/123.html'});p.title='测试商品';p.status='done';p.variantMode='sku';
  p.variants=[{id:'purple',label:'紫色',fields:extractFields([])},{id:'blue',label:'蓝色',fields:extractFields([])}];
  p.images=[{id:'i-purple',relativePath:'123/purple.png',status:'downloaded',skuIds:['purple'],qualityStatus:'original',order:1},{id:'i-blue',relativePath:'123/blue.png',status:'downloaded',skuIds:['blue'],qualityStatus:'original',order:2},{id:'i-shared',relativePath:'123/shared.png',status:'downloaded',skuIds:[],qualityStatus:'original',order:3}];
  await mkdir(path.join(dataDir,'images/123'),{recursive:true});for(const img of p.images)await writeFile(path.join(dataDir,'images',img.relativePath),PNG);
  store.saveProduct(p);
  return {dir,dataDir,outputRoot,store,skillPath,p,clean:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};
}
const waitFor=async(predicate)=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('等待状态超时');};

test('冻结素材只取当前规格原图，保留来源与技能版本，不继承汇总尺寸',async()=>{
  const f=await setup();try{
    f.p.fields=extractFields([{text:'长度: 4cm'},{text:'宽度: 3cm'}]);
    const snapshot=await freezeInput({...f,product:f.p,variant:f.p.variants[0],batchDir:path.join(f.outputRoot,'batch')});
    assert.deepEqual(snapshot.refs.map(r=>r.imageId),['i-purple']);assert.equal(snapshot.skill.sha256.length,64);
    const candidates=planCandidates(snapshot);assert.equal(candidates.length,12);assert.equal(candidates.filter(c=>c.status==='blocked').length,6);
    await writeFile(path.join(f.dataDir,'images/123/purple.png'),'changed');assert.deepEqual(await readFile(path.join(f.outputRoot,'batch/input/01.png')),PNG);
    const input=candidateInput({snapshot},candidates[3],path.join(f.outputRoot,'batch'));
    assert.ok(input.some(i=>i.type==='skill'));assert.equal(input.filter(i=>i.type==='localImage').length,1);
    assert.ok(!input.filter(i=>i.type==='localImage').some(i=>i.path.includes('blue')));
    await assert.rejects(()=>freezeInput({...f,product:{...f.p,images:[]},variant:f.p.variants[0],batchDir:path.join(f.outputRoot,'bad')}),/没有明确关联/);
    await assert.rejects(()=>freezeInput({...f,product:{...f.p,images:f.p.images.map(i=>({...i,qualityStatus:'fallback'}))},variant:f.p.variants[0],batchDir:path.join(f.outputRoot,'bad')}),/缩略图/);
  }finally{await f.clean();}
});

test('重复点击合并任务，两个规格串行执行；部分失败保留成功文件，重试仅补失败项',async()=>{
  const f=await setup();let active=0,maxActive=0;const calls=[];let firstFail=true;
  const service=new GenerationService({...f,runnerFactory:()=>({
    async open(){active++;maxActive=Math.max(maxActive,active);return 'thread-test';},
    async generate(job,c,dir){calls.push(`${job.skuId}/${c.id}`);await new Promise(r=>setTimeout(r,5));if(c.id==='overview-A'&&firstFail){firstFail=false;return {status:'failed',reason:'测试图片失败'};}const file=`results/${c.filename}.png`;await writeFile(path.join(dir,file),PNG);return {status:'completed',file,hash:'test-only',width:1,height:1,bytes:PNG.length,reason:'测试替身，并非实图验收'};},
    close(){active--;}
  })});
  try{
    const [a,b]=await Promise.all([service.create('123','purple'),service.create('123','purple')]);assert.equal(a.id,b.id);
    const blue=await service.create('123','blue');await waitFor(()=>!['queued','running'].includes(service.get(blue.id).status));
    const j=service.get(a.id);assert.equal(j.status,'partial');assert.equal(imageJobSummary(j).completed,5);assert.equal(maxActive,1);
    const before=calls.length;await service.resume(j.id,{retry:true});await waitFor(()=>!['queued','running'].includes(service.get(j.id).status));assert.equal(calls.length,before+1);assert.equal(imageJobSummary(service.get(j.id)).completed,6);
    const p=f.store.product('123');for(const key of ['length','width'])p.variants[0].fields[key]={value:3,status:'manual',sources:[]};f.store.saveProduct(p);
    await service.resume(j.id);await waitFor(()=>service.get(j.id).status==='done');assert.equal(imageJobSummary(service.get(j.id)).completed,12);assert.equal(service.get(j.id).snapshot.fields.length.status,'missing');assert.equal(service.get(j.id).confirmedUpdates.length.status,'manual');
    const next=await service.create('123','purple');assert.notEqual(next.id,j.id);await service.stop(next.id);
  }finally{await service.close();await f.clean();}
});

test('停止和服务重启保留结果，未完成候选可继续，采集任务互不干扰',async()=>{
  const f=await setup();let started=false;
  const service=new GenerationService({...f,runnerFactory:()=>({async open(){return 'thread';},async generate(job,c,dir,{signal}){started=true;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});});},close(){}})});
  try{
    const job=await service.create('123','purple');await waitFor(()=>started);await service.stop(job.id);await waitFor(()=>!service.active);assert.equal(service.get(job.id).status,'stopped');assert.equal(service.get(job.id).candidates.some(c=>c.status==='running'),false);
    const j=service.get(job.id);j.status='running';j.candidates[3].status='completed';j.candidates[4].status='running';f.store.saveImageJob(j);f.store.recover();const recovered=service.get(j.id);assert.equal(recovered.status,'paused');assert.equal(recovered.candidates[3].status,'completed');assert.equal(recovered.candidates[4].status,'pending');assert.equal(f.store.product('123').status,'done');assert.equal(f.store.jobs().length,0);
  }finally{await service.close();await f.clean();}
});

test('未实际生成、未查看的结果不能成为成品；路径穿越和符号链接不能下载',async()=>{
  const f=await setup();try{
    const runner=new CodexImageRunner({ocr:{}});runner.threadId='test';const base={messages:[JSON.stringify({status:'completed',path:'/tmp/fake.png',reviewed:false,reason:'fake'})],items:[]};runner.client={runTurn:async()=>base};
    const snapshot=await freezeInput({...f,product:f.p,variant:f.p.variants[0],batchDir:path.join(f.outputRoot,'batch')});const j={snapshot};const c=planCandidates(snapshot)[3];
    await assert.rejects(()=>runner.generate(j,c,path.join(f.outputRoot,'batch'),{onEvent:()=>{}}),/尚未经过逐张检查/);
    base.messages=[JSON.stringify({status:'completed',path:'/tmp/fake.png',reviewed:true,reason:'fake'})];await assert.rejects(()=>runner.generate(j,c,path.join(f.outputRoot,'batch'),{onEvent:()=>{}}),/未收到内置生图/);
    await writeFile(path.join(f.outputRoot,'batch/input/01.png'),'tampered');await assert.rejects(()=>runner.generate(j,c,path.join(f.outputRoot,'batch'),{onEvent:()=>{}}),/冻结的参考图片发生变化/);
    await mkdir(path.join(f.dir,'outside'));await writeFile(path.join(f.dir,'outside','private.txt'),'private');await symlink(path.join(f.dir,'outside'),path.join(f.outputRoot,'leak'),'junction');
    await assert.rejects(()=>containedFile(f.outputRoot,'../outside/private.txt'),/超出/);await assert.rejects(()=>containedFile(f.outputRoot,'leak/private.txt'),/超出/);assert.equal(imageType(PNG),'png');assert.throws(()=>imageType(Buffer.from('not an image')),/真实图片/);
  }finally{await f.clean();}
});

test('逐图调整保留旧版本，新偏好待审阅，批准后按品类场景复用且不改变冻结任务',async()=>{
  const f=await setup();const captured=[];const review=new ReviewService({store:f.store});
  const service=new GenerationService({...f,review,runnerFactory:()=>({async open(){return 'test';},async generate(job,c,dir){captured.push({job:job.id,kind:job.kind,options:job.options,profile:job.profile,preferences:c.preferences});const file=`results/${c.filename}.png`;await writeFile(path.join(dir,file),PNG);return {status:'completed',file,hash:'fixture',width:1,height:1,productBrief:'测试商品事实摘要'};},close(){}})});
  try{
    const parent=await service.create('123','purple');await waitFor(()=>!['queued','running'].includes(service.get(parent.id).status));
    const old=await service.imageFile(parent.id,'overview-A');const oldBytes=await readFile(old.file);
    const [a,b]=await Promise.all([service.adjust(parent.id,'overview-A','暖色背景，减少反光'),service.adjust(parent.id,'overview-A','暖色背景，减少反光')]);assert.equal(a.id,b.id);
    await waitFor(()=>service.get(a.id).status==='done');assert.equal(service.get(a.id).candidates.length,1);assert.deepEqual(await readFile(old.file),oldBytes);assert.equal(service.get(a.id).parentJobId,parent.id);
    assert.equal(service.preferences().length,0);assert.equal(f.store.applicableStyles('other','overview').length,0);
    const event=review.data().events[0];assert.equal(event.instruction,'暖色背景，减少反光');assert.equal(event.resultStatus,'done');assert.equal(event.reviewStatus,'pending');
    const call=captured.find(c=>c.job===a.id);assert.deepEqual(call.preferences,[]);assert.equal(call.options.autoRepair,false);assert.ok(call.profile?.brief);
    review.approve({eventIds:[event.id],instruction:event.instruction,field:'image',category:'other',scene:'overview',baseVersion:0});
    assert.equal(f.store.applicableStyles('other','overview').length,1);assert.equal(f.store.applicableStyles('other','use').length,0);
    await service.selectVersion(parent.id,'overview-A',parent.id);assert.equal(review.data().events[0].adopted,false);assert.equal(service.get(parent.id).chosenVersions['overview-A'],parent.id);await service.selectVersion(parent.id,'overview-A',a.id);assert.equal(review.data().events[0].adopted,true);
    await assert.rejects(()=>service.selectVersion(parent.id,'use-A',a.id),/不属于/);
    assert.ok(service.get(parent.id).candidates.every(c=>!c.preferences?.length));
    const rule=review.data().current.rules[0];review.toggle(rule.id,false,1);assert.equal(f.store.applicableStyles('other','overview').length,0);
    f.store.recover();review.toggle(rule.id,true,2);assert.equal(f.store.applicableStyles('other','overview').length,1);
    await assert.rejects(()=>service.adjust(parent.id,'overview-A',' '),/请填写/);
  }finally{await service.close();await f.clean();}
});

test('后续出图不重复注入Skill，风格与原始商品约束均进入指令，默认禁止自动重画',async()=>{
  const f=await setup();try{
    const snapshot=await freezeInput({...f,product:f.p,variant:f.p.variants[0],batchDir:path.join(f.outputRoot,'batch')});const c=planCandidates(snapshot)[3];c.preferences=[{id:'p',instruction:'自然窗光'}];
    const input=candidateInput({snapshot,profile:{brief:'紫色商品'},adjustment:{instruction:'增加留白',sourceFile:'input/edit.png'}},c,path.join(f.outputRoot,'batch'),{includeSkill:false});
    assert.equal(input.some(i=>i.type==='skill'),false);assert.match(input[0].text,/自然窗光/);assert.match(input[0].text,/增加留白/);assert.match(input[0].text,/最多调用生图一次/);assert.equal(input.filter(i=>i.type==='localImage').length,2);
  }finally{await f.clean();}
});

test('生图返回后先发布可读取预览，核对未结束时也不把草稿算成合格成品',async()=>{
  const f=await setup();try{
    const dir=path.join(f.outputRoot,'batch');const snapshot=await freezeInput({...f,product:f.p,variant:f.p.variants[0],batchDir:dir});await mkdir(path.join(dir,'results'),{recursive:true});
    const output=path.join(dir,'results/preview.png');await writeFile(output,Buffer.concat([PNG,Buffer.alloc(2048)]));
    const runner=new CodexImageRunner({ocr:{dimensions:async()=>({width:1024,height:1024})}});runner.threadId='t';let release,seen=false;
    runner.client={runTurn:async({onEvent})=>{onEvent({method:'item/completed',params:{turnId:'t',item:{id:'g',type:'imageGeneration',status:'completed',savedPath:output}}});await new Promise(r=>{release=r;});return {messages:[JSON.stringify({status:'failed',reviewed:false,reason:'测试：待调整',attempts:1,productBrief:'商品事实'})],items:[]};}};
    const promise=runner.generate({snapshot},planCandidates(snapshot)[3],dir,{onEvent:({preview})=>{if(preview){assert.equal(preview.review,'pending');assert.ok(preview.file.startsWith('drafts/'));seen=true;}}});
    await waitFor(()=>seen);release();const result=await promise;assert.equal(result.status,'failed');assert.equal(result.reason,'测试：待调整');
  }finally{await f.clean();}
});
