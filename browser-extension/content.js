// Isolated content script. No cookies, passwords, localStorage, hidden APIs or auth tokens are read.
if(!globalThis.__shiwuCompanion){
  globalThis.__shiwuCompanion={running:null,stopped:false};
  const state=globalThis.__shiwuCompanion;
  const visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const text=e=>(e?.innerText||e?.getAttribute('aria-label')||'').trim();
  const find=(selector,re)=>[...document.querySelectorAll(selector)].find(e=>visible(e)&&(!re||re.test(text(e))||re.test(e.getAttribute('aria-label')||'')));
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  function point(element){element.scrollIntoView({block:'center',inline:'nearest'});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}
  async function activate(element){await message('native-click',{point:point(element)});}
  async function message(action,extra={}){const r=await chrome.runtime.sendMessage({action,id:state.running,...extra});if(r?.error)throw new Error(r.error);return r;}
  const event=e=>message('event',{event:e});
  async function until(fn,ms=10000,label='页面控件'){const end=Date.now()+ms;while(Date.now()<end){if(state.stopped)throw new Error('任务已停止');const v=await fn();if(v)return v;await pause(400);}throw new Error(label+'未就绪，请检查原ChatGPT会话');}
  async function selectModel(task){
    const picker=await until(()=>find('button[aria-label="选择 ChatGPT 模型"],button[aria-label="Choose ChatGPT model"],button[aria-label="Select ChatGPT model"],button[data-testid="model-switcher-dropdown-button"]'),10000,'模型选择按钮');
    const choice=()=>[...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')].find(e=>visible(e)&&text(e)===task.modelLabel);
    if(picker.getAttribute('aria-expanded')!=='true')await activate(picker);
    await until(()=>choice()||find('[role="menuitem"]',/^(选择模型|Select model|Choose model|More models|更多模型|(?:5\.6\s*)?(High|Medium|Low|高|中|低))$/i),10000,'模型菜单');
    if(!choice()){
      const nested=find('[role="menuitem"]',/^(选择模型|Select model|Choose model|More models|更多模型|(?:5\.6\s*)?(High|Medium|Low|高|中|低))$/i);
      if(nested)await activate(nested);
    }
    let selected=await until(choice,5000,'模型列表');
    if(selected.getAttribute('aria-disabled')==='true'||selected.disabled)throw new Error(task.modelLabel+'当前不可选择');
    if(selected.getAttribute('aria-checked')!=='true'&&selected.getAttribute('aria-selected')!=='true'){
      await activate(selected);await pause(300);if(picker.getAttribute('aria-expanded')!=='true')await activate(picker);await pause(200);
      if(!choice()){const nested=find('[role="menuitem"]',/^(选择模型|Select model|Choose model|(?:5\.6\s*)?(High|Medium|Low|高|中|低))$/i);if(nested)await activate(nested);}
      selected=await until(choice,5000,'模型列表');
    }
    if(selected.getAttribute('aria-checked')!=='true'&&selected.getAttribute('aria-selected')!=='true')throw new Error('未核实模型选中状态');
    if(picker.getAttribute('aria-expanded')==='true')await activate(picker);return task.modelLabel;
  }
  async function run(task){
    try{
      await until(()=>document.body,20000);
      if(!task.resume){
        const chatButton=[...document.querySelectorAll('button[aria-pressed]')].find(e=>/^(聊天|Chat)$/.test(text(e)));
        if(chatButton&&chatButton.getAttribute('aria-pressed')!=='true')await activate(chatButton);
        await event({type:'stage',message:'正在识别ChatGPT输入框'});
        const editor=await until(()=>find('#prompt-textarea,[role="textbox"][contenteditable="true"][aria-label="询问 ChatGPT"],[role="textbox"][contenteditable="true"][aria-label="Ask ChatGPT"]'),90000,'ChatGPT输入框');
        if(document.querySelector('[data-message-author-role="user"]'))throw new Error('不是空白新会话，未提交');
        await event({type:'stage',message:'正在选择并核对GPT-5.6 Sol'});
        let observedModel;try{observedModel=await selectModel(task);}catch(e){await event({type:'error',reason:'model',message:e.message});return;}
        let input=document.querySelector('input[type=file]');
        if(!input){const add=find('button',/^(添加文件等内容|Add files|Attach|添加照片)/i);if(add)await activate(add);await pause(300);const upload=find('[role=menuitem]',/上传|从电脑|Upload|Add photos/i);if(upload)await activate(upload);input=await until(()=>document.querySelector('input[type=file]'));}
        await event({type:'stage',message:'正在上传本规格冻结原图'});
        await message('native-upload');
        await event({type:'stage',message:'正在填写Etsy风格提示词'});
        await message('native-type',{point:point(editor)});
        if(!editor.textContent.includes(task.marker))throw new Error('编辑器中的提示词不完整，未提交');
        const send=await until(()=>{const e=find('[data-testid="send-button"],button[aria-label="发送"],button[aria-label="Send"],button[aria-label="Send message"]');return e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'?e:null;},120000,'发送按钮');
        await message('check');await event({type:'submitting',observedModel});if(state.stopped)throw new Error('任务已停止');await activate(send);
        await until(()=>/^\/c\/[\w-]+$/.test(location.pathname),30000);
        await event({type:'submitted',conversationUrl:location.origin+location.pathname});
      }else{
        await until(()=>[...document.querySelectorAll('[data-message-author-role="user"]')].some(e=>text(e).includes(task.marker)),60000);
      }
      const end=Date.now()+20*60*1000;
      while(Date.now()<end){
        if(state.stopped)throw new Error('任务已停止');await message('check');
        const body=document.body.innerText;
        if(/Verify you are human|验证您是人类|Just a moment/.test(body)){await event({type:'error',reason:'verification',message:'ChatGPT需要本人完成验证；完成后继续原会话。'});return;}
        if(/image generation limit|reached.*image.*limit|图片生成.*上限|已达到.*图像.*限制/i.test(body)){await event({type:'error',reason:'quota',message:'ChatGPT提示生图额度不足，未自动重试。'});return;}
        const answers=[...document.querySelectorAll('[data-message-author-role="assistant"]')],answer=answers.at(-1);
        if(answer&&/缺少视角依据/.test(text(answer))){await event({type:'blocked'});return;}
        const images=answer?[...answer.querySelectorAll('img')].filter(e=>visible(e)&&e.naturalWidth>=512&&e.naturalHeight>=512):[];
        if(images.length>1)throw new Error('返回多张图片，无法明确对应位置，已暂停');
        if(images.length===1){
          let download=[...answer.querySelectorAll('button')].find(e=>/^(Download|下载)/i.test(e.getAttribute('aria-label')||text(e)));
          if(!download){await activate(images[0]);await pause(400);download=find('[role=dialog] button',/^(Download|下载)/i);}
          if(download){await message('arm-download',{conversationUrl:location.origin+location.pathname});await activate(download);await event({type:'heartbeat'});return;}
        }
        await pause(2500);
      }
      throw new Error('等待超时，请在原会话检查，不自动重复发送');
    }catch(e){try{await event({type:'error',reason:'page',message:e.message});}catch{}}
    finally{state.running=null;}
  }
  chrome.runtime.onMessage.addListener((m,sender,reply)=>{
    if(m.action==='stop'){state.stopped=true;reply({ok:true});return;}
    if(m.action!=='run')return;
    if(state.running){reply(state.running===m.task.id?{started:true}:{error:'此页面正在执行另一任务'});return;}
    state.running=m.task.id;state.stopped=false;reply({started:true});run(m.task);
  });
}
