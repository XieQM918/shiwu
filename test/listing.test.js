import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import {Store} from '../server/db.js';
import {ReviewService} from '../server/review.js';
import {ListingService,listingFacts,validateListing,CodexListingRunner} from '../server/listing.js';
import {newProduct,extractFields} from '../server/domain.js';
import {workbookBuffer} from '../server/exports.js';
import {createApp} from '../server/index.js';
const until=async fn=>{for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('文案测试等待超时');};
export const copy=()=>({title:'Matte Curved Earrings, Stud or Clip-On Options',description:'A softly curved design for everyday styling. Choose a pierced stud or a clip-on option. Copper body. Listed length: 1.3 cm.',tags:['curved earrings','matte earrings','clip on earrings','stud earrings','copper earrings','modern earrings','minimal earrings','sculptural earrings','everyday earrings','small earrings','silver tone','gold tone','ear accessories'],notesZh:['耳针与耳夹分别说明；包装与物流资料未确认。'],evidence:[{claim:'Copper body',factIds:['product.material']},{claim:'Length',factIds:['product.length']}],ruleSuggestion:''});
async function setup(runnerFactory){const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-copy-'));const dataDir=path.join(dir,'data'),outputRoot=path.join(dir,'output');const store=new Store(dataDir),review=new ReviewService({store});
  const p=newProduct({id:'123',url:'https://detail.1688.com/offer/123.html'});p.title='弧形耳针耳夹';p.status='partial';p.fields=extractFields([{text:'长度: 1.3cm'},{text:'材质: 铜'}]);p.variants=[{id:'stud',label:'哑光银色耳针',fields:p.fields},{id:'clip',label:'哑光金色耳夹',fields:p.fields}];p.images=[{id:'one',status:'downloaded',relativePath:'123/one.jpg',qualityStatus:'original',skuIds:['stud'],categories:['sku'],hash:'image-one',order:1}];await mkdir(path.join(dataDir,'images/123'),{recursive:true});await writeFile(path.join(dataDir,'images/123/one.jpg'),'frozen image fixture');store.saveProduct(p);
  const service=new ListingService({store,review,dataDir,outputRoot,runnerFactory:runnerFactory||(()=>({async generate(){return copy();},close(){}}))});
  return {dir,dataDir,outputRoot,store,review,service,p,async cleanup(){await service.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('仅用确认参数，商品/包装分开，耳针耳夹语义分开，标签/标题/事实边界校验',()=>{
  const p=newProduct({id:'1',url:'x'});p.title='耳饰';p.fields=extractFields([{text:'长度: 1.3cm'},{text:'包装重量: 100g'},{text:'材质: 铜'}]);p.fields.weight={value:10,status:'review',candidates:[{value:10},{value:15}]};p.variants=[{id:'a',label:'耳针',fields:p.fields},{id:'b',label:'耳夹',fields:p.fields}];
  const snap=listingFacts(p);assert.ok(!snap.facts.some(f=>f.key.startsWith('package')));assert.ok(!snap.facts.some(f=>f.key==='weight'));assert.deepEqual(snap.variants.map(v=>v.wearing),['pierced','non-pierced']);assert.ok(snap.uncertainties.some(f=>f.key==='weight'));
  const valid=validateListing(copy(),snap);assert.equal(valid.tags.length,13);
  assert.throws(()=>validateListing({...copy(),title:'x'.repeat(141)},snap),/140/);assert.throws(()=>validateListing({...copy(),tags:['a'.repeat(21)]},snap),/20/);assert.throws(()=>validateListing({...copy(),tags:['Clip On','clip on']},snap),/重复/);assert.throws(()=>validateListing({...copy(),title:'No Piercing Earrings'},snap),/一概/);
  assert.throws(()=>validateListing({...copy(),description:'Hypoallergenic freshwater pearl earrings'},snap),/承诺/);assert.throws(()=>validateListing({...copy(),description:'Freshwater pearl earrings'},snap),/珍珠/);assert.throws(()=>validateListing({...copy(),description:'Length: 99 cm'},snap),/尺寸/);assert.throws(()=>validateListing({...copy(),description:'Size: 99 × 1.3 cm'},snap),/尺寸/);assert.throws(()=>validateListing({...copy(),description:'Weight: 1.3 g'},snap),/重量/);assert.throws(()=>validateListing({...copy(),evidence:[{claim:'x',factIds:['sku.missing.weight']}]},snap),/依据/);
});
test('重复任务合并、采集变更保留人工文案、冻结原图、Excel采用字段版本一致',async()=>{
  const f=await setup(()=>({async generate(){await new Promise(r=>setTimeout(r,20));return copy();},close(){}}));try{
    const [a,b]=await Promise.all([f.service.create('123'),f.service.create('123')]);assert.equal(a.id,b.id);await until(()=>f.service.get(a.id).status==='done');
    assert.equal(f.service.versions('123').length,1);assert.equal(f.service.current('123').content.title,copy().title);assert.equal((await f.service.create('123')).id,a.id);
    const snapshot=f.service.get(a.id).snapshot;await writeFile(path.join(f.dataDir,'images/123/one.jpg'),'new image');assert.equal(await readFile(path.join(f.outputRoot,'123',a.id,snapshot.refs[0].path),'utf8'),'frozen image fixture');
    const manual=f.service.saveManual('123','title','My Curved Earrings');assert.equal(f.service.current('123').fields.title,manual.id);assert.equal(f.review.data().events[0].reviewStatus,'pending');
    const p=f.store.product('123');p.collectedAt=new Date().toISOString();f.store.saveProduct(p);const recrawl=await f.service.create('123',{automatic:true});assert.notEqual(recrawl.id,a.id);await until(()=>f.service.get(recrawl.id).status==='done');assert.equal(f.service.current('123').content.title,'My Curved Earrings');
    const w=new ExcelJS.Workbook();await w.xlsx.load(await workbookBuffer([p],[{productId:p.id,...f.service.current(p.id)}]));assert.deepEqual(w.worksheets.map(s=>s.name),['商品汇总','规格明细','Etsy 上架文案']);const row=w.worksheets[2].getRow(2);assert.equal(row.getCell(2).value,'My Curved Earrings');assert.equal(row.getCell(4).value,copy().tags.join(', '));assert.equal(row.getCell(6).value,manual.id);
  }finally{await f.cleanup();}
});
test('提示词只调整所选字段，旧版本保留，采用与长期规则批准独立，规则只影响新任务',async()=>{
  const seen=[];const f=await setup(()=>({async generate(job){seen.push(structuredClone(job));return {...copy(),...(job.target?{title:'Updated Curved Earrings',description:'Model tried to replace unrelated body',tags:['unrelated'],ruleSuggestion:'标题避免堆词，清楚说明佩戴选项。'}:{})};},close(){}}));try{
    const original=await f.service.create('123');await until(()=>f.service.get(original.id).status==='done');const before=f.service.current('123');
    const [a,b]=await Promise.all([f.service.adjust('123','title','标题简短自然一些'),f.service.adjust('123','title','标题简短自然一些')]);assert.equal(a.id,b.id);await until(()=>f.service.get(a.id).status==='done');const changed=f.store.entry('listing_versions',f.service.get(a.id).versionId);
    assert.equal(changed.content.description,before.content.description);assert.deepEqual(changed.content.tags,before.content.tags);assert.equal(f.service.current('123').content.title,before.content.title);
    const event=f.review.data().events[0];assert.equal(event.reviewStatus,'pending');assert.equal(f.store.activeRules('ear-clip','title').length,0);assert.equal(f.review.data().current.version,0);
    f.service.adopt('123',changed.id,['title']);assert.equal(f.service.current('123').content.title,'Updated Curved Earrings');assert.equal(f.review.data().events[0].adopted,true);assert.equal(f.store.activeRules('ear-clip','title').length,0);
    f.review.approve({eventIds:[event.id],instruction:event.proposal.instruction,field:'title',category:'ear-clip',baseVersion:0});assert.equal(f.store.activeRules('ear-clip','title').length,1);assert.equal(f.store.activeRules('brooch','title').length,0);
    assert.deepEqual(f.service.get(original.id).snapshot.rules,[]);const newer=await f.service.create('123',{force:true});await until(()=>f.service.get(newer.id).status==='done');assert.equal(seen.find(j=>j.id===newer.id).snapshot.rulesVersion,1);assert.equal(seen.find(j=>j.id===newer.id).snapshot.rules.length,1);
    assert.throws(()=>f.service.adopt('123',changed.id,['description']),/实际修改/);
  }finally{await f.cleanup();}
});
test('规则合并/替换/拒绝/停用/回退持久化，过期审阅不能覆盖并发变更，未成功不能批准',async()=>{
  const f=await setup();try{
    const make=(instruction,resultStatus='done')=>f.review.record({productId:'123',field:'title',category:'ear-clip',scene:'*',instruction,resultStatus});const a=make('标题自然'),b=make('精简标题');
    const v1=f.review.approve({eventIds:[a.id,b.id],instruction:'标题自然简短',field:'title',category:'ear-clip',baseVersion:0});assert.equal(v1.rules.length,1);assert.equal(f.review.data().events.filter(e=>e.reviewStatus==='approved').length,2);
    const c=make('突出形态');assert.throws(()=>f.review.approve({eventIds:[c.id],instruction:'突出形态',field:'title',category:'ear-clip',baseVersion:0}),/已变化/);assert.equal(f.store.entry('feedback_events',c.id).reviewStatus,'pending');
    const v2=f.review.approve({eventIds:[c.id],instruction:'标题突出造型且保持简短',field:'title',category:'ear-clip',replaceIds:[v1.rules[0].id],baseVersion:1});assert.equal(v2.rules.filter(r=>r.enabled).length,1);assert.equal(v2.rules[0].replacedBy,v2.rules[1].id);
    f.review.toggle(v2.rules[1].id,false,2);assert.equal(f.store.activeRules('ear-clip','title').length,0);f.review.rollback(v1.id,3);assert.equal(f.store.activeRules('ear-clip','title')[0].instruction,'标题自然简短');assert.equal(f.review.data().current.version,4);
    const failed=make('失败记录','failed');assert.throws(()=>f.review.approve({eventIds:[failed.id],instruction:'自然标题',field:'title',category:'ear-clip',baseVersion:4}),/成功结果/);f.review.reject([failed.id]);assert.equal(f.store.entry('feedback_events',failed.id).reviewStatus,'rejected');
    const facts=make('尺寸改为4cm');assert.throws(()=>f.review.approve({eventIds:[facts.id],instruction:facts.instruction,field:'title',category:'ear-clip',baseVersion:4}),/商品事实/);
    assert.equal(f.store.entries('listing_references').length,5);assert.equal(f.store.entry('listing_references','4592883696').status,'blocked');assert.ok(f.store.entries('listing_references').every(r=>r.privateTagsAvailable===false));
  }finally{await f.cleanup();}
});
test('停止/重启恢复及部分生成失败保留已采用文案；失败可仅重试当前文案任务',async()=>{
  let blocking=false;const f=await setup(()=>({async generate(job,dir,{signal}){if(!blocking)return copy();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));},close(){}}));try{
    const a=await f.service.create('123');await until(()=>f.service.get(a.id).status==='done');const current=f.service.current('123');blocking=true;
    const b=await f.service.create('123',{force:true});await until(()=>f.service.get(b.id).status==='running');await f.service.stop(b.id);assert.equal(f.service.get(b.id).status,'stopped');assert.deepEqual(f.service.current('123'),current);
    let job=f.service.get(b.id);job.status='running';f.store.saveEntry('listing_jobs',job);f.store.recover();assert.equal(f.service.get(b.id).status,'paused');assert.deepEqual(f.service.current('123'),current);
    blocking=false;await f.service.resume(b.id);await until(()=>f.service.get(b.id).status==='done');assert.equal(f.service.versions('123').length,2);
    f.service.runnerFactory=()=>({async generate(){return {...copy(),tags:['a'.repeat(21)]};},close(){}});const c=await f.service.create('123',{force:true});await until(()=>f.service.get(c.id).status==='failed');assert.match(f.service.get(c.id).message,/20/);assert.deepEqual(f.service.current('123'),current);
    f.service.runnerFactory=()=>({async generate(){return copy();},close(){}});await f.service.resume(c.id);await until(()=>f.service.get(c.id).status==='done');assert.equal(f.service.versions('123').length,3);
  }finally{await f.cleanup();}
});
test('采集完成自动进入独立文案队列，批量补生成/修改/采用/审阅接口完整且隔离跨站',async()=>{
  const f=await setup();const {app,collector,listing}=createApp({store:f.store,dataDir:f.dataDir,listingOutputRoot:f.outputRoot,collectorFactory:()=>({busy:false}),listingFactory:options=>new ListingService({...options,runnerFactory:()=>({async generate(job){return {...copy(),...(job.target?{title:'Short Curved Earrings',ruleSuggestion:'标题更简短'}:{})};},close(){}})})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url,body,method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    await collector.onCollected(f.p);await until(()=>listing.summaries()[0]?.status==='done');let r=await request('/api/listings/generate',{ids:['123','missing']});let j=await r.json();assert.ok(j.results[1].error);assert.equal(f.store.entries('listing_jobs').length,1);
    r=await request('/api/products/123/listing/adjust',{field:'title',instruction:'标题更短'});j=await r.json();await until(()=>listing.get(j.id).status==='done');const job=listing.get(j.id);
    r=await request('/api/products/123/listing/adopt',{versionId:job.versionId,fields:['title']});assert.equal(r.status,200);
    const e=f.review.data().events[0];r=await request('/api/review/approve',{eventIds:[e.id],instruction:'标题简洁自然',field:'title',category:'ear-clip',baseVersion:0});assert.equal(r.status,200);
    const state=await (await fetch(base+'/api/state')).json();assert.equal(state.pendingReviews,0);assert.equal(state.listingJobs.length,2);assert.equal(state.products[0].listing.status,'done');
    r=await fetch(base+'/api/review',{headers:{Origin:'https://other.test'}});assert.equal(r.status,403);
  }finally{await listing.close();await new Promise(resolve=>server.close(resolve));await f.cleanup();}
});
test('Codex文案运行器使用独立线程、结构化输出及冻结原图，不调用生图',async()=>{
  const f=await setup();try{const j=await f.service.create('123');await until(()=>f.service.get(j.id).status==='done');const job=f.service.get(j.id);let turn,thread;
    const runner=new CodexListingRunner({clientFactory:()=>({async connect(){},async request(){return {data:[{id:'test-account-model',isDefault:true}]};},async startThread(options){thread=options;return 'text-thread';},async runTurn(options){turn=options;return {messages:[JSON.stringify(copy())]};},close(){}})});
    const result=await runner.generate(job,path.join(f.outputRoot,'123',job.id),{onEvent:()=>{}});assert.equal(result.title,copy().title);assert.match(thread.developerInstructions,/不得运行命令/);assert.equal(turn.threadId,'text-thread');assert.equal(turn.outputSchema.properties.title.type,'string');assert.equal(turn.input.filter(i=>i.type==='localImage').length,1);assert.match(turn.input[0].text,/已确认/);runner.close();
  }finally{await f.cleanup();}
});

test('文案校验仅一次文字修正，失败不反复调用，暂停时不发布半完成版本',async()=>{
  let fixes=0;const f=await setup(()=>({async generate(){return {...copy(),title:'No Piercing Earrings'};},async correct(job,answer,issue){fixes++;assert.match(issue,/耳针/);return copy();},close(){}}));try{
    const j=await f.service.create('123');await until(()=>f.service.get(j.id).status==='done');assert.equal(fixes,1);assert.match(f.service.get(j.id).correctionReason,/耳针/);
    f.service.runnerFactory=()=>({async generate(){return {...copy(),tags:['x'.repeat(21)]};},async correct(){fixes++;return {...copy(),tags:['x'.repeat(21)]};},close(){}});const bad=await f.service.create('123',{force:true});await until(()=>f.service.get(bad.id).status==='failed');assert.equal(fixes,2);assert.equal(f.service.versions('123').length,1);
  }finally{await f.cleanup();}
});

test('继续修改从当前展示的候选版本出发，而不是悄悄使用已采用旧版',async()=>{
  const observed=[];let n=0;const f=await setup(()=>({async generate(job){observed.push(structuredClone(job.baseContent));return {...copy(),title:job.target?`Candidate ${++n} Earrings`:copy().title,ruleSuggestion:job.target?'标题简洁自然':''};},close(){}}));try{
    const a=await f.service.create('123');await until(()=>f.service.get(a.id).status==='done');const adopted=f.service.current('123');
    const b=await f.service.adjust('123','title','标题自然些');await until(()=>f.service.get(b.id).status==='done');const candidate=f.service.get(b.id).versionId;
    const c=await f.service.adjust('123','title','继续精简这版',candidate);await until(()=>f.service.get(c.id).status==='done');assert.equal(observed[2].title,'Candidate 1 Earrings');assert.equal(f.service.current('123').content.title,adopted.content.title);
    const events=f.review.data().events;assert.equal(events.find(e=>e.resultJobId===c.id).before.value,'Candidate 1 Earrings');assert.equal(events.find(e=>e.resultJobId===c.id).before.versionId,candidate);
    f.service.saveManual('123','title','My Selected Candidate',candidate);assert.equal(f.review.data().events.find(e=>e.resultStatus==='manual').before.value,'Candidate 1 Earrings');
    await assert.rejects(()=>f.service.adjust('123','description','按这版修改',candidate),/有效文案版本/);
  }finally{await f.cleanup();}
});
