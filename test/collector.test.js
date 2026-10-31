import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Collector} from '../server/collector.js';
import {Store} from '../server/db.js';
import {emptyFields,newProduct} from '../server/domain.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await delay(30);}throw new Error('任务状态超时');}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO/kAAAAASUVORK5CYII=','base64');
function snapshot(id){return {title:`商品${id}`,supplier:'测试供应商',images:[{url:'https://cbu01.alicdn.com/main.png',categories:['main'],skuIds:[],order:1},{url:'https://cbu01.alicdn.com/detail.png',categories:['detail'],skuIds:[],order:2}],records:[{text:'长度: 2cm',kind:'page'},{text:'材质: 铜',kind:'page'}],warnings:[],variants:[],variantMode:'none'};}
test('真实队列逻辑：验证时暂停、继续到下一商品、失败独立记录、图片内容去重与人工值保留',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-collector-'));const store=new Store(dir);
  const collector=new Collector({store,dataDir:dir,ocr:{recognize:async()=>({width:1,height:1,lines:[]})}});
  collector.context={request:{get:async()=>({ok:()=>true,headers:()=>({'content-type':'image/png'}),body:async()=>png})}};
  let gate=true;collector.readPage=async p=>{if(gate)return {verification:true};if(p.id==='2')throw new Error('商品已失效');return snapshot(p.id);};
  try{
    const job=collector.create([{id:'1',url:'https://detail.1688.com/offer/1.html'},{id:'2',url:'https://detail.1688.com/offer/2.html'}]);await until(()=>store.job(job.id).status==='waiting'&&!collector.busy);
    assert.equal(store.job(job.id).index,0);assert.equal(store.product('1').status,'waiting');assert.equal(store.product('1').images.length,0);
    const p=store.product('1');p.fields.length={...emptyFields().length,value:2.8,status:'manual'};store.saveProduct(p);gate=false;
    collector.resume(job.id);await until(()=>store.job(job.id).status==='done');
    const saved=store.product('1');assert.equal(saved.images.length,1);assert.deepEqual(saved.images[0].categories,['main','detail']);assert.equal(saved.fields.length.value,2.8);assert.equal(saved.fields.length.status,'manual');assert.equal(store.product('2').status,'failed');assert.equal(store.job(job.id).index,2);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('停止任务保留已下载图片，后续商品不继续采集',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-stop-'));const store=new Store(dir);let requests=0;
  const collector=new Collector({store,dataDir:dir,ocr:{recognize:async()=>({lines:[]})}});
  collector.context={request:{get:async()=>{requests++;if(requests===2)await delay(180);return{ok:()=>true,headers:()=>({'content-type':'image/png'}),body:async()=>png};}}};collector.readPage=async p=>snapshot(p.id);
  try{
    const job=collector.create([{id:'1',url:'https://detail.1688.com/offer/1.html'},{id:'2',url:'https://detail.1688.com/offer/2.html'}]);await until(()=>store.product('1')?.images.length===1&&requests===2);collector.stop(job.id);await until(()=>!collector.busy);
    assert.equal(store.job(job.id).status,'stopped');assert.equal(store.product('1').images[0].status,'downloaded');assert.equal(store.product('2').status,'stopped');assert.equal(requests,2);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('升级原图不复用旧缩略图缓存或OCR，旧图片来源仍能关联；降级文件明确标记',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-hd-'));const store=new Store(dir);const calls=[];
  const collector=new Collector({store,dataDir:dir,ocr:{dimensions:async()=>({width:1200,height:1200})}});
  const original='https://cbu01.alicdn.com/img/photo.jpg',thumb=original+'_b.jpg';
  const product=newProduct({id:'1',url:'https://detail.1688.com/offer/1.html'});product.images=[{id:'old-thumb',url:thumb,status:'downloaded',relativePath:'1/old.jpg',width:220,height:220,ocr:{lines:[{text:'旧缩略图文字'}]},categories:['main'],skuIds:[]}];store.saveProduct(product);
  let missingOriginal=false;
  collector.context={request:{get:async url=>{calls.push(url);return{ok:()=>!missingOriginal||url!==original,status:()=>404,headers:()=>({'content-type':'image/jpeg'}),body:async()=>png};}}};
  try{
    let images=await collector.download(product,{images:[{url:thumb,categories:['main'],skuIds:[],order:1}]});assert.deepEqual(calls,[original]);assert.equal(images[0].width,1200);assert.equal(images[0].qualityStatus,'original');assert.equal(images[0].resolutionVerified,true);assert.equal(images[0].ocr,undefined);assert.ok(images[0].legacyIds.includes('old-thumb'));
    calls.length=0;missingOriginal=true;images=await collector.download(product,{images:[{url:thumb,categories:['main'],skuIds:[],order:1}]});assert.equal(images[0].qualityStatus,'fallback');assert.equal(images[0].resolvedUrl,thumb);assert.ok(calls.includes(thumb));
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
