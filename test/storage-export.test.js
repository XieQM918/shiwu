import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {Store} from '../server/db.js';
import {newProduct,extractFields} from '../server/domain.js';
import {workbookBuffer} from '../server/exports.js';

test('重启恢复保留结果，并把未结束的任务改为可手动继续',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiw-test-'));let store=new Store(dir);
  try{const p=newProduct({id:'123',url:'https://detail.1688.com/offer/123.html'});p.status='waiting';p.images=[{id:'image',status:'downloaded'}];store.saveProduct(p);store.saveJob({id:'j',ids:['123'],index:0,status:'waiting',createdAt:new Date().toISOString()});store.close();store=new Store(dir);store.recover();assert.equal(store.job('j').status,'paused');assert.equal(store.product('123').status,'paused');assert.equal(store.product('123').images.length,1);}finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('Excel包含汇总与规格、来源、失败信息且不把文本解析成公式',async()=>{
  const p=newProduct({id:'123',url:'https://detail.1688.com/offer/123.html'});p.title='=HYPERLINK("https://example.com")';p.status='partial';p.fields=extractFields([{text:'长度: 25mm'},{text:'材质: 铜合金',kind:'ocr',imageId:'img1'}]);p.warnings=['详情未加载'];p.images=[{id:'img1',skuIds:['sku1'],status:'downloaded'},{id:'img2',skuIds:[],status:'failed'}];p.variants=[{id:'sku1',label:'小号',fields:p.fields}];
  const buffer=await workbookBuffer([p]);const w=new ExcelJS.Workbook();await w.xlsx.load(buffer);assert.deepEqual(w.worksheets.map(s=>s.name),['商品汇总','规格明细','Etsy 上架文案']);assert.equal(w.worksheets[0].getCell('B2').value,p.title);assert.equal(w.worksheets[0].getCell('E2').value,2.5);assert.equal(w.worksheets[1].rowCount,2);assert.ok(w.worksheets[0].getRow(2).values.some(v=>String(v).includes('图片识别:img1')));assert.ok(w.worksheets[0].getRow(2).values.includes('详情未加载'));
});
