import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,readFile,rm,access,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cleanDownloadFiles} from '../server/download-cleaner.js';
import {runtimeEnv,findExecutable} from '../server/platform.js';
const toolEnv=runtimeEnv();const exiftool=findExecutable('exiftool',{env:toolEnv});
const exec=promisify(execFile);

test('下载使用Skill清理来源字段，原文件不变，并保留方向',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-metadata-test-'));let batch;
 try{const file=path.join(dir,'source.jpg');await copyFile(new URL('./fixtures/brooch-parameter-card.jpg',import.meta.url),file);
 await exec(exiftool,['-overwrite_original','-Software=AI fixture','-ImageDescription=test prompt','-GPSLatitude=31.2','-GPSLongitude=121.5','-Orientation#=6',file]);
 const before=await readFile(file);batch=await cleanDownloadFiles([{file,name:'sample.jpg'}]);assert.equal(batch.report.success,1);assert.equal(batch.report.failed,0);assert.equal(batch.report.status,'处理完成');assert.ok(batch.files[0].file);
 const {stdout}=await exec(exiftool,['-j','-Software','-ImageDescription','-GPS:all','-Orientation#',batch.files[0].file]);const tags=JSON.parse(stdout)[0];assert.equal(tags.Software,undefined);assert.equal(tags.ImageDescription,undefined);assert.equal(tags.GPSLatitude,undefined);assert.equal(tags.Orientation,6);assert.deepEqual(await readFile(file),before);
 const cleaned=batch.files[0].file;await batch.cleanup();batch=null;await assert.rejects(()=>access(cleaned));
 }finally{await batch?.cleanup();await rm(dir,{recursive:true,force:true});}
});

test('不支持或损坏图片明确列为跳过/失败，不降级返回原始文件',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-metadata-error-'));let batch;
 try{const file=path.join(dir,'fake.png');await writeFile(file,'not an image');batch=await cleanDownloadFiles([{file,name:'bad.png'}]);assert.equal(batch.files[0].file,null);assert.ok(batch.report.failed+batch.report.skipped>0);
 }finally{await batch?.cleanup();await rm(dir,{recursive:true,force:true});}
});
