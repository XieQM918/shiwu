import path from 'node:path';
import os from 'node:os';
import {existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export function runtimeEnv(env=process.env,{platform=process.platform,root=path.resolve(import.meta.dirname,'..')}={}){
  const key=Object.keys(env).find(k=>k.toLowerCase()==='path');const previous=env[key]||'';
  const extra=platform==='win32'?[path.win32.join(root,'node_modules','exiftool-vendored.exe','bin')]:['/usr/local/bin','/opt/homebrew/bin'];
  const result={...env};for(const k of Object.keys(result))if(k.toLowerCase()==='path')delete result[k];
  result.PATH=[...extra,previous].filter(Boolean).join(platform==='win32'?';':':');return result;
}
export function findExecutable(name,{env=runtimeEnv(),platform=process.platform,exists=existsSync}={}){
  const paths=platform==='win32'?path.win32:path;
  if(paths.isAbsolute(name)||name.includes('/')||name.includes('\\'))return exists(name)?name:null;
  const key=Object.keys(env).find(k=>k.toLowerCase()==='path');
  const extensions=platform==='win32'?(paths.extname(name)?['']:['.exe','.com','.cmd','.bat','']):[''];
  for(const directory of (env[key]||'').split(platform==='win32'?';':':').filter(Boolean))for(const extension of extensions){const file=paths.join(directory.replace(/^"|"$/g,''),name+extension);if(exists(file))return file;}
  return null;
}
export function codexExecutable({env=process.env,platform=process.platform,home=os.homedir(),exists=existsSync}={}){
  if(env.WORKBENCH_CODEX_BIN)return env.WORKBENCH_CODEX_BIN;
  const p=platform==='win32'?path.win32:path;
  const candidates=[...(platform==='win32'?[env.APPDATA&&p.join(env.APPDATA,'npm','codex.cmd'),p.join(home,'.npm-global','codex.cmd')]:[p.join(home,'.npm-global/bin/codex')]),findExecutable('codex',{env:runtimeEnv(env,{platform}),platform,exists})];
  return candidates.find(file=>file&&exists(file))||'codex';
}
// Run the known npm JavaScript entrypoint directly on Windows. Never pass a
// .cmd wrapper or paths/arguments through shell:true.
export function executableLaunch(executable,{platform=process.platform,node=process.execPath,exists=existsSync}={}){
  const p=platform==='win32'?path.win32:path;
  if(/\.js$/i.test(executable))return {command:node,args:[executable]};
  if(platform==='win32'&&/\.(cmd|bat)$/i.test(executable)){
    const entry=p.join(p.dirname(executable),'node_modules','@openai','codex','bin','codex.js');
    if(!exists(entry))throw new Error('未找到Codex命令入口。请用 npm install -g @openai/codex 安装，或将 WORKBENCH_CODEX_BIN 指向 codex.exe。');
    return {command:node,args:[entry]};
  }
  return {command:executable,args:[]};
}
export function codexLaunch(executable,options={}){return executableLaunch(executable||codexExecutable(options),options);}
export function imageCodexExecutable(options={}){
  const {env=process.env,platform=process.platform,exists=existsSync}=options;
  if(env.WORKBENCH_IMAGE_CODEX_BIN)return env.WORKBENCH_IMAGE_CODEX_BIN;
  if(env.WORKBENCH_CODEX_BIN)return env.WORKBENCH_CODEX_BIN;
  const bundled='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if(platform==='darwin'&&exists(bundled))return bundled;
  return codexExecutable(options);
}
export async function pythonLaunch({env=runtimeEnv(),platform=process.platform,executable}={}){
  const choices=executable?[{command:executable,args:[]}]:env.WORKBENCH_PYTHON?[{command:env.WORKBENCH_PYTHON,args:[]}]:platform==='win32'?[{command:'py',args:['-3']},{command:'python',args:[]},{command:'python3',args:[]}]:[{command:'/usr/bin/python3',args:[]},{command:'python3',args:[]}];
  for(const choice of choices){const command=findExecutable(choice.command,{env,platform});if(!command)continue;
    try{const {stdout}=await exec(command,[...choice.args,'-c','import sys;sys.exit(1) if sys.version_info < (3,9) else print("workbench-python-3")'],{env,timeout:7000,windowsHide:true});if(stdout.trim()==='workbench-python-3')return {...choice,command};}catch{}
  }
  throw new Error('未找到Python 3.9或更高版本。Windows请安装Python并启用启动器，再运行环境检查。');
}
export function browserLaunchOptions(env=process.env){return env.WORKBENCH_BROWSER_EXECUTABLE?{executablePath:env.WORKBENCH_BROWSER_EXECUTABLE}:{channel:'chrome'};}
export function bundledSkillPath(root,env=process.env){return env.WORKBENCH_ETSY_SKILL?path.resolve(env.WORKBENCH_ETSY_SKILL):path.join(root,'skills','etsy-accessory-images','SKILL.md');}
