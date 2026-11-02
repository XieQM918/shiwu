import path from 'node:path';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {browserLaunchOptions,runtimeEnv} from './platform.js';
import {chromeCandidates} from './environment.js';
import {SCENES,confirmedField,containedFile,hashBuffer} from './generation-input.js';
import {WEB_IMAGE_MODEL,webModel} from './image-model.js';

export class WebWait extends Error{constructor(reason,message){super(message);this.waitReason=reason;}}
export function manualChromeArgs(dataDir,connection={}){
  const args=['--user-data-dir='+path.join(dataDir,'chatgpt-browser-profile'),'--new-window'];
  if(connection.http1===true)args.push('--disable-http2');
  if(connection.proxyServer){const p=new URL(connection.proxyServer);if(!['http:','socks5:'].includes(p.protocol)||p.username||p.password)throw new Error('专用代理配置不正确');args.push('--proxy-server='+p.protocol+'//'+p.host);}
  return [...args,'https://chatgpt.com/'];
}
const wait=(reason,message)=>{throw new WebWait(reason,message);};
async function navigate(page,url){try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});}catch(e){wait('network','ChatGPT网页无法加载（'+(e.message.match(/ERR_[A-Z_]+/)?.[0]||e.name)+'），请检查专用窗口和网络后继续。');}}
export async function webPrompt(job,candidate,dir){
  const skill=await readFile(path.join(dir,job.snapshot.skill.path),'utf8');
  const guide=await readFile(path.join(dir,'skill/references/scene-guide.md'),'utf8');
  if(hashBuffer(Buffer.from(skill))!==job.snapshot.skill.sha256||hashBuffer(Buffer.from(guide))!==job.snapshot.skill.guideSha256)throw new Error('冻结的 Skill 或指南已变化');
  const realism=skill.split(/## 3\./)[1]?.split(/## 4\./)[0]||'';
  const color=guide.split('## 配色、光线与质感')[1]?.split('## 本地参考图索引')[0]||'';
  const categoryRow=guide.split('\n').find(l=>l.startsWith('| '+({'brooch':'胸针','ear-clip':'耳夹','bag-charm':'包挂'}[job.snapshot.category]||'未列品类')))||'';
  const facts=Object.fromEntries(Object.entries(job.snapshot.fields).filter(([,f])=>confirmedField(f)).map(([k,f])=>[k,f.value]));
  return [
    '请使用图片生成功能，只生成当前一张独立方形商品摄影图，不要拼图，不额外生成候选。',
    `商品：${job.snapshot.title}；锁定规格：${job.snapshot.skuLabel}。附件中的商品原图是唯一商品事实依据。`,
    `已确认参数（厘米/克）：${JSON.stringify(facts)}。缺失或冲突参数未知，不能根据外观猜测材质、尺寸、售卖数量或隐藏结构。`,
    `任务：${candidate.viewBrief||SCENES.find(s=>s.id===candidate.scene)?.brief}。`,
    '摄影风格来自用户的 etsy-accessory-images Skill：自然、克制、接近实拍；无文字、边框、额外Logo及未包含的包装。商品颜色、花瓣/珠饰/叶片数量、连接结构和比例必须保留。静物平放且有接触阴影，不无支撑直立。',
    '品类要求：'+categoryRow,'真实感要求：'+realism,'配色、光线和质感：'+color,
    '已批准摄影偏好：'+JSON.stringify((candidate.preferences||[]).map(p=>p.instruction)),
    job.adjustment?'最后一张附件是当前待调整成品，其他附件为原始商品依据。仅修改这张图：'+job.adjustment.instruction:'',
    '先核对指定视角是否有原图依据。不能确定时仅回复“缺少视角依据”，不要猜测或生图。生成后简短核对一次，不自动重画。'
  ].filter(Boolean).join('\n\n');
}

export class ChatGPTBrowser{
  constructor({dataDir,launch=options=>chromium.launchPersistentContext(path.join(dataDir,'chatgpt-browser-profile'),options)}={}){this.dataDir=dataDir;this.launch=launch;this.context=null;this.page=null;this.opening=null;}
  async open(){
    if(this.opening)return this.opening;
    if(await this.manualState())wait('login','普通Chrome手动登录窗口已打开。完成登录后点击“登录完成并接入”，将关闭该专用窗口并接入工作台。');
    if(this.context){
      if(!this.page||this.page.isClosed())this.page=await this.context.newPage();
      const state=await this.inspect(this.page);
      if(!state.editorReady&&!state.requiresLogin&&!state.verification&&(this.navigationProblem||state.networkError||this.page.url()==='about:blank'))await this.reconnect();
      await this.page.bringToFront();return this.page;
    }
    if(this.opening)return this.opening;
    this.opening=(async()=>{await mkdir(path.join(this.dataDir,'chatgpt-browser-profile'),{recursive:true});
      const connection=await readFile(path.join(this.dataDir,'chatgpt-connection.json'),'utf8').then(JSON.parse).catch(()=>({}));
      const options={...browserLaunchOptions(),headless:false,acceptDownloads:true,viewport:null,chromiumSandbox:true,ignoreDefaultArgs:['--password-store=basic','--use-mock-keychain']};
      if(connection.http1===true)options.args=['--disable-http2'];
      if(connection.proxyServer){const proxy=new URL(connection.proxyServer);if(!['http:','socks5:'].includes(proxy.protocol)||proxy.username||proxy.password)throw new Error('ChatGPT专用代理配置不正确');options.proxy={server:proxy.protocol+'//'+proxy.host};}
      this.context=await this.launch(options);this.context.on('close',()=>{this.context=null;this.page=null;});this.page=this.context.pages()[0]||await this.context.newPage();await this.reconnect();await this.page.bringToFront();return this.page;})();
    try{return await this.opening;}finally{this.opening=null;}
  }
  async reconnect(){this.navigationProblem=null;await navigate(this.page,'https://chatgpt.com/').catch(e=>{this.navigationProblem=e.message;});}
  async manualState(){return readFile(path.join(this.dataDir,'chatgpt-manual-login.json'),'utf8').then(JSON.parse).then(s=>s.active===true).catch(()=>false);}
  async manualLogin(){
    if(await this.manualState())return {open:true,manualLogin:true,message:'请完成普通Chrome窗口中的登录，然后点击登录完成并接入。'};
    const executable=chromeCandidates().find(existsSync);if(!executable)throw new Error('未找到本机Google Chrome，请先安装。');
    await this.close();await mkdir(path.join(this.dataDir,'chatgpt-browser-profile'),{recursive:true});
    const connection=await readFile(path.join(this.dataDir,'chatgpt-connection.json'),'utf8').then(JSON.parse).catch(()=>({}));
    const child=spawn(executable,manualChromeArgs(this.dataDir,connection),{env:runtimeEnv(),stdio:'ignore',detached:true});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();this.manualProcess=child;
    await writeFile(path.join(this.dataDir,'chatgpt-manual-login.json'),JSON.stringify({active:true,startedAt:new Date().toISOString()}));
    return {open:true,manualLogin:true,message:'普通Chrome专用窗口已打开，请本人完成登录。'};
  }
  async finishManualLogin(){
    const child=this.manualProcess;
    if(child&&child.exitCode===null){
      if(process.platform==='win32')wait('login','请先关闭普通Chrome的专用登录窗口，以保存登录状态，再点击登录完成并接入。');
      const closed=new Promise(resolve=>child.once('exit',()=>resolve(true)));child.kill('SIGTERM');
      if(!await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(false),8000))]))wait('login','专用登录窗口尚未关闭，请关闭后重试。');
    }
    await writeFile(path.join(this.dataDir,'chatgpt-manual-login.json'),JSON.stringify({active:false,finishedAt:new Date().toISOString()}));
    try{await this.open();}catch(e){if(/ProcessSingleton|SingletonLock|profile.*in use/i.test(e.message))wait('login','请先关闭普通Chrome的专用登录窗口，再点击登录完成并接入。');throw e;}
    return this.status();
  }
  async status(){if(await this.manualState())return {open:true,manualLogin:true,requestedModel:WEB_IMAGE_MODEL,message:'等待本人完成普通Chrome登录，再点击登录完成并接入。'};if(!this.page||this.page.isClosed())return {open:false,requestedModel:WEB_IMAGE_MODEL};const state=await this.inspect(this.page);if(state.editorReady||state.requiresLogin||state.verification)this.navigationProblem=null;return {open:true,requestedModel:WEB_IMAGE_MODEL,navigationProblem:this.navigationProblem||null,...state};}
  async inspect(page){
    const text=(await page.locator('body').innerText().catch(()=>''));
    const challenged=/challenges\.cloudflare|__cf_chl|\/captcha/.test(page.url())||/Verify you are human|验证您是人类|正在验证|Just a moment|Checking your browser/i.test(text);
    const controls=await page.getByRole('button',{name:/^(Log in|登录|登入)$/i}).all().catch(()=>[]);
    const login=(await Promise.all(controls.map(c=>c.isVisible().catch(()=>false)))).some(Boolean)||/^https:\/\/auth\.openai\.com\//.test(page.url());
    const editor=await page.locator('#prompt-textarea').isVisible().catch(()=>false);
    const quota=/image generation limit|reached.*image.*limit|图片生成.*上限|已达到.*图像.*限制|生图.*额度.*不足/i.test(text);
    const signInRejected=/accounts\.google\.com\/.*rejected/.test(page.url())||/此浏览器或应用可能不安全|This browser or app may not be secure/i.test(text);
    return {requiresLogin:login||signInRejected,signInRejected,verification:challenged,editorReady:editor,quota,networkError:text.match(/ERR_[A-Z_]+/)?.[0]||null};
  }
  async ready(page){const s=await this.inspect(page);if(s.signInRejected)wait('login','Google拒绝当前窗口登录，请使用“普通Chrome手动登录”，完成后接入工作台。');if(s.verification)wait('verification','ChatGPT网页需要本人完成验证；请在专用窗口操作后继续。');if(s.requiresLogin)wait('login','请在专用ChatGPT窗口使用自己的会员账号登录，再点击继续。');if(s.quota)wait('quota','ChatGPT网页提示图片生成额度限制，请稍后继续。');if(!s.editorReady)wait('page','ChatGPT编辑区尚未就绪或页面已变化，请检查专用窗口后继续。');}
  async selectModel(page,requested=WEB_IMAGE_MODEL){
    const model=webModel(requested);
    let picker=page.getByTestId('model-switcher-dropdown-button');
    if(!await picker.isVisible().catch(()=>false))picker=page.getByRole('button',{name:/^(选择\s*ChatGPT\s*模型|Choose ChatGPT model|Select ChatGPT model)$/i});
    if(!await picker.isVisible().catch(()=>false))picker=page.getByRole('button',{name:/^ChatGPT(?:\s|$)/i}).first();
    if(!await picker.isVisible().catch(()=>false))wait('model','网页未找到可确认的模型选择器；未发送图片或指令。');
    const label=async()=>await picker.innerText()+' '+(await picker.getAttribute('aria-label')||'');
    const evidence=observed=>({source:'visible_web_label',requested,observed});
    if(model.pattern.test(await label()))return evidence(await label());
    const findChoice=async()=>{
      for(const role of ['menuitemradio','menuitem','option']){
        const choices=page.getByRole(role,{name:new RegExp('^'+model.pattern.source.replace(/^\\b/,'').replace(/\\b$/,'')+'(?:\\s|$)','i')});
        const visible=[];for(const c of await choices.all())if(await c.isVisible())visible.push(c);
        if(visible.length>1)wait('model','网页出现多个同名模型选项，请人工核对。');
        if(visible.length===1)return visible[0];
      }
      return null;
    };
    const showChoices=async()=>{
      if(await picker.getAttribute('aria-expanded')!=='true')await picker.click();
      let choice=await findChoice();if(choice)return choice;
      // Current Chat UI puts the model list beneath the reasoning menu.
      const more=page.getByRole('menuitem',{name:/^(选择模型|Select model|Choose model|More models|更多模型|旧版模型|Legacy models|(?:5\.6\s*)?(?:High|Medium|Low|高|中|低))$/i});
      if(await more.count()===1&&await more.isVisible()){await more.click();choice=await findChoice();}
      return choice;
    };
    let choice=await showChoices();
    if(!choice){await page.keyboard.press('Escape');wait('model','ChatGPT会员网页未提供可确认的 '+model.label+' 选项；未提交生图，不切换其他模型。');}
    const observed=await choice.innerText();
    if(await choice.getAttribute('aria-checked')==='true'||await choice.getAttribute('aria-selected')==='true'){
      await page.keyboard.press('Escape');return evidence(observed);
    }
    if(await choice.isDisabled())wait('model',model.label+' 当前不可选择，请检查网页额度或访问权限。');
    await choice.click();
    if(model.pattern.test(await label()))return {...evidence(observed),selected:await label()};
    // The collapsed caption may only say “5.6 高”; verify the checked radio instead.
    choice=await showChoices();
    if(!choice||await choice.getAttribute('aria-checked')!=='true'&&await choice.getAttribute('aria-selected')!=='true')wait('model','网页未确认'+model.label+'已选中；任务暂停，未提交生图。');
    await page.keyboard.press('Escape');return {...evidence(observed),selected:observed};
  }
  async close(){await this.context?.close().catch(()=>{});}
}

export class ChatGPTImageRunner{
  constructor({browser}={}){this.browser=browser;this.closed=false;}
  async open(){this.closed=false;await this.browser.open();return null;}
  close(){this.closed=true;}
  async generate(job,candidate,dir,{signal,onEvent}){
    const stopped=()=>{if(this.closed||signal?.aborted)throw new Error('任务已停止，已提交的网页生成可在原会话中继续检查。');};
    const requested=job.requestedModel||candidate.web?.modelEvidence?.requested||WEB_IMAGE_MODEL;
    const model=webModel(requested);
    const proof=job.viewEvidence?.[candidate.view]||[];
    if(['side','back'].includes(candidate.view)&&!proof.length)return {status:'blocked',reason:'当前规格缺少已确认的'+candidate.viewLabel+'原图；请在素材依据中确认后继续。',attempts:0};
    const prompt=await webPrompt(job,candidate,dir),marker=`SHIWU-${job.id}-${candidate.id}`;
    const refs=job.snapshot.refs;
    for(const ref of refs){if(hashBuffer(await readFile(await containedFile(dir,ref.path)))!==ref.hash)throw new Error('冻结的原图已变化');}
    const journalFile=path.join(dir,candidate.filename+'-web.json');
    const journal=async patch=>{candidate.web={...candidate.web,...patch};await writeFile(journalFile,JSON.stringify(candidate.web,null,2));onEvent({message:candidate.web.phase==='submitted'?'ChatGPT已提交，正在等待生成':'正在准备ChatGPT网页'});};
    if(!candidate.web)candidate.web=await readFile(journalFile,'utf8').then(JSON.parse).catch(()=>null);
    stopped();
    if(candidate.web?.phase==='downloaded'){
      if(!candidate.web.file?.startsWith('results/'))throw new Error('登记的下载路径异常');
      const file=await containedFile(path.join(dir,'results'),candidate.web.file.slice(8));const buffer=await readFile(file);const meta=await sharp(buffer).metadata();
      if(hashBuffer(buffer)!==candidate.web.hash||refs.some(r=>r.hash===candidate.web.hash)||Math.min(meta.width||0,meta.height||0)<512||Math.abs(meta.width/meta.height-1)>.025)throw new Error('已下载图片校验失败');
      return {status:'completed',file:candidate.web.file,hash:candidate.web.hash,bytes:buffer.length,width:meta.width,height:meta.height,attempts:1,model:requested,reviewState:'pending_user',reason:'已恢复本机登记图片，待核对商品细节',web:candidate.web};
    }
    let page=await this.browser.open();stopped();
    if(candidate.web?.phase){
      if(candidate.web.modelEvidence?.requested!==requested||!model.pattern.test(candidate.web.modelEvidence?.observed||''))wait('model','原会话缺少可核实的'+model.label+'选择记录；请人工核对，不自动重新提交。');
      if(candidate.web.conversationUrl){if(!/^https:\/\/chatgpt\.com\/c\/[\w-]+$/.test(candidate.web.conversationUrl))wait('page','已保存的会话地址异常');await navigate(page,candidate.web.conversationUrl);}
      const found=await page.getByText(marker,{exact:false}).count();
      if(!found)wait('ambiguous','上次可能已提交。请在专用窗口打开含任务编号 '+marker+' 的原会话，再点击继续；程序不会自动重复提交。');
      if(!/\/c\//.test(page.url()))wait('ambiguous','尚未取得原会话地址，请在ChatGPT窗口检查。');
      await journal({conversationUrl:page.url().split('?')[0]});
    }else{
      await navigate(page,'https://chatgpt.com/');await this.browser.ready(page);
      if(await page.locator('[data-message-author-role="user"]').count())wait('page','未能打开独立新会话，已暂停，避免在旧聊天中继续提交。');
      const modelEvidence=await this.browser.selectModel(page,requested);stopped();
      onEvent({model:requested,message:'网页已确认'+model.label+'，正在上传原图'});
      const fullPrompt=prompt+'\n\n任务编号（无需绘入图片）：'+marker;
      await writeFile(path.join(dir,candidate.filename+'-prompt.txt'),fullPrompt);
      const files=await Promise.all(refs.map(r=>containedFile(dir,r.path)));
      if(job.adjustment?.sourceFile){const edit=await containedFile(dir,job.adjustment.sourceFile);if(hashBuffer(await readFile(edit))!==job.adjustment.sourceHash)throw new Error('冻结的修改目标已变化');files.push(edit);}
      // File input may be hidden; use the existing page upload control only.
      let fileInput=page.locator('input[type=file]');
      if(!await fileInput.count()){
        const attach=page.getByRole('button',{name:/Add files|添加照片|添加文件|附加|上传文件|Attach/i}).first();
        if(!await attach.isVisible().catch(()=>false))wait('page','未找到网页图片上传入口，请人工检查后继续。');await attach.click();
        const upload=page.getByRole('menuitem',{name:/Upload|上传|从电脑/i}).first();if(await upload.count())await upload.click();fileInput=page.locator('input[type=file]');
      }
      if(!await fileInput.count())wait('page','网页未提供文件上传控件');
      await fileInput.first().setInputFiles(files);await page.locator('#prompt-textarea').fill(fullPrompt);
      const send=page.getByTestId('send-button');await send.waitFor({state:'visible',timeout:30000}).catch(()=>wait('page','网页发送按钮未就绪'));
      for(let n=0;!await send.isEnabled();n++){stopped();if(n>90)wait('page','上传未完成，请检查网页后继续。');await page.waitForTimeout(1000);}
      stopped();await journal({phase:'submitting',marker,promptHash:hashBuffer(Buffer.from(fullPrompt)),modelEvidence,submittedAt:new Date().toISOString()});
      await send.click();
      for(let n=0;n<30&&!/\/c\//.test(page.url());n++){stopped();await page.waitForTimeout(500);}
      await journal({phase:'submitted',conversationUrl:/\/c\//.test(page.url())?page.url().split('?')[0]:null});
    }
    const deadline=Date.now()+20*60*1000;
    while(Date.now()<deadline){
      stopped();const state=await this.browser.inspect(page);
      if(state.verification)wait('verification','ChatGPT需要验证；请完成后继续原会话。');if(state.requiresLogin)wait('login','ChatGPT登录已失效，请登录后继续原会话。');if(state.quota)wait('quota','会员网页提示生图额度限制，已暂停，不自动重试。');
      const answer=page.locator('[data-message-author-role="assistant"]').last();
      const answerText=await answer.innerText().catch(()=>'');
      if(/缺少视角依据/.test(answerText))return {status:'blocked',reason:'ChatGPT报告缺少视角依据，未计为生成完成。',web:candidate.web,attempts:0};
      const image=answer.locator('img').filter({visible:true});
      if(await image.count()){
        if(await image.count()!==1)wait('page','网页返回了多张图片，需人工核对与当前位置对应关系。');
        await image.hover();let download=answer.getByRole('button',{name:/^Download|下载/i}).first();
        if(!await download.isVisible().catch(()=>false)){
          await image.click();download=page.getByRole('dialog').getByRole('button',{name:/^Download|下载/i}).first();
        }
        if(await download.isVisible().catch(()=>false)){
          const pending=page.waitForEvent('download',{timeout:30000});await download.click();const result=await pending;
          const temp=path.join(dir,'results',randomUUID()+'.part');await result.saveAs(temp);
          const buffer=await readFile(temp),meta=await sharp(buffer).metadata();
          if(buffer.length<1024||Math.min(meta.width||0,meta.height||0)<512||Math.abs(meta.width/meta.height-1)>.025||!['png','jpeg','webp'].includes(meta.format))wait('download','下载文件格式或尺寸不符合方图要求，未计为成品。');
          const hash=hashBuffer(buffer);if([...refs,...job.snapshot.styleRefs].some(r=>r.hash===hash))throw new Error('下载结果与原图相同');
          const file=`results/${candidate.filename}.${meta.format==='jpeg'?'jpg':meta.format}`;await rename(temp,path.join(dir,file));await journal({phase:'downloaded',file,hash});
          return {status:'completed',file,hash,bytes:buffer.length,width:meta.width,height:meta.height,attempts:1,model:requested,reviewState:'pending_user',reason:'已从会员网页下载原图，待核对商品细节',web:candidate.web};
        }
        if(!await page.getByTestId('stop-button').isVisible().catch(()=>false))wait('download','网页显示了图片，但未找到原图下载按钮；不会用缩略图或截图代替。');
      }
      await page.waitForTimeout(2000);
    }
    wait('timeout','等待生成超过20分钟，已暂停；继续时只检查原会话，不重复提交。');
  }
}
