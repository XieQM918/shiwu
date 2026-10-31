import {chromium} from 'playwright';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../server/index.js';
import {pythonLaunch,runtimeEnv} from '../server/platform.js';
const py=await pythonLaunch();

const base='http://127.0.0.1:3210';const productId='825459605485';const skuId='5712451054276';
const state=await(await fetch(base+'/api/state')).json();
const summary=state.generationJobs.find(j=>j.productId===productId&&j.skuId===skuId&&j.completed>0);
assert.ok(summary,'必须先有真实生成并登记的成品');
const job=await(await fetch(base+`/api/generation-jobs/${summary.id}`)).json();
const completed=job.candidates.filter(c=>c.status==='completed');
const out=path.join(ROOT,'output/verification');await mkdir(out,{recursive:true});
for(const c of completed){
  const response=await fetch(base+`/api/generation-jobs/${job.id}/images/${c.id}`);assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),c.hash);
}
const zip=await fetch(base+`/api/generation-jobs/${job.id}/download`);assert.equal(zip.status,200);
const zipPath=path.join(out,'etsy-real-sample.zip');await writeFile(zipPath,Buffer.from(await zip.arrayBuffer()));
const checked=await promisify(execFile)(py.command,[...py.args,'-c','import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); m=json.loads(z.read(next(n for n in names if n.endswith("成品清单.json")))); print(json.dumps({"files":len([n for n in names if not n.endswith(".json")]),"completed":len([c for c in m["candidates"] if c["status"]=="completed"])}))',zipPath]);
const report=JSON.parse(checked.stdout);assert.equal(report.files,completed.length);assert.equal(report.completed,completed.length);
const browser=await chromium.launch({...(process.env.WORKBENCH_TEST_BROWSER==='chromium'?{}:{channel:'chrome'}),headless:true});
try{
  const page=await browser.newPage({viewport:{width:1536,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('button',{name:`展开商品${productId}`,exact:true}).click();
  const row=page.locator('.variant-table tbody tr').filter({hasText:skuId});await row.getByRole('button',{name:/查看成品|查看进度/}).click();await page.getByRole('dialog',{name:'Etsy 图片生成'}).waitFor();const picker=page.getByRole('combobox',{name:'生图历史批次'});await picker.waitFor();await picker.selectOption(job.id);
  await page.getByRole('dialog',{name:'Etsy 图片生成'}).waitFor();await page.locator('.generation-candidate.completed').first().waitFor();
  await page.locator('.generation-candidate.completed img').first().evaluate(img=>img.decode());
  await page.screenshot({path:path.join(out,'etsy-generation-live.png')});
  await page.getByRole('button',{name:'放大完整外观 A',exact:true}).click();await page.locator('.lightbox img').evaluate(img=>img.decode());
  await page.screenshot({path:path.join(out,'etsy-generation-live-preview.png')});assert.deepEqual(errors,[]);
}finally{await browser.close();}
await writeFile(path.join(out,'etsy-generation-live.json'),JSON.stringify({at:new Date().toISOString(),jobId:job.id,completed:completed.length,zipFiles:report.files,images:completed.map(c=>({id:c.id,width:c.width,height:c.height,hash:c.hash,reviewedAt:c.reviewedAt}))},null,2));
console.log(`真实联调通过：${completed.length} 张已登记成品可在规格面板预览与放大；下载文件哈希及ZIP清单一致。`);
