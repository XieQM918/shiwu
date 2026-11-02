import {nativeInput} from './native-input.js';
let polling=false;
const chat=url=>/^https:\/\/chatgpt\.com\//.test(url||'');
async function config(){return chrome.storage.local.get(['base','key','clientId','enabled']);}
async function api(route,body){const c=await config();if(!c.enabled)throw new Error('浏览器连接已断开');const r=await fetch(c.base+'/api/chatgpt/companion/bridge'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+c.key,'X-Shiwu-Client':c.clientId,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});const j=await r.json();if(!r.ok)throw new Error(j.error||'工作台未连接');return j;}
async function active(){return (await chrome.storage.session.get('active')).active;}
async function post(id,event){return api('/task/'+id+'/event',event);}
const input=nativeInput(chrome,async tabId=>{const a=await active();if(a?.tabId!==tabId)return null;return (await api('/task/'+a.id)).task;});
async function hello(){return api('/hello',{extensionVersion:chrome.runtime.getManifest().version,nativeInput:await chrome.permissions.contains({permissions:['debugger']})});}
async function fail(a,message,reason='page'){await input.detach(a.tabId);try{await post(a.id,{type:'error',reason,message});}catch{}await chrome.storage.session.remove('active');}
async function dispatch(tabId){
  const a=await active();if(!a||a.tabId!==tabId)return;
  const tab=await chrome.tabs.get(tabId);if(!chat(tab.url)){await fail(a,'此ChatGPT标签页需要本人完成登录或验证，完成后回工作台继续。','login');return;}
  try{const {task}=await api('/task/'+a.id);if(!task?.id)throw new Error('未收到完整的冻结任务');await chrome.scripting.executeScript({target:{tabId},files:['content.js']});const result=await chrome.tabs.sendMessage(tabId,{action:'run',task});if(result?.error)throw new Error(result.error);}
  catch(e){await fail(a,'网页未就绪或原任务失效：'+e.message);}
}
async function poll(){
  if(polling)return;polling=true;
  try{
    const c=await config();if(!c.enabled)return;
    await hello();const a=await active();
    if(a){try{await api('/task/'+a.id+'?state=1');await chrome.tabs.get(a.tabId);if(a.armedAt&&!a.downloadId&&Date.now()-a.armedAt>30000)await fail(a,'未找到能明确关联本会话的原图下载，请在原ChatGPT会话检查，不自动重复生成。','download');}catch{await chrome.storage.session.remove('active');}return;}
    const {task}=await api('/task');if(!task)return;
    // Every candidate gets a dedicated tab; only resume navigates to its registered conversation.
    const tab=await chrome.tabs.create({url:task.conversationUrl||'https://chatgpt.com/',active:true});
    await chrome.storage.session.set({active:{id:task.id,tabId:tab.id,createdAt:Date.now()}});
    if(tab.status==='complete')await dispatch(tab.id);
  }catch(e){await chrome.action.setBadgeText({text:'!'});await chrome.storage.session.set({lastError:e.message});}
  finally{polling=false;}
}
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='shiwu-poll')poll();});
async function restoreConnection(){if((await config()).enabled){await chrome.alarms.create('shiwu-poll',{periodInMinutes:.5});poll();}}
chrome.runtime.onStartup.addListener(restoreConnection);
chrome.runtime.onInstalled.addListener(restoreConnection);
restoreConnection().catch(()=>{});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='complete')dispatch(id);});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  (async()=>{
    if(m.action==='connect'){
      if(sender.tab)throw new Error('请使用扩展自己的连接面板');
      const base=new URL(m.base);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('仅支持本机127.0.0.1工作台');
      if(!/^[a-f0-9]{64}$/.test(m.key||''))throw new Error('连接码格式不正确');
      const c=await config();await chrome.storage.local.set({base:base.origin,key:m.key,clientId:c.clientId||crypto.randomUUID(),enabled:true});
      await hello();await chrome.alarms.create('shiwu-poll',{periodInMinutes:.5});await chrome.action.setBadgeText({text:'ON'});poll();return {message:'已连接本机工作台。回工作台点击继续，无需重新登录。'};
    }
    if(m.action==='disconnect'){if(sender.tab)throw new Error('请使用扩展面板');const a=await active();if(a){await chrome.tabs.sendMessage(a.tabId,{action:'stop'}).catch(()=>{});await input.detach(a.tabId);}await api('/disconnect',{}).catch(()=>{});await chrome.storage.local.set({enabled:false});await chrome.alarms.clear('shiwu-poll');await chrome.storage.session.remove('active');await chrome.action.setBadgeText({text:''});return {message:'已断开；已提交结果保留在ChatGPT。'};}
    const a=await active();if(!a||m.id!==a.id||sender.tab?.id!==a.tabId||!chat(sender.tab.url))throw new Error('不是本次指定的ChatGPT标签页');
    if(m.action==='event'){const result=await post(a.id,m.event);if(['error','blocked'].includes(m.event.type)){await input.detach(a.tabId);await chrome.storage.session.remove('active');}return result;}
    if(m.action==='native-click'){await input.click(a.tabId,m.point);return {ok:true};}
    if(m.action==='native-type'){await input.type(a.tabId,m.point);return {ok:true};}
    if(m.action==='native-upload'){await input.upload(a.tabId);return {ok:true};}
    if(m.action==='check'){await api('/task/'+a.id+'?state=1');return {ok:true};}
    if(m.action==='arm-download'){
      if(!/^https:\/\/chatgpt\.com\/c\/[\w-]+$/.test(m.conversationUrl||''))throw new Error('下载缺少原会话');
      await chrome.storage.session.set({active:{...a,armedAt:Date.now(),conversationUrl:m.conversationUrl}});return {ok:true};
    }
    throw new Error('未知操作');
  })().then(reply,e=>reply({error:e.message}));return true;
});
chrome.downloads.onDeterminingFilename.addListener((item,suggest)=>{
  (async()=>{
    const a=await active();if(!a?.armedAt||a.downloadId||Date.now()-a.armedAt>15000)return null;
    // Never take a download from another conversation or an unrelated browser tab.
    const ref=new URL(item.referrer||'https://invalid.local');if(ref.origin+ref.pathname!==a.conversationUrl)return null;
    const extension=(item.filename||'').match(/\.(png|jpg|jpeg|webp)$/i)?.[1]?.toLowerCase();if(!extension)return null;
    await chrome.storage.session.set({active:{...a,downloadId:item.id}});
    return {filename:'shiwu-results/'+a.id+'/image.'+extension,conflictAction:'uniquify'};
  })().then(result=>suggest(result||undefined),()=>suggest());return true;
});
chrome.downloads.onChanged.addListener(async delta=>{
  const a=await active();if(!a||delta.id!==a.downloadId)return;
  if(delta.state?.current==='interrupted'){await fail(a,'ChatGPT原图下载中断，请检查原会话后继续。','download');return;}
  if(delta.state?.current!=='complete')return;
  try{const [item]=await chrome.downloads.search({id:a.downloadId});if(!item?.exists||item.danger!=='safe')throw new Error('下载未完成或浏览器尚未确认安全，不自动接收');await post(a.id,{type:'complete',filePath:item.filename});await input.detach(a.tabId);await chrome.storage.session.remove('active');poll();}
  catch(e){await fail(a,'下载导入失败：'+e.message,'download');}
});
chrome.debugger.onDetach.addListener(async({tabId})=>{if(input.owns(tabId)){input.forget(tabId);const a=await active();if(a?.tabId===tabId)await fail(a,'原生页面交互已取消，任务已暂停，不自动重新附加。','page');}});
