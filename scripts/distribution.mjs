import path from 'node:path';
import {readdir,lstat,readFile} from 'node:fs/promises';
export const ROOT=path.resolve(import.meta.dirname,'..');
const files=['package.json','package-lock.json','index.html','vite.config.js','.gitignore','.gitattributes','.env.example','README.md','WINDOWS.md','GITHUB.md','COMPATIBILITY.md','使用说明.md','变更需求记录.md','验证结果.md','启动工作台.command','start-workbench.cmd','启动工作台-Windows.cmd','环境检查-Windows.cmd','登录GPT-Windows.cmd'];
const directories=['server','src','scripts','native','skills','test','browser-extension','.github'];
export function privatePath(relative){return /(^|\/)(data|output|node_modules|dist|\.git|\.codex|browser-profile|chatgpt-browser-profile)(\/|$)/i.test(relative)||/(^|\/)(auth|cookies|storage-state)\.json$/i.test(relative)||/(^|\/)\.env(?:\..*)?$/.test(relative)&&relative!=='.env.example'||/\.(sqlite(?:-.*)?|db|log|zip|traineddata(?:\.gz)?)$/i.test(relative);}
export async function distributionEntries(root=ROOT){
  const entries=[];
  async function add(relative){if(privatePath(relative))throw new Error('禁止分享本机资料：'+relative);const file=path.join(root,...relative.split('/'));const info=await lstat(file);if(info.isSymbolicLink())throw new Error('分发内容不能使用指向工程外的符号链接：'+relative);
    if(info.isDirectory()){for(const name of (await readdir(file)).sort())await add(relative+'/'+name);}else if(info.isFile())entries.push({relative,file,mode:relative.endsWith('.command')?0o755:0o644});
  }
  for(const relative of [...files,...directories])await add(relative);
  for(const entry of entries.filter(e=>/\.(?:js|jsx|mjs|json|md|yml|cmd|command|css)$/.test(e.relative))){const text=await readFile(entry.file,'utf8');if(/\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{35,}\b|\bsk-proj-[A-Za-z0-9_-]{35,}\b/.test(text))throw new Error('分发文件疑似含访问令牌，请先移除：'+entry.relative);}
  return entries.sort((a,b)=>a.relative.localeCompare(b.relative,'en'));
}
