const $=id=>document.getElementById(id);
$('version').textContent='版本 '+chrome.runtime.getManifest().version+' · 原生页面交互';
chrome.storage.local.get(['base','key']).then(c=>{if(c.base)$('base').value=c.base;if(c.key)$('key').value=c.key;});
async function action(name){try{const result=await chrome.runtime.sendMessage({action:name,base:$('base').value,key:$('key').value});if(result.error)throw new Error(result.error);$('status').textContent=result.message;}catch(e){$('status').textContent=e.message;}}
$('connect').addEventListener('click',()=>action('connect'));
$('disconnect').addEventListener('click',()=>action('disconnect'));
