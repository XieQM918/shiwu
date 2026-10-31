import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,copyFile,stat,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pythonLaunch,runtimeEnv} from './platform.js';
const exec=promisify(execFile);
const SCRIPT=path.resolve(import.meta.dirname,'../skills/clean-image-metadata/scripts/clean_metadata.py');

// Execute the bundled Skill on disposable copies only. No extra metadata scan,
// decoding, recompression or hash pass is added to the download path.
export async function cleanDownloadFiles(entries,{script=SCRIPT,python}={}){
  const temporary=await mkdtemp(path.join(os.tmpdir(),'shiw-clean-download-'));
  const input=path.join(temporary,'images');await mkdir(input);
  const cleanup=()=>rm(temporary,{recursive:true,force:true});
  try{
    const names=[];
    for(const [i,entry] of entries.entries()){
      const ext=path.extname(entry.file).toLowerCase();const name=`${String(i+1).padStart(5,'0')}${ext}`;
      await copyFile(entry.file,path.join(input,name));names.push(name);
    }
    let stdout;
    const env={...runtimeEnv(),PYTHONIOENCODING:'utf-8'};const launch=await pythonLaunch({env,executable:python});
    try{({stdout}=await exec(launch.command,[...launch.args,script,input],{env,windowsHide:true,timeout:300000,maxBuffer:4*1024*1024}));}
    catch(e){if(e.code===1&&e.stdout)stdout=e.stdout;else{
      let reason;try{reason=JSON.parse(e.stdout).error;}catch{}
      throw new Error(reason|| (e.code==='ENOENT'?'图片清理组件缺失，请检查 Python 3 和 ExifTool。':'图片元数据清理未完成，请重试；没有提供未经清理的下载副本。'));
    }}
    const report=JSON.parse(stdout);if(report.error||!report.output_directory)throw new Error(report.error||'图片清理未返回输出目录');
    const output=await realpath(report.output_directory);if(!output.startsWith(await realpath(temporary)+path.sep))throw new Error('清理输出目录异常');
    const cleaned=[];
    for(const [i,entry] of entries.entries()){
      const file=path.join(output,names[i]);const info=await stat(file).catch(()=>null);
      const issue=report.issues.find(x=>x.file===names[i]&&['skipped','failed'].includes(x.status));
      cleaned.push({...entry,file:info?.isFile()&&info.size?file:null,cleaning:issue?{status:issue.status,reason:issue.reason}:{status:info?.size?'success':'failed',reason:info?.size?'': '未生成清理副本'}});
    }
    return {files:cleaned,report:{status:report.status,success:report.success,skipped:report.skipped,failed:report.failed,warnings:report.warnings,
      issues:report.issues.map(x=>({...x,file:entries[names.indexOf(x.file)]?.name||x.file})),scope:'文件内来源元数据；不处理画面文字、Logo 或像素隐形水印'},cleanup};
  }catch(e){await cleanup();throw e;}
}

export async function sendCleanImage(res,file,name){
  const batch=await cleanDownloadFiles([{file,name}]);const image=batch.files[0];
  if(!image.file){await batch.cleanup();throw new Error(`此图片未能清理：${image.cleaning.reason}，未提供原始副本。`);}
  let disposed=false;const dispose=()=>{if(!disposed){disposed=true;batch.cleanup().catch(()=>{});}};
  res.once('finish',dispose);res.once('close',dispose);
  res.setHeader('X-Image-Metadata-Cleanup','completed');
  res.download(image.file,name,err=>{dispose();if(err&&!res.headersSent)res.status(500).json({error:'清理完成，但图片传输失败，请重试。'});});
}
