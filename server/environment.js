import path from 'node:path';
import {existsSync} from 'node:fs';
import {access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimeEnv,findExecutable,codexLaunch,imageCodexExecutable,pythonLaunch,bundledSkillPath} from './platform.js';
const exec=promisify(execFile);
const get=(env,name)=>env[Object.keys(env).find(k=>k.toLowerCase()===name.toLowerCase())]||'';
export function chromeCandidates({platform=process.platform,env=process.env}={}){
  if(env.WORKBENCH_BROWSER_EXECUTABLE)return [env.WORKBENCH_BROWSER_EXECUTABLE];
  if(platform==='win32')return [get(env,'ProgramFiles'),get(env,'ProgramFiles(x86)'),get(env,'LOCALAPPDATA')].filter(Boolean).map(base=>path.win32.join(base,'Google','Chrome','Application','chrome.exe'));
  if(platform==='darwin')return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable'];
}
export async function inspectEnvironment({root=path.resolve(import.meta.dirname,'..'),checkLogin=true}={}){
  const env=runtimeEnv(process.env,{root}),checks=[];const add=(id,label,status,message)=>checks.push({id,label,status,message});
  add('node','Node.js',Number(process.versions.node.split('.')[0])>=24?'ok':'error',`当前 ${process.version}，需要24或更高版本。`);
  const chrome=chromeCandidates().find(file=>existsSync(file));add('chrome','Google Chrome',chrome?'ok':'error',chrome?'已找到本机浏览器；1688使用本工程独立登录资料。':'请安装Google Chrome，或配置 WORKBENCH_BROWSER_EXECUTABLE。');
  try{await access(bundledSkillPath(root));await access(path.join(path.dirname(bundledSkillPath(root)),'references/scene-guide.md'));add('skill','Etsy 生图 Skill','ok','工程已包含Skill与摄影参考，不依赖原作者电脑目录。');}catch{add('skill','Etsy 生图 Skill','error','随工程的Skill或参考文件缺失，请重新下载完整工程。');}
  try{if(process.platform==='darwin'&&process.env.WORKBENCH_OCR_ENGINE!=='tesseract'){
    if(!existsSync('/usr/bin/xcrun'))throw new Error('需要Apple命令行工具。');add('ocr','本机图片文字识别','ok','使用macOS Vision。首次识别时准备本机组件。');
  }else{const {modelFile}=await import('./portable-ocr.js');await Promise.all(['chi_sim','eng'].map(code=>access(modelFile(code))));add('ocr','本机图片文字识别','ok','本机OCR及中英文模型已安装；识别不上传图片，不使用付费接口。');}}catch{add('ocr','本机图片文字识别','error','OCR组件未就绪，请在工程目录运行 npm ci --include=optional。');}
  try{const py=await pythonLaunch({env});add('python','图片下载清理 · Python','ok',`已找到Python 3（${path.basename(py.command)}）。`);}catch(e){add('python','图片下载清理 · Python','error',e.message);}
  const exiftool=findExecutable('exiftool',{env});if(exiftool){try{const {stdout}=await exec(exiftool,['-config','','-ver'],{env,timeout:10000,windowsHide:true});add('exiftool','图片下载清理 · ExifTool','ok',`ExifTool ${stdout.trim().slice(0,30)} 已就绪。`);}catch{add('exiftool','图片下载清理 · ExifTool','error','ExifTool无法运行；请重装可选依赖或将有效ExifTool加入PATH。');}}else add('exiftool','图片下载清理 · ExifTool','error',process.platform==='win32'?'请运行 npm ci --include=optional，安装Windows下载清理组件。':'请安装ExifTool并加入PATH。');
  try{const launch=codexLaunch();await exec(launch.command,[...launch.args,'--version'],{env,timeout:15000,windowsHide:true});add('codex','本机 Codex','ok','已找到Codex；使用此电脑当前用户自己的账号。');
    if(checkLogin){try{const {stdout,stderr}=await exec(launch.command,[...launch.args,'login','status'],{env,timeout:15000,windowsHide:true});const text=stdout+' '+stderr;
      add('login','GPT 账号登录',/api.?key/i.test(text)?'warning':'ok',/api.?key/i.test(text)?'当前是API密钥登录；本工作台默认使用ChatGPT账号，请运行 codex login 切换。':'本机已登录。生图功能及额度以此账号实际可用能力为准。');
    }catch{add('login','GPT 账号登录','warning','尚未确认登录。Windows双击“登录GPT-Windows.cmd”，使用你自己的账号登录。');}}
  }catch{add('codex','本机 Codex','warning','请先运行 npm install -g @openai/codex，再使用自己的ChatGPT账号登录；采集功能仍可单独使用。');}
  try{const launch=codexLaunch(imageCodexExecutable());const {stdout}=await exec(launch.command,[...launch.args,'--version'],{env,timeout:15000,windowsHide:true});add('imageCodex','生图Codex · GPT-6.1 Sol','ok','已找到生图入口（'+stdout.trim().slice(0,80)+'）。每次生成前核对模型，不回退其他模型。');}catch{add('imageCodex','生图Codex · GPT-6.1 Sol','error','请更新Codex，或设置 WORKBENCH_IMAGE_CODEX_BIN 指向支持gpt-6.1-sol的入口。');}
  return {platform:process.platform,checks,ok:!checks.some(c=>c.status==='error'),accountIsolation:'仅同步程序。1688登录、本机GPT登录、商品资料、成品和修改偏好分别保存在各自电脑，不上传GitHub。',generationNote:'环境检查不会调用生图，也不验证账号的生图权限；实际不可用时任务会显示原因。'};
}
