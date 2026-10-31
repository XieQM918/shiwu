import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {fileURLToPath} from 'node:url';
import {validateListing} from '../server/listing.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.WORKBENCH_URL||'http://127.0.0.1:3210';
const read=async url=>{const r=await fetch(base+url);if(!r.ok)throw new Error('读取失败：'+url);return r.json();};
const state=await read('/api/state');const results=[];
for(const p of state.products){
  const detail=await read(`/api/products/${p.id}/listing`);assert.ok(detail.current.content.title,`${p.id} 缺少采用标题`);assert.equal(detail.current.content.tags.length,13);
  for(const field of ['title','description','tags']){const v=detail.versions.find(v=>v.id===detail.current.fields[field]);assert.ok(v,`${p.id} 缺少${field}版本`);validateListing(v.content,v.snapshot);}
  if(p.id==='730468849400'){assert.match(detail.current.content.title,/stud or clip-on/i);assert.match(detail.current.content.description,/for pierced ears/i);assert.match(detail.current.content.description,/for non-pierced ears/i);}
  results.push({productId:p.id,...detail.current,versions:detail.versions.map(v=>({id:v.id,jobId:v.jobId,kind:v.kind,createdAt:v.createdAt,rulesVersion:v.snapshot.rulesVersion,referenceVersion:v.snapshot.referenceVersion,refs:v.snapshot.refs.map(r=>({imageId:r.imageId,skuIds:r.skuIds,hash:r.hash}))}))});
}
const response=await fetch(base+'/api/export/excel?ids='+results.map(r=>r.productId).join(','));assert.equal(response.status,200);const buffer=Buffer.from(await response.arrayBuffer());const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);
assert.deepEqual(book.worksheets.map(s=>s.name),['商品汇总','规格明细','Etsy 上架文案']);const sheet=book.getWorksheet('Etsy 上架文案');assert.equal(sheet.rowCount,results.length+1);
for(let i=2;i<=sheet.rowCount;i++){const row=sheet.getRow(i);const expected=results.find(r=>r.productId===row.getCell(1).value);assert.ok(expected);assert.equal(row.getCell(2).value,expected.content.title);assert.equal(row.getCell(3).value,expected.content.description);assert.equal(row.getCell(4).value,expected.content.tags.join(', '));assert.equal(row.getCell(6).value,expected.fields.title);}
const review=await read('/api/review');const directory=path.join(root,'output/verification');await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,'etsy-listings-live.xlsx'),buffer);await writeFile(path.join(directory,'etsy-listings-live.json'),JSON.stringify({verifiedAt:new Date().toISOString(),products:results,review:{version:review.current.version,pending:review.events.filter(e=>e.reviewStatus==='pending').length,legacyPreferences:review.legacy.length},checks:['真实Codex生成','已采用版本与Excel逐字段一致','标题140字符上限','每商品13个去重标签且各不超过20字符','耳针与耳夹区分','来源快照和规则版本保留']},null,2));
const markdown=results.map(r=>`## 商品 ${r.productId}\n\n${r.content.title}\n\n${r.content.description}\n\n建议标签：${r.content.tags.join(', ')}\n\n中文核对：\n\n${r.notesZh.map(t=>'- '+t).join('\n')}\n`).join('\n');await writeFile(path.join(directory,'etsy-listings-samples.md'),'# 实际生成的 Etsy 上架文案\n\n'+markdown);
console.log(`已验证${results.length}个真实商品；Excel与采用版本一致，样例保存到 output/verification/etsy-listings-live.xlsx。规则版本 v${review.current.version}，未自动批准测试偏好。`);
