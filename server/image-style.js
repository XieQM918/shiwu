import path from 'node:path';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {hashBuffer} from './generation-input.js';

export async function frozenStyle(snapshot,dir){
  const key=hashBuffer(Buffer.from(JSON.stringify([4,snapshot.skill.sha256,snapshot.skill.guideSha256]))),file=path.join(dir,'style-profile.json');
  const skill=await readFile(path.join(dir,snapshot.skill.path),'utf8');
  const guide=await readFile(path.join(dir,'skill/references/scene-guide.md'),'utf8');
  if(hashBuffer(Buffer.from(skill))!==snapshot.skill.sha256||hashBuffer(Buffer.from(guide))!==snapshot.skill.guideSha256)throw new Error('冻结的Skill或摄影指南发生变化，请新建批次。');
  try{const old=JSON.parse(await readFile(file,'utf8'));if(old.key===key&&old.textHash===hashBuffer(Buffer.from(old.text)))return old;}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  const realism=(skill.split(/## 3\./)[1]?.split(/## 4\./)[0]||'').split('\n').filter(line=>line.startsWith('- ')&&!/^[- ]*(三张角度|每张|默认)/.test(line)).join('\n');
  const color=guide.split('## 配色、光线与质感')[1]?.split('## 本地参考图索引')[0]||'';
  const category=guide.split('\n').find(line=>line.startsWith('| '+({'brooch':'胸针','ear-clip':'耳夹','bag-charm':'包挂'}[snapshot.category]||'未列品类')))||'';
  const profile={key,version:4,skillSha:snapshot.skill.sha256,guideSha:snapshot.skill.guideSha256,
    text:['自然、克制、接近实拍；素雅背景、方向性柔光、真实金属明暗与接触阴影；皮肤和织物保留自然纹理，无文字、边框或额外品牌标识。',category,realism,color].filter(Boolean).join('\n').trim()};
  profile.textHash=hashBuffer(Buffer.from(profile.text));await writeFile(file+'.tmp',JSON.stringify(profile,null,2));await rename(file+'.tmp',file);return profile;
}
