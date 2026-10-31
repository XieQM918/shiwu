import path from 'node:path';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {runtimeEnv,findExecutable,codexLaunch} from '../server/platform.js';
const root=path.resolve(import.meta.dirname,'..');process.chdir(root);
const env=runtimeEnv();
export function npmLaunch(){
  if(process.platform!=='win32')return {command:'npm',args:[]};
  const npm=findExecutable('npm',{env});const directories=[path.dirname(process.execPath),npm&&path.dirname(npm)].filter(Boolean);
  for(const directory of directories){const cli=path.join(directory,'node_modules','npm','bin','npm-cli.js');if(existsSync(cli))return {command:process.execPath,args:[cli]};}
  throw new Error('未找到npm组件，请重新安装Node.js，并选择同时安装npm。');
}
function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,env,stdio:'inherit',windowsHide:false});child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolve():reject(new Error(signal?'操作已停止。':`操作未完成（退出码${code}）。`)));});}
async function npm(args){const launch=npmLaunch();await run(launch.command,[...launch.args,...args]);}
async function prepare(){
  const hash=createHash('sha256').update(await readFile('package-lock.json')).digest('hex');const marker=path.join(root,'data','dependency-lock.sha256');const old=await readFile(marker,'utf8').catch(()=>'');
  if(hash!==old||!existsSync('node_modules/express')||!existsSync('node_modules/tesseract.js')||!existsSync('node_modules/sharp')){
    console.log('首次运行或依赖更新，正在安装组件和本机识别模型，请保持网络连接…');await npm(['ci','--include=optional','--no-audit','--no-fund']);await mkdir(path.dirname(marker),{recursive:true});await writeFile(marker,hash);
  }
}
async function healthy(url){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1200)});return r.ok&&(await r.json()).app==='1688-workbench';}catch{return false;}}
function open(url){const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32.exe':'xdg-open';const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];const child=spawn(command,args,{env,stdio:'ignore',windowsHide:true});child.on('error',()=>console.log('请用浏览器打开 '+url));child.unref();}
async function main(){
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('需要Node.js 24或更高版本，请先安装后重新打开启动入口。');
  const port=Number(env.WORKBENCH_PORT||3210);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('工作台端口需在1024–65535之间。');const url=`http://127.0.0.1:${port}`;
  const mode=process.argv[2]||'start';
  if(mode==='start'&&await healthy(url)){open(url);return;}
  await prepare();
  if(mode==='doctor'){await run(process.execPath,['scripts/doctor.mjs']);return;}
  if(mode==='login'){const launch=codexLaunch();await run(launch.command,[...launch.args,'login']);return;}
  if(mode!=='start')throw new Error('未知启动方式。');
  const {inspectEnvironment}=await import('../server/environment.js');const report=await inspectEnvironment({checkLogin:false});for(const c of report.checks.filter(c=>c.status!=='ok'))console.log(`${c.label}：${c.message}`);
  await npm(['run','build']);
  console.log(`\n工作台运行期间请保留此窗口。浏览器地址：${url}\n按Ctrl+C停止。`);
  const child=spawn(process.execPath,['server/index.js'],{cwd:root,env,stdio:'inherit',windowsHide:false});child.on('error',e=>{console.error(e.message);process.exitCode=1;});
  let exited=false;child.on('exit',code=>{exited=true;process.exitCode=code||0;});
  const stop=()=>{if(!exited)child.kill('SIGTERM');};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  for(let n=0;n<60&&!exited;n++){if(await healthy(url)){open(url);break;}await new Promise(r=>setTimeout(r,500));}
}
main().catch(e=>{console.error('\n'+e.message+'\n可查看 README.md 或运行环境检查。');process.exitCode=1;});
