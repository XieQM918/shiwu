import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimeEnv,findExecutable,codexExecutable,executableLaunch,pythonLaunch,bundledSkillPath} from '../server/platform.js';
import {chromeCandidates} from '../server/environment.js';
import {distributionEntries,privatePath,ROOT} from '../scripts/distribution.mjs';
const exec=promisify(execFile);
test('Windows PATH大小写与分隔符、npm入口和Chrome位置不依赖Mac路径',()=>{
 const env=runtimeEnv({Path:'C:\\Program Files\\nodejs;C:\\工具',APPDATA:'C:\\Users\\甲\\AppData\\Roaming'},{platform:'win32',root:'C:\\Work\\Shop'});assert.equal(Object.keys(env).filter(k=>k.toLowerCase()==='path').length,1);assert.ok(env.PATH.endsWith('C:\\Program Files\\nodejs;C:\\工具'));
 const file='C:\\Program Files\\nodejs\\codex.cmd';assert.equal(findExecutable('codex',{platform:'win32',env,exists:p=>p===file}),file);
 const shim='C:\\Users\\甲\\AppData\\Roaming\\npm\\codex.cmd',entry=path.win32.join(path.win32.dirname(shim),'node_modules','@openai','codex','bin','codex.js');
 const launch=executableLaunch(shim,{platform:'win32',node:'C:\\Program Files\\nodejs\\node.exe',exists:p=>p===entry});assert.equal(launch.command,'C:\\Program Files\\nodejs\\node.exe');assert.deepEqual(launch.args,[entry]);
 assert.throws(()=>executableLaunch('C:\\unknown\\codex.cmd',{platform:'win32',exists:()=>false}),/未找到Codex/);
 assert.equal(codexExecutable({platform:'win32',env:{APPDATA:'C:\\Users\\甲\\AppData\\Roaming'},home:'C:\\Users\\甲',exists:p=>p===shim}),shim);
 assert.ok(chromeCandidates({platform:'win32',env:{ProgramFiles:'C:\\Program Files'}})[0].endsWith('Google\\Chrome\\Application\\chrome.exe'));
 assert.ok(!bundledSkillPath('/project').includes('.agents'));assert.equal(bundledSkillPath('/project'),path.join('/project','skills','etsy-accessory-images','SKILL.md'));
});
test('Node直接运行脚本并保留中文、空格和特殊字符参数，不通过命令解释器拼接',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw 空格 & test-'));try{const entry=path.join(dir,'codex-test.js');await writeFile(entry,'console.log(JSON.stringify(process.argv.slice(2)))');const launch=executableLaunch(entry,{platform:'win32'});const args=['app-server','C:\\商品 & 图片\\a.jpg','x;echo nope'];const {stdout}=await exec(launch.command,[...launch.args,...args]);assert.deepEqual(JSON.parse(stdout),args);}finally{await rm(dir,{recursive:true,force:true});}
});
test('Python解析使用本机已存在的Python3，不需要共享账号或写死Mac路径',async()=>{
 const py=await pythonLaunch();const {stdout}=await exec(py.command,[...py.args,'-c','print("ok")']);assert.equal(stdout.trim(),'ok');await assert.rejects(()=>pythonLaunch({executable:path.join(os.tmpdir(),'missing-workbench-python-exe')}),/Python/);
});
test('分享清单完整包含Skill和跨平台入口，明确排除本机数据、凭据和生成结果',async()=>{
 const entries=await distributionEntries();const names=entries.map(e=>e.relative);for(const name of ['start-workbench.cmd','启动工作台-Windows.cmd','登录GPT-Windows.cmd','server/portable-ocr.js','skills/etsy-accessory-images/SKILL.md','.github/workflows/compatibility.yml'])assert.ok(names.includes(name),name);
 assert.ok(names.some(n=>n.startsWith('skills/etsy-accessory-images/assets/style-references/')));assert.ok(names.every(n=>!privatePath(n)));assert.ok(names.every(n=>!n.startsWith('data/')&&!n.startsWith('output/')&&!n.startsWith('node_modules/')));
 for(const n of ['data/workbench.sqlite','output/etsy/result.png','foo/auth.json','.env','.env.local','x/browser-profile/Cookies','node_modules/auth.js'])assert.equal(privatePath(n),true,n);assert.equal(privatePath('.env.example'),false);
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-share-'));try{await mkdir(path.join(dir,'server'));await assert.rejects(()=>distributionEntries(dir),/ENOENT/);}finally{await rm(dir,{recursive:true,force:true});}
});
