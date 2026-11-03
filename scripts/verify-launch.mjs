// Test the distributable, not the developer's existing data or dependencies.
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {runtimeEnv,pythonLaunch,findExecutable} from '../server/platform.js';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..'),env=runtimeEnv();
await exec(process.execPath,['scripts/package-project.mjs'],{cwd:root,env,timeout:60000});
const temporary=await mkdtemp(path.join(os.tmpdir(),'shiwu 首次启动 & 验证-'));
let child,exited=false,log='';
try{
  const py=await pythonLaunch();await exec(py.command,[...py.args,'-c','import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',path.join(root,'output/exports/1688-workbench-mac-windows.zip'),temporary],{env,timeout:30000});
  const directory=path.join(temporary,'1688-workbench');
  for(const name of ['data','node_modules'])await assert.rejects(()=>access(path.join(directory,name)));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const options={cwd:directory,env:{...env,WORKBENCH_PORT:String(port),WORKBENCH_OPEN_BROWSER:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true};
  // A fixed ASCII command name avoids interpolating the Chinese/& directory into
  // a command string; the launcher itself must handle its real working path.
  child=process.platform==='win32'?spawn('cmd.exe',['/d','/c','start-workbench.cmd'],options):spawn(process.execPath,['scripts/launch.mjs','start'],options);
  child.on('error',e=>{exited=true;log+=e.message;});child.on('exit',()=>{exited=true;});
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{log=(log+data.toString()).slice(-16000);});
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let attempt=0;attempt<360&&!exited;attempt++){
    try{const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json());if(health.app==='1688-workbench'){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(ready,'解压后首次启动失败或超时：\n'+log);
  const config=await fetch(base+'/api/generation/config').then(r=>r.json());assert.equal(config.provider,'codex');assert.equal(config.requestedModel,'gpt-6.1-sol');assert.equal(config.reasoningEffort,'medium');assert.equal(config.executionPolicy.maxAdditionalWaits,1);
  const state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.products.length,0);assert.equal(state.generationJobs.length,0);
  const html=await fetch(base).then(r=>r.text());assert.match(html,/assets\/index-/);await access(path.join(directory,'data/dependency-lock.sha256'));
  const environment=await fetch(base+'/api/environment').then(r=>r.json());
  const cleaner=environment.checks.find(c=>c.id==='exiftool');
  if(cleaner?.status!=='ok'){
    const executable=findExecutable('exiftool',{env:runtimeEnv(process.env,{root:directory})});
    let diagnostic=cleaner?.message||'ExifTool missing';
    if(executable)try{await exec(executable,['-config','','-ver'],{cwd:directory,env:runtimeEnv(process.env,{root:directory}),timeout:15000});}catch(e){diagnostic+='\n'+(e.stderr||e.message);}
    assert.fail('首次安装后的下载清理工具未就绪：'+diagnostic);
  }
  const {cleanDownloadFiles}=await import(pathToFileURL(path.join(directory,'server/download-cleaner.js')).href);
  const {closeMetadataTools}=await import(pathToFileURL(path.join(directory,'server/metadata-tool.js')).href);
  try{
    const cleaned=await cleanDownloadFiles([{file:path.join(directory,'test/fixtures/brooch-parameter-card.jpg'),name:'fixture.jpg'}]);
    try{assert.equal(cleaned.report.success,1);assert.equal(cleaned.report.failed,0);assert.ok((await readFile(cleaned.files[0].file)).length>1000);}finally{await cleaned.cleanup();}
  }finally{await closeMetadataTools();}
  const sources=JSON.parse(await readFile(path.join(directory,'工程文件清单.json'),'utf8'));assert.ok(sources.files.every(f=>!f.path.startsWith('data/')&&!f.path.startsWith('output/')));
  console.log(`首次启动验证通过（${process.platform}）：工程ZIP解压到中文、空格和&目录，自动安装依赖、构建、启动，本机空资料库及GPT-6.1 Sol配置正确；未登录账号、未调用生图。`);
}finally{
  if(child?.pid&&!exited){
    if(process.platform==='win32')await exec('taskkill.exe',['/pid',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
    else child.kill('SIGTERM');
    for(let n=0;n<50&&!exited;n++)await new Promise(resolve=>setTimeout(resolve,100));
  }
  await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:500});
}
