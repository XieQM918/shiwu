import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexClient,quotaWindows} from '../server/codex-client.js';

test('用量仅保存计数与窗口，不存身份凭据；去重工具事件，缓存不重复相加',async()=>{
  const client=new CodexClient();let sequence=0;
  client.request=async method=>{
    if(method==='account/rateLimits/read')return {rateLimits:{limitId:'codex',primary:{usedPercent:10,windowDurationMins:300,resetsAt:1000},credits:{secret:'never-store'}},identity:'never-store'};
    if(method==='turn/start'){const n=++sequence;queueMicrotask(()=>{
      const emit=(method,extra)=>client.emit('notification',{method,params:{threadId:'t',...extra}});
      const item={id:'g'+n,type:'imageGeneration'};emit('item/started',{item});emit('item/completed',{item:{...item,status:'completed'}});
      emit('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:100*n,cachedInputTokens:80*n,outputTokens:10*n,reasoningOutputTokens:2*n,totalTokens:110*n}}});
      emit('turn/completed',{turn:{id:'turn'+n,status:'completed'}});
    });return {turn:{id:'turn'+n}};}
  };
  const a=await client.runTurn({threadId:'t',input:[],collectUsage:true});const b=await client.runTurn({threadId:'t',input:[],collectUsage:true});
  for(const r of [a,b]){assert.equal(r.usage.inputTokens,100);assert.equal(r.usage.cachedInputTokens,80);assert.equal(r.usage.totalTokens,110);assert.equal(r.usage.imageCalls,1);assert.equal(r.usage.tokensKnown,true);assert.ok(!JSON.stringify(r.usage).includes('never-store'));}
  assert.deepEqual(quotaWindows(null),null);client.close();
});

test('中断或失败仍返回已产生用量，未返回统计不伪装为零消耗',async()=>{
  const client=new CodexClient();client.request=async method=>{
    if(method==='account/rateLimits/read')throw new Error('不支持');
    if(method==='turn/start'){queueMicrotask(()=>{
      client.emit('notification',{method:'item/started',params:{threadId:'t',item:{id:'image',type:'imageGeneration'}}});
      client.emit('notification',{method:'turn/completed',params:{threadId:'t',turn:{id:'failed',status:'failed',error:{message:'quota limit'}}}});
    });return {turn:{id:'failed'}};}
  };
  await assert.rejects(()=>client.runTurn({threadId:'t',input:[],collectUsage:true}),e=>e.usage.imageCalls===1&&e.usage.tokensKnown===false);client.close();
});

test('指定模型时必须核对App Server实际回显，不把默认模型当成Luna',async()=>{
 const client=new CodexClient();client.request=async()=>({thread:{id:'fixture'},model:'gpt-5.6-sol'});
 await assert.rejects(()=>client.startThread({model:'gpt-6.1-sol',expectedModel:'gpt-6.1-sol'}),/未确认指定模型/);
 client.request=async()=>({thread:{id:'fixture'},model:'gpt-6.1-sol'});assert.equal(await client.startThread({model:'gpt-6.1-sol',expectedModel:'gpt-6.1-sol'}),'fixture');assert.equal(client.lastThreadModel,'gpt-6.1-sol');client.close();
});
