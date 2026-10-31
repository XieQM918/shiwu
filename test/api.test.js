import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {newProduct,extractFields} from '../server/domain.js';

test('本机接口验证、人工修改保存、规格汇总与跨站保护',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-api-'));
  const {app,store}=createApp({dataDir:dir,collectorFactory:()=>({busy:false,context:null})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
  const post=(url,body,method='POST',extra={})=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  try{
    let r=await post('/api/links/validate',{links:'https://detail.1688.com/offer/123.html?x=1'});assert.equal((await r.json()).valid[0].url,'https://detail.1688.com/offer/123.html');
    r=await post('/api/jobs',{links:'https://evil.test/offer/123.html'});assert.equal(r.status,400);
    const p=newProduct({id:'123',url:'https://detail.1688.com/offer/123.html'});p.status='done';p.records=[{text:'材质: 合金'}];p.fields=extractFields(p.records);p.variants=[{id:'sku1',label:'小号',fields:extractFields([{text:'长度: 2cm'}])},{id:'sku2',label:'大号',fields:extractFields([{text:'长度: 3cm'}])}];store.saveProduct(p);
    r=await post('/api/products/123/fields',{key:'length',skuId:'sku1',value:2.5},'PATCH');assert.equal(r.status,200);assert.equal(store.product('123').variants[0].fields.length.value,2.5);assert.equal(store.product('123').fields.length.status,'variants');
    r=await post('/api/products/123/fields',{key:'length',value:-1},'PATCH');assert.equal(r.status,400);
    r=await post('/api/products/123/fields',{key:'material',value:'铜'},'PATCH');assert.equal(r.status,200);assert.equal(store.product('123').fields.material.status,'manual');
    r=await post('/api/products/123/fields',{key:'material',reset:true},'PATCH');assert.equal(r.status,200);assert.equal(store.product('123').fields.material.value,'合金');
    r=await post('/api/links/validate',{links:''},'POST',{Origin:'https://evil.test'});assert.equal(r.status,403);
    r=await fetch(base+'/api/export/excel?ids=123');assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>5000);
    r=await fetch(base+'/api/images/123/missing');assert.equal(r.status,404);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});}
});
