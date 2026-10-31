import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {distributionEntries,privatePath,ROOT} from './distribution.mjs';
const entries=await distributionEntries();const exec=promisify(execFile);let tracked=[];
try{const {stdout:top}=await exec('git',['rev-parse','--show-toplevel'],{cwd:ROOT,windowsHide:true});if(path.resolve(top.trim())===ROOT){const {stdout}=await exec('git',['ls-files','-z'],{cwd:ROOT,windowsHide:true});tracked=stdout.split('\0').filter(Boolean);}}catch{}
const allowed=new Set([...entries.map(e=>e.relative),'工程文件清单.json']);const blocked=tracked.filter(file=>privatePath(file)||!allowed.has(file));if(blocked.length)throw new Error('Git已经跟踪本机数据、凭据或不在工程分享清单内的文件，不能直接推送：'+blocked.join('、'));
console.log(`分享检查通过：${entries.length}个允许分发文件。账号、数据库、图片成品、偏好与本机环境均不在工程包内。`);
