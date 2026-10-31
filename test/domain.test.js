import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLinks,extractFields,preserveManual,summarizeFields,emptyFields} from '../server/domain.js';

test('真实链接规范化、Markdown/转义清理、去重与恶意域名拦截',()=>{
  const p=parseLinks('https\\://detail.1688.com/offer/825459605485.html\n[商品](https://detail.1688.com/offer/674794282576.html)\nhttps://detail.1688.com/offer/825459605485.html?x=1\nhttps://detail.1688.com.evil.test/offer/123.html\nfile:///etc/passwd\nhttps://detail.1688.com:99/offer/123.html');
  assert.deepEqual(p.valid.map(l=>l.id),['825459605485','674794282576']);assert.equal(p.duplicates,1);assert.equal(p.invalid.length,3);
  assert.equal(parseLinks(Array.from({length:31},(_,i)=>`https://detail.1688.com/offer/${1000+i}.html`).join('\n')).tooMany,true);
});
test('尺寸与重量单位换算，包装与产品分离',()=>{
  const f=extractFields([{text:'长度: 25mm'},{text:'宽度: 2cm'},{text:'高度: 0.01m'},{text:'净重: 0.012kg'},{text:'材质: 铜合金'},{text:'包装长×宽×高: 10×8×2cm'},{text:'毛重: 20g'}]);
  assert.equal(f.length.value,2.5);assert.equal(f.width.value,2);assert.equal(f.height.value,1);assert.equal(f.weight.value,12);assert.equal(f.material.value,'铜合金');
  assert.equal(f.packageLength.value,10);assert.equal(f.packageWidth.value,8);assert.equal(f.packageHeight.value,2);assert.equal(f.packageWeight.value,20);assert.equal(f.length.status,'found');
  const mixed=extractFields([{text:'产品长: 2cm 包装长: 10cm 净重: 5g 包装重量: 12g'}]);assert.equal(mixed.length.value,2);assert.equal(mixed.packageLength.value,10);assert.equal(mixed.weight.value,5);assert.equal(mixed.packageWeight.value,12);
});
test('未知方向、范围、成套重量、OCR与来源冲突均不能被自动确认',()=>{
  const unknown=extractFields([{text:'尺寸: 3×2cm'}]);assert.equal(unknown.length.value,null);assert.equal(unknown.length.status,'review');assert.equal(unknown.height.status,'review');
  const range=extractFields([{text:'长度: 3-5cm'}]);assert.notEqual(range.length.status,'found');
  const pair=extractFields([{text:'每对净重: 8g'}]);assert.equal(pair.weight.status,'review');
  assert.equal(extractFields([{text:'重量: 8g'}]).weight.status,'review');
  const ocr=extractFields([{text:'材质: 铜',kind:'ocr',imageId:'img'}]);assert.equal(ocr.material.status,'review');assert.equal(ocr.material.sources[0].imageId,'img');
  const authoritative=extractFields([{text:'长度: 25mm',kind:'page',path:'已登录参数表'},{text:'长度: 8cm',kind:'ocr',imageId:'img'}]);assert.equal(authoritative.length.value,2.5);assert.equal(authoritative.length.status,'found');assert.equal(authoritative.length.sources.length,2);
  const conflict=extractFields([{text:'长度: 2cm'},{text:'长度: 3cm'}]);assert.equal(conflict.length.value,null);assert.equal(conflict.length.status,'review');
  const model=extractFields([{text:'规格: 白K单只 4165'}]);assert.equal(model.length.status,'missing');assert.equal(model.height.status,'missing');
});
test('多规格汇总与人工修改保留',()=>{
  const a=extractFields([{text:'长度: 2cm'}]),b=extractFields([{text:'长度: 3cm'}]);
  const summarized=summarizeFields(emptyFields(),[{fields:a},{fields:b}]);assert.equal(summarized.length.status,'variants');assert.equal(summarized.length.value,null);
  const mixed=summarizeFields(emptyFields(),[{fields:a},{fields:emptyFields()}]);assert.equal(mixed.length.status,'variants');
  a.length={...a.length,status:'manual',value:2.7};const preserved=preserveManual(b,a);assert.equal(preserved.length.value,2.7);assert.equal(preserved.length.status,'manual');
  const common=summarizeFields(emptyFields(),[{fields:a}]);assert.equal(common.length.value,2.7);assert.equal(common.length.status,'found');
});
