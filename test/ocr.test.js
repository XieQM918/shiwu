import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalOCR,ocrRecords} from '../server/ocr.js';
import {extractFields} from '../server/domain.js';

test('macOS Vision 实际识别中文参数，长图分段后仍可读取末尾信息',{skip:process.platform!=='darwin',timeout:90000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-ocr-'));let browser;
  try{
    browser=await chromium.launch({...(process.env.WORKBENCH_TEST_BROWSER==='chromium'?{}:{channel:'chrome'}),headless:true});const page=await browser.newPage({viewport:{width:800,height:3100},deviceScaleFactor:1});
    await page.setContent('<html><body style="margin:0;background:white;color:black;font-family:PingFang SC,sans-serif;font-size:44px"><div style="padding:60px"><div>长度：25mm</div><div style="margin-top:25px">材质：铜合金</div></div><div style="position:absolute;top:2760px;left:60px">净重：12g</div></body></html>');
    const file=path.join(dir,'long-image.png');await page.screenshot({path:file,fullPage:true});
    const ocr=new LocalOCR(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir);const recognized=await ocr.recognize(file);
    assert.equal(recognized.height,3100);assert.ok(recognized.lines.some(l=>l.segment>0));
    const records=ocrRecords(recognized,{id:'img',order:1,skuIds:[]});const fields=extractFields(records);
    assert.equal(fields.length.value,2.5);assert.equal(fields.material.value,'铜合金');assert.equal(fields.weight.value,12);assert.equal(fields.length.status,'review');
  }finally{await browser?.close();await rm(dir,{recursive:true,force:true});}
});
test('真实胸针图片本机端到端：检测纵横尺寸标注线并提取重量',{skip:process.platform!=='darwin',timeout:90000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-ruler-'));
  try{
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    const ocr=new LocalOCR(root,dir);const result=await ocr.recognize(path.join(root,'test','fixtures','brooch-parameter-card.jpg'));
    assert.ok(result.lines.some(l=>l.rulerAxis==='vertical'&&l.text==='4.5cm'));assert.ok(result.lines.some(l=>l.rulerAxis==='horizontal'&&l.text.includes('3.5cm')));
    const fields=extractFields(ocrRecords(result,{id:'real-card',order:9,skuIds:[]},{productTitle:'花朵胸针'}));
    assert.equal(fields.length.value,4.5);assert.equal(fields.width.value,3.5);assert.equal(fields.weight.value,10.7);
  }finally{await rm(dir,{recursive:true,force:true});}
});
