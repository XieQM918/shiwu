import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,cp,rm,access} from 'node:fs/promises';
import {runtimeEnv,findExecutable,pythonLaunch} from './platform.js';
const exec=promisify(execFile),prepared=new Map(),temporaryDirectories=new Set();
const ascii=value=>/^[\x20-\x7e]+$/.test(value);
// The Windows ExifTool launcher cannot locate Perl DLLs when its installation
// directory contains non-ASCII characters. Keep the Skill unchanged: give it a
// working ASCII executable path, using the existing 8.3 alias when available.
async function shortPath(file,env){
  const py=await pythonLaunch({env});
  const code='import ctypes,sys; k=ctypes.WinDLL("kernel32",use_last_error=True); f=k.GetShortPathNameW; f.argtypes=[ctypes.c_wchar_p,ctypes.c_wchar_p,ctypes.c_uint]; f.restype=ctypes.c_uint; b=ctypes.create_unicode_buffer(32768); n=f(sys.argv[1],b,len(b)); sys.exit(1) if not n or n>=len(b) else print(b.value)';
  const {stdout}=await exec(py.command,[...py.args,'-c',code,file],{env:{...env,PYTHONIOENCODING:'utf-8'},windowsHide:true,timeout:15000});return stdout.trim();
}
async function usableDirectory(executable,env){
  const short=await shortPath(executable,env).catch(()=>null);
  if(short&&ascii(short)){
    try{await exec(short,['-config','','-ver'],{env,windowsHide:true,timeout:15000});return path.dirname(short);}catch{}
  }
  // Only copy the bundled executable and its companion files, never accounts or
  // images. Each process owns a random directory; no shared mutable binary cache.
  const requested=env.WORKBENCH_TOOLS_DIR;
  for(const candidate of [requested,os.tmpdir()].filter(Boolean)){
    const base=ascii(candidate)?candidate:await shortPath(candidate,env).catch(()=>null);if(!base||!ascii(base))continue;
    let directory;
    try{
      await access(base);directory=await mkdtemp(path.join(base,'shiwu-exiftool-'));
      await cp(path.dirname(executable),directory,{recursive:true});
      await exec(path.join(directory,'exiftool.exe'),['-config','','-ver'],{env,windowsHide:true,timeout:15000});
      temporaryDirectories.add(directory);return directory;
    }catch{if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{});}
  }
  throw new Error('Windows图片清理工具不支持当前安装路径。请将工程放在C:\\Work\\shiwu等英文目录，或将WORKBENCH_TOOLS_DIR设为自己可写的现有英文目录，再重启。');
}
export async function metadataToolEnv({env=process.env,root=path.resolve(import.meta.dirname,'..')}={}){
  const result=runtimeEnv(env,{root});if(process.platform!=='win32')return result;
  const executable=findExecutable('exiftool',{env:result});if(!executable||ascii(executable))return result;
  if(!prepared.has(executable))prepared.set(executable,usableDirectory(executable,result).catch(e=>{prepared.delete(executable);throw e;}));
  const directory=await prepared.get(executable);return {...result,PATH:directory+';'+result.PATH};
}
export async function closeMetadataTools(){await Promise.all([...temporaryDirectories].map(directory=>rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:200}).catch(()=>{})));temporaryDirectories.clear();prepared.clear();}
