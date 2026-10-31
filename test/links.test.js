import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkResolver} from '../server/link-resolver.js';
import {parseLinks} from '../server/domain.js';
import {createApp} from '../server/index.js';

const SHORT='https://qr.1688.com/s/DuWdsAyw';
const TARGET='https://detail.1688.com/offer/730468849400.html';
// Actual short-link response shape, without private share/tracking tokens.
const BODY='wireless1688://ma.m.1688.com/plugin?url='+encodeURIComponent('https://m.1688.com/offer/730468849400.html?offerId=730468849400&tracking=fixture');

test('1688真实分享响应：解析APP协议内嵌手机地址，与标准及手机链接按编号去重',async()=>{
  let calls=0;const resolve=createLinkResolver({fetchImpl:async url=>{calls++;assert.equal(url,SHORT);return new Response(BODY);}});
  const result=await resolve(`${SHORT}\n${TARGET}?extra=1\nhttps://m.1688.com/offer/730468849400.html\n【1688】商品 ${SHORT} 点击直接打开`);
  assert.deepEqual(result.valid,[{id:'730468849400',url:TARGET}]);assert.equal(result.invalid.length,0);assert.equal(result.duplicates,3);assert.equal(calls,1);
  await resolve(SHORT);assert.equal(calls,1);assert.equal(result.resolved[0].url,TARGET);
  assert.equal(parseLinks('https://m.1688.com/offer/730468849400.html').valid[0].url,TARGET);
});
test('支持安全HTTP跳转、脚本跳转及刷新标签，不访问目标详情页或执行页面脚本',async()=>{
  for(const response of [new Response(null,{status:302,headers:{Location:'https://m.1688.com/offer/730468849400.html?share=1'}}),new Response(`<script>location.href = '${TARGET}';</script>`),new Response(`<meta http-equiv="refresh" content="0;url=${TARGET}">`),new Response(JSON.stringify({url:TARGET}))]){
    let calls=0;const resolve=createLinkResolver({fetchImpl:async()=>{calls++;return response;}});assert.equal((await resolve(SHORT)).valid[0].url,TARGET);assert.equal(calls,1);
  }
});
test('拒绝伪造域名、外部跳转、循环及无明确目标的页面，错误不缓存',async()=>{
  let calls=0;let fail=true;
  const resolve=createLinkResolver({fetchImpl:async()=>{calls++;if(fail)return new Response(null,{status:302,headers:{Location:'http://127.0.0.1:3210/api/state'}});return new Response(BODY);}});
  const invalid=await resolve('https://qr.1688.com.evil.test/s/DuWdsAyw\nhttps://qr.1688.com:99/s/DuWdsAyw\nfile:///etc/passwd');assert.equal(invalid.invalid.length,3);assert.equal(calls,0);
  let r=await resolve(SHORT);assert.equal(r.valid.length,0);assert.match(r.errors[0].message,/没有指向/);assert.equal(calls,1);
  fail=false;r=await resolve(SHORT);assert.equal(r.valid.length,1);assert.equal(calls,2);
  const cycle=createLinkResolver({fetchImpl:async()=>new Response(null,{status:302,headers:{Location:SHORT}})});assert.match((await cycle(SHORT)).errors[0].message,/循环/);
  const recommendation=createLinkResolver({fetchImpl:async()=>new Response(`<html>请完成验证<a href="${TARGET}">推荐商品</a></html>`)});assert.equal((await recommendation(SHORT)).valid.length,0);
  const large=createLinkResolver({fetchImpl:async()=>new Response('x'.repeat(300000))});assert.match((await large(SHORT)).errors[0].message,/内容异常/);
});
test('解析超时可理解地提示，标准链接不发网络请求，31个商品保留批量上限',async()=>{
  const resolve=createLinkResolver({timeoutMs:20,fetchImpl:async(url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const r=await resolve(SHORT);assert.match(r.errors[0].message,/超时/);
  const many=await resolve(Array.from({length:31},(_,i)=>`https://detail.1688.com/offer/${1000+i}.html`).join('\n'));assert.equal(many.tooMany,true);
});
test('校验与创建采集任务共用解析结果，短链可创建任务，缓存避免重复请求',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-links-'));let received,calls=0;
  const resolver=createLinkResolver({fetchImpl:async()=>{calls++;return new Response(BODY);}});
  const {app,store,generation}=createApp({dataDir:dir,linkResolver:resolver,collectorFactory:()=>({busy:false,context:null,create(links){received=links;return {id:'fixture-job'};}})});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const post=url=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({links:SHORT})});
    let r=await post('/api/links/validate');assert.equal((await r.json()).valid[0].url,TARGET);
    r=await post('/api/jobs');assert.equal(r.status,201);assert.deepEqual(received,[{id:'730468849400',url:TARGET}]);assert.equal(calls,1);
  }finally{await generation.close();await new Promise(resolve=>server.close(resolve));store.close();await rm(dir,{recursive:true,force:true});}
});
