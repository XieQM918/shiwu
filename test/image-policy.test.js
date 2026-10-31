import test from 'node:test';
import assert from 'node:assert/strict';
import {originalImageUrl,normalizeImages} from '../server/image-policy.js';

test('所有已遇到的缩略后缀和尺寸变换指向原文件，保留原始签名和水印',()=>{
  const original='https://cbu01.alicdn.com/img/ibank/photo.jpg';
  for(const suffix of ['_b.jpg','_sum.jpg','_s.jpg','_220x220.jpg','_1200x1200Q90.jpg_.webp','_.webp','.webp'])assert.equal(originalImageUrl(original+suffix),original,suffix);
  assert.equal(originalImageUrl(original+'?x-oss-process=image/resize,w_220/quality,q_70&signature=keep'),original+'?signature=keep');
  const watermark=new URL(originalImageUrl(original+'?x-oss-process=image/resize,w_220/watermark,text_abc&signature=keep'));assert.equal(watermark.searchParams.get('x-oss-process'),'image/watermark,text_abc');assert.equal(watermark.searchParams.get('signature'),'keep');
  assert.equal(originalImageUrl('https://evil.test/photo.jpg'),null);
});
test('同一原图的多种缩略地址合并，保留分类、来源、旧图片引用和规格关系',()=>{
  const images=normalizeImages([{id:'old1',url:'https://cbu01.alicdn.com/img/photo.jpg_b.jpg',categories:['main'],skuIds:['sku1']},{id:'old2',url:'https://cbu01.alicdn.com/img/photo.jpg',categories:['sku'],skuIds:['sku2']}]);
  assert.equal(images.length,1);assert.deepEqual(images[0].categories,['main','sku']);assert.deepEqual(images[0].skuIds,['sku1','sku2']);assert.deepEqual(images[0].legacyIds,['old1','old2']);assert.equal(images[0].candidateUrls[0],'https://cbu01.alicdn.com/img/photo.jpg');assert.ok(images[0].candidateUrls.includes('https://cbu01.alicdn.com/img/photo.jpg_b.jpg'));
});
