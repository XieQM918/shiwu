import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {LocalOCR,ocrRecords} from '../server/ocr.js';
import {extractFields} from '../server/domain.js';
import {modelFile} from '../server/portable-ocr.js';
const root=path.resolve(import.meta.dirname,'..'),fixture=path.join(root,'test/fixtures/brooch-parameter-card.jpg');
test('Windows同一套本机OCR真实读取中文参数、重量和尺寸证据；仅靠元数据也能读图片尺寸',{timeout:120000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-portable-'));const ocr=new LocalOCR(root,dir,{engine:'tesseract'});try{
  const dimensions=await ocr.dimensions(fixture);assert.equal(dimensions.width,750);assert.ok(dimensions.height>1000);assert.equal(ocr.portable.worker,null);
  assert.ok(modelFile('chi_sim').includes('node_modules'));const result=await ocr.recognize(fixture);assert.equal(result.engine,'tesseract-local');assert.ok(result.lines.some(l=>/材质/.test(l.text)));assert.ok(result.lines.every(l=>l.x>=0&&l.y>=0&&l.width>0));
  const fields=extractFields(ocrRecords(result,{id:'real-card',order:1,skuIds:[]},{productTitle:'花朵胸针'}));assert.equal(fields.weight.value,10.7);assert.equal(fields.weight.status,'review');
  // Any axis assignment must be supported by the actual OCR rulers AND the tuple.
  assert.equal(fields.length.value,4.5);assert.equal(fields.width.value,3.5);assert.ok(fields.length.sources.some(s=>s.axisEvidence));assert.equal(fields.length.status,'review');
 }finally{await ocr.close();await rm(dir,{recursive:true,force:true});}
});
test('Windows本机OCR长图分段覆盖底部，保留分段与坐标且不需要联网下载模型',{timeout:120000},async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-portable-long-'));const ocr=new LocalOCR(root,dir,{engine:'tesseract'});try{
  const file=path.join(dir,'长图.png');await sharp({create:{width:750,height:3400,channels:3,background:'white'}}).composite([{input:fixture,top:0,left:0},{input:fixture,top:2300,left:0}]).png().toFile(file);
  const result=await ocr.recognize(file);assert.equal(result.height,3400);assert.ok(result.lines.some(l=>l.segment>0&&/10\.7/.test(l.text)&&l.y>.8));assert.equal(ocr.problem,null);
 }finally{await ocr.close();await rm(dir,{recursive:true,force:true});}
});
