// Only these native input/file-upload operations are exposed. No Runtime/Network/auth commands.
export function nativeInput(chrome,taskForTab){
  const attached=new Set();
  async function check(tabId){
    const task=await taskForTab(tabId),tab=await chrome.tabs.get(tabId);
    if(!task||!/^https:\/\/chatgpt\.com\//.test(tab.url||''))throw new Error('仅允许操作本次ChatGPT任务标签页');
    return {task,tab};
  }
  async function command(tabId,method,params){
    await check(tabId);
    if(!attached.has(tabId)){await chrome.debugger.attach({tabId},'1.3');attached.add(tabId);}
    await check(tabId);
    return chrome.debugger.sendCommand({tabId},method,params);
  }
  async function click(tabId,point){
    const {tab}=await check(tabId),{x,y}=point||{};
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>(tab.width||10000)||y>(tab.height||10000))throw new Error('控件坐标超出任务页面');
    await command(tabId,'Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await command(tabId,'Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await command(tabId,'Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  }
  async function type(tabId,point){
    const {task}=await check(tabId);if(typeof task.prompt!=='string'||!task.prompt.includes(task.marker))throw new Error('提示词未冻结');
    await click(tabId,point);
    const platform=await chrome.runtime.getPlatformInfo(),modifiers=platform.os==='mac'?4:2;
    await command(tabId,'Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers,commands:['selectAll']});
    await command(tabId,'Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers});
    await command(tabId,'Input.insertText',{text:task.prompt});
  }
  async function upload(tabId){
    const {task}=await check(tabId),files=task.files?.map(f=>f.nativePath);
    if(!files?.length||files.some(f=>typeof f!=='string'||!f))throw new Error('缺少本次已登记的原图路径');
    const {root}=await command(tabId,'DOM.getDocument',{depth:0});
    const {nodeId}=await command(tabId,'DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});
    if(!nodeId)throw new Error('网页未提供原图上传控件');
    await command(tabId,'DOM.setFileInputFiles',{nodeId,files});
  }
  async function detach(tabId){if(attached.delete(tabId))await chrome.debugger.detach({tabId}).catch(()=>{});}
  return {click,type,upload,detach,owns:tabId=>attached.has(tabId),forget:tabId=>attached.delete(tabId)};
}
