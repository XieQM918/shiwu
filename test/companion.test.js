import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {once} from 'node:events';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {createApp} from '../server/index.js';
import {ChatGPTCompanion,CompanionImageRunner,readRegisteredDownload} from '../server/chatgpt-companion.js';
import {hashBuffer} from '../server/generation-input.js';
import {nativeInput} from '../browser-extension/native-input.js';

test('网页生图入口已停用且不再提供连接码，默认生图配置为Codex GPT-6.1 Sol',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiwu-disabled-web-'));
  const {app,store,generation,listing}=createApp({dataDir:dir,collectorFactory:()=>({busy:false})});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try{
    for(const endpoint of ['/api/chatgpt/companion/setup','/api/chatgpt/companion/extension.zip','/api/chatgpt/browser/status','/api/chatgpt/companion/bridge/task']){
      const r=await fetch(base+endpoint);assert.equal(r.status,410);const j=await r.json();assert.match(j.error,/停用/);assert.equal(j.code,undefined);
    }
    const config=await fetch(base+'/api/generation/config').then(r=>r.json());assert.equal(config.provider,'codex');assert.equal(config.requestedModel,'gpt-6.1-sol');assert.equal(config.reasoningEffort,'medium');assert.equal(config.executionPolicy.maxAdditionalWaits,1);
  }finally{await generation.close();await listing.close();await new Promise(r=>server.close(r));store.close();await rm(dir,{recursive:true,force:true});}
});

test('原生交互只附加本次ChatGPT标签页，不访问登录页、其他标签页或任意协议命令',async()=>{
  const calls=[];let url='https://accounts.google.com/',enabled=true;
  const c={tabs:{get:async()=>({url,width:1000,height:800})},runtime:{getPlatformInfo:async()=>({os:'win'})},debugger:{attach:async t=>calls.push(['attach',t]),detach:async t=>calls.push(['detach',t]),sendCommand:async(t,m,p)=>{calls.push([m,t,p]);if(m==='DOM.getDocument')return {root:{nodeId:1}};if(m==='DOM.querySelector')return {nodeId:2};}}};
  const task={marker:'SHIWU-test',prompt:'SHIWU-test 冻结提示词',files:[{nativePath:'/fixture/frozen-original.png'}]};
  const native=nativeInput(c,async tab=>enabled&&tab===42?task:null);
  await assert.rejects(()=>native.click(42,{x:10,y:10}),/本次ChatGPT/);assert.equal(calls.length,0);
  url='https://chatgpt.com/';await assert.rejects(()=>native.click(43,{x:10,y:10}),/本次ChatGPT/);assert.equal(calls.length,0);
  await native.type(42,{x:20,y:30});await native.upload(42);await native.detach(42);
  assert.deepEqual(calls.find(x=>x[0]==='Input.insertText')[2],{text:task.prompt});
  assert.deepEqual(calls.find(x=>x[0]==='DOM.setFileInputFiles')[2].files,[task.files[0].nativePath]);
  assert.ok(calls.every(x=>['attach','detach'].includes(x[0])||/^Input\.|^DOM\.(getDocument|querySelector|setFileInputFiles)$/.test(x[0])));
  enabled=false;await assert.rejects(()=>native.click(42,{x:20,y:30}),/本次ChatGPT/);
});

test('成品导入仅允许本次登记的Downloads目录，拒绝其他文件和越界软链接',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiwu-bridge-files-')),root=path.join(dir,'Downloads');
  try{
    await mkdir(path.join(root,'shiwu-results/task-1'),{recursive:true});const file=path.join(root,'shiwu-results/task-1/image.png');await writeFile(file,'registered');
    assert.equal((await readRegisteredDownload(file,root,'task-1')).toString(),'registered');
    await assert.rejects(()=>readRegisteredDownload(file,root,'task-2'),/本次任务/);
    const outside=path.join(dir,'private.png');await writeFile(outside,'private');await assert.rejects(()=>readRegisteredDownload(outside,root,'task-1'),/本次任务/);
    if(process.platform!=='win32'){const link=path.join(root,'shiwu-results/task-1/link.png');await symlink(outside,link);await assert.rejects(()=>readRegisteredDownload(link,root,'task-1'),/本次任务/);}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('原图与风格冻结，浏览器发送前登记，拒绝重复发送，成品落地并可离线恢复',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiwu-bridge-job-'));const downloads=path.join(dir,'Downloads'),batch=path.join(dir,'batch');
  const bridge=new ChatGPTCompanion({dataDir:path.join(dir,'data'),downloadsRoot:downloads});await bridge.secret;
  bridge.client={id:'fixture-client',seenAt:Date.now(),nativeInput:true};const runner=new CompanionImageRunner({browser:bridge});
  try{
    for(const folder of ['input','skill/references','results'])await mkdir(path.join(batch,folder),{recursive:true});
    const original=await sharp({create:{width:1024,height:1024,channels:3,background:'#ffddee'}}).jpeg().toBuffer();await writeFile(path.join(batch,'input/purple.jpg'),original);
    const skill='## 3. 真实感\n自然皮肤，真实金属。\n## 4. 调用',guide='## 配色、光线与质感\n方向性柔光。\n## 本地参考图索引';
    await writeFile(path.join(batch,'skill/SKILL.md'),skill);await writeFile(path.join(batch,'skill/references/scene-guide.md'),guide);
    const job={id:'fixture',requestedModel:'gpt-5.6-sol',snapshot:{title:'耳夹',skuLabel:'紫色',fields:{},refs:[{path:'input/purple.jpg',hash:hashBuffer(original)}],styleRefs:[],skill:{path:'skill/SKILL.md',sha256:hashBuffer(Buffer.from(skill)),guideSha256:hashBuffer(Buffer.from(guide))}}};
    const c={id:'overview-A',scene:'overview',filename:'02-overview-A'};
    const result=runner.generate(job,c,batch,{onEvent:()=>{}});
    for(let n=0;!bridge.pending;n++){if(n>100)throw new Error('任务未登记');await new Promise(r=>setTimeout(r,10));}
    const task=bridge.pending,payload=task.payload;assert.equal(payload.requestedModel,'gpt-5.6-sol');assert.equal(hashBuffer(await readFile(payload.files[0].nativePath)),hashBuffer(original));assert.match(payload.prompt,/方向性柔光/);
    await task.event({type:'submitting',observedModel:'GPT-5.6 Sol'});assert.equal(c.web.phase,'submitting');
    await assert.rejects(()=>task.event({type:'submitting',observedModel:'GPT-5.6 Sol'}),/重复提交/);
    await task.event({type:'submitted',conversationUrl:'https://chatgpt.com/c/fixture-result'});
    await mkdir(path.join(downloads,'shiwu-results',payload.id),{recursive:true});const generated=await sharp({create:{width:1024,height:1024,channels:3,background:'#aabbcc'}}).jpeg().toBuffer();const file=path.join(downloads,'shiwu-results',payload.id,'image.jpg');await writeFile(file,generated);
    task.resolve(await task.event({type:'complete',filePath:file}));const completed=await result;
    assert.equal(completed.status,'completed');assert.equal(completed.reviewState,'pending_user');assert.equal(completed.model,'gpt-5.6-sol');assert.equal(hashBuffer(await readFile(path.join(batch,completed.file))),hashBuffer(generated));
    bridge.client=null;assert.equal((await runner.generate(job,c,batch,{onEvent:()=>{}})).file,completed.file);
  }finally{runner.close();await rm(dir,{recursive:true,force:true});}
});

test('扩展真实DOM流程选择Sol、上传对应原图、只发送一次，缺少视角依据不冒充成品',async()=>{
  const browser=await chromium.launch({...(process.env.WORKBENCH_TEST_BROWSER==='chromium'?{}:{channel:'chrome'}),headless:true}),page=await browser.newPage();const events=[];const folder=await mkdtemp(path.join(os.tmpdir(),'shiwu-native-dom-'));const file=path.join(folder,'purple.png');await writeFile(file,await sharp({create:{width:10,height:10,channels:3,background:'#ffccff'}}).png().toBuffer());let task;const session=await page.context().newCDPSession(page);const native=nativeInput({tabs:{get:async()=>({url:page.url(),width:1280,height:720})},debugger:{attach:async()=>{},detach:async()=>{},sendCommand:async(t,method,params)=>session.send(method,params)},runtime:{getPlatformInfo:async()=>({os:process.platform==='darwin'?'mac':'win'})}},async()=>task);
  try{
    await page.exposeFunction('testBridge',async m=>{if(m.action==='event')events.push(m.event);if(m.action==='native-click')await native.click(1,m.point);if(m.action==='native-type')await native.type(1,m.point);if(m.action==='native-upload')await native.upload(1);return {ok:true};});
    await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<button aria-label="选择 ChatGPT 模型" aria-expanded="false" onpointerdown="if(!event.isTrusted)return;this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true');document.querySelector('section').hidden=!document.querySelector('section').hidden">High</button><section hidden><button role="menuitem" onclick="document.querySelector('aside').hidden=false">选择模型</button><aside hidden><button role="menuitemradio" aria-checked="false" onclick="this.setAttribute('aria-checked','true')">GPT-5.6 Sol</button></aside></section><input type="file" multiple><div role="textbox" aria-label="询问 ChatGPT" contenteditable="true"></div><button aria-label="发送" onclick="if(!event.isTrusted)return;window.sendCount=(window.sendCount||0)+1;const u=document.createElement('div');u.dataset.messageAuthorRole='user';u.textContent=document.querySelector('[role=textbox]').textContent;document.body.append(u);history.pushState({},'', '/c/test-bridge');const a=document.createElement('div');a.dataset.messageAuthorRole='assistant';a.textContent='缺少视角依据';document.body.append(a)">发送</button><script>window.chrome={runtime:{sendMessage:m=>window.testBridge(m),onMessage:{addListener:fn=>window.runBridge=fn}}};</script>`}));
    await page.goto('https://chatgpt.com/');await page.addScriptTag({path:path.resolve('browser-extension/content.js')});
    task={id:'fixture-task',marker:'SHIWU-fixture',prompt:'自然柔光 SHIWU-fixture',modelLabel:'GPT-5.6 Sol',files:[{name:'purple.png',nativePath:file,mime:'image/png'}]};
    await page.evaluate(task=>window.runBridge({action:'run',task},{},()=>{}),task);
    for(let n=0;!events.some(e=>e.type==='blocked');n++){if(n>100)throw new Error(JSON.stringify(events));await page.waitForTimeout(100);}
    assert.equal(await page.evaluate(()=>window.sendCount),1);assert.equal(await page.locator('input[type=file]').evaluate(e=>e.files[0].name),'purple.png');assert.equal(events.find(e=>e.type==='submitting').observedModel,'GPT-5.6 Sol');assert.match(events.find(e=>e.type==='submitted').conversationUrl,/\/c\/test-bridge$/);
    await page.evaluate(task=>window.runBridge({action:'run',task},{},()=>{}),task);await page.waitForTimeout(700);assert.equal(await page.evaluate(()=>window.sendCount),1);
  }finally{await browser.close();await rm(folder,{recursive:true,force:true});}
});
