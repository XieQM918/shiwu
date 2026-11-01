import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {chromium} from 'playwright';import sharp from 'sharp';
import {ChatGPTBrowser,ChatGPTImageRunner,webPrompt,WebWait} from '../server/chatgpt-web.js';
import {hashBuffer} from '../server/generation-input.js';
import {weightParts} from '../server/weight.js';

test('克重保留、整数磅加余量盎司，四舍五入进位，不把微小正值显示为零',()=>{
 assert.deepEqual(weightParts(453.59237),{grams:453.59237,lb:1,oz:'0'});
 assert.deepEqual(weightParts(500),{grams:500,lb:1,oz:'1.637'});
 assert.deepEqual(weightParts(10.7),{grams:10.7,lb:0,oz:'0.3774'});
 assert.equal(weightParts(453.59236).lb,1);assert.equal(weightParts(453.59236).oz,'0');assert.equal(weightParts(0.000001).oz,'<0.0001');
 assert.equal(weightParts(null),null);assert.equal(weightParts(''),null);assert.equal(weightParts('多规格'),null);
});

test('网页登录/验证/模型缺失明确暂停；只能选择网页确实提供的GPT-6 Luna；原会话下载不重复提交',async()=>{
 const browser=await chromium.launch({...(process.env.WORKBENCH_TEST_BROWSER==='chromium'?{}:{channel:'chrome'}),headless:true});
 const page=await browser.newPage({acceptDownloads:true});const helper=new ChatGPTBrowser({dataDir:os.tmpdir()});
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-web-'));
 try{
  await page.setContent('<button>Log in</button>');await assert.rejects(()=>helper.ready(page),e=>e instanceof WebWait&&e.waitReason==='login');
  await page.setContent('<p>Verify you are human</p>');await assert.rejects(()=>helper.ready(page),e=>e.waitReason==='verification');
  await page.setContent('<div id="prompt-textarea" contenteditable></div><button data-testid="model-switcher-dropdown-button">ChatGPT</button>');await assert.rejects(()=>helper.selectLuna(page),e=>e.waitReason==='model');
  await page.setContent('<button data-testid="model-switcher-dropdown-button" onclick="document.querySelector(\'section\').hidden=false">ChatGPT</button><section hidden><button role="menuitem" onclick="document.querySelector(\'[data-testid]\').textContent=\'GPT-6 Luna\';this.parentElement.hidden=true">GPT-6 Luna</button><button role="menuitem">GPT-5.6 Luna</button></section>');
  assert.equal((await helper.selectLuna(page)).observed,'GPT-6 Luna');
  for(const folder of ['input','skill/references','results'])await mkdir(path.join(dir,folder),{recursive:true});
  const original=await readFile(new URL('./fixtures/brooch-parameter-card.jpg',import.meta.url));await writeFile(path.join(dir,'input/original.jpg'),original);
  const skill='# skill\n## 3. 真实感\n不磨皮成蜡像，保留金属明暗。\n## 4. 调用\n内置image_gen';const guide='| 胸针 | 衣物局部 | 无背面不补造 |\n## 配色、光线与质感\n自然窗光，真实织纹。\n## 本地参考图索引';
  await writeFile(path.join(dir,'skill/SKILL.md'),skill);await writeFile(path.join(dir,'skill/references/scene-guide.md'),guide);
  const snapshot={title:'花朵胸针',skuLabel:'紫色',category:'brooch',fields:{material:{value:'铜',status:'found'}},refs:[{path:'input/original.jpg',hash:hashBuffer(original)}],styleRefs:[],skill:{path:'skill/SKILL.md',sha256:hashBuffer(Buffer.from(skill)),guideSha256:hashBuffer(Buffer.from(guide))}};
  const job={id:'test',snapshot},c={id:'overview-A',scene:'overview',filename:'02-overview-A',preferences:[{instruction:'背景留白'}]};
  const prompt=await webPrompt(job,c,dir);assert.match(prompt,/不磨皮成蜡像/);assert.match(prompt,/自然窗光/);assert.match(prompt,/背景留白/);assert.ok(!prompt.includes('内置image_gen'));
  const runner=new ChatGPTImageRunner({browser:{open:async()=>page,inspect:async()=>({}),ready:async()=>{},selectLuna:async()=>{throw new Error('不应重复选择模型/提交')}}});
  const side=await runner.generate(job,{...c,view:'side',viewLabel:'侧面'},dir,{onEvent:()=>{}});assert.equal(side.status,'blocked');
  const jpeg=await sharp({create:{width:1024,height:1024,channels:3,background:'#aabbcc'}}).jpeg().toBuffer();
  const url='https://chatgpt.com/c/test-conversation';const marker='SHIWU-test-overview-A';
  await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:`<p>${marker}</p><div data-message-author-role="assistant"><img src="data:image/jpeg;base64,${jpeg.toString('base64')}"><button aria-label="Download" onclick="const a=document.createElement('a');a.href=document.querySelector('img').src;a.download='generated.jpg';a.click()">Download</button></div>`}));
  c.web={modelEvidence:{requested:'gpt-6-luna',observed:'GPT-6 Luna'},phase:'submitted',conversationUrl:url,submittedAt:new Date().toISOString()};const result=await runner.generate(job,c,dir,{onEvent:()=>{}});
  assert.equal(result.status,'completed');assert.equal(result.reviewState,'pending_user');assert.equal(result.model,'gpt-6-luna');assert.equal(result.web.phase,'downloaded');assert.equal(result.width,1024);assert.equal(await readFile(path.join(dir,result.file)).then(b=>hashBuffer(b)),result.hash);
  const recover=new ChatGPTImageRunner({browser:{open:async()=>{throw new Error('本机已下载图片不应再次访问网页');}}});
  const recovered=await recover.generate(job,c,dir,{onEvent:()=>{}});assert.equal(recovered.file,result.file);
  await assert.rejects(()=>runner.generate(job,{...c,web:{phase:'submitting'}},dir,{onEvent:()=>{},signal:AbortSignal.abort()}),/停止/);
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});
