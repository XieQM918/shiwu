import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ocrRecords} from '../server/ocr.js';
import {extractFields} from '../server/domain.js';
const fixture=new URL('./fixtures/brooch-parameter-card-ocr.json',import.meta.url);

test('实际胸针参数图：纵横标注线与尺寸原文互证，识别长4.5、宽3.5和重量10.7',async()=>{
  const result=JSON.parse(await readFile(fixture,'utf8'));
  const records=ocrRecords(result,{id:'parameter-image',order:9,skuIds:[]},{productTitle:'韩版珐琅彩绘花朵胸针'});
  const fields=extractFields([{text:'重量: 30g',kind:'page'},...records]);
  assert.equal(fields.length.value,4.5);assert.equal(fields.width.value,3.5);assert.equal(fields.height.status,'missing');assert.equal(fields.weight.value,10.7);assert.equal(fields.material.value,'优质环保铜');assert.equal(fields.length.status,'review');assert.ok(fields.length.sources.some(s=>s.axisEvidence?.axis==='vertical'));assert.ok(fields.weight.sources.some(s=>s.text==='重量: 30g'));assert.ok(fields.weight.sources.some(s=>s.imageId==='parameter-image'));
});
test('缺少标注线、标注值不一致或不属于平面胸针时，不猜测长宽方向',async()=>{
  const result=JSON.parse(await readFile(fixture,'utf8'));
  const image={id:'parameter-image',order:1,skuIds:[]};
  const withoutLines={...result,lines:result.lines.map(({rulerAxis,rulerScore,...line})=>line)};
  const missing=extractFields(ocrRecords(withoutLines,image,{productTitle:'胸针'}));assert.equal(missing.length.value,null);assert.equal(missing.length.status,'review');
  const generic=extractFields(ocrRecords(result,image,{productTitle:'收纳箱'}));assert.equal(generic.length.value,null);
  const mismatch={...result,lines:result.lines.map(line=>line.rulerAxis==='vertical'?{...line,text:'8.5cm'}:line)};
  assert.equal(extractFields(ocrRecords(mismatch,image,{productTitle:'胸针'})).length.value,null);
});
