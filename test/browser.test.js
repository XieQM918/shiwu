import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {collectSnapshot} from '../server/page-extractor.js';
import {extractFields} from '../server/domain.js';
let browser,page;
before(async()=>{browser=await chromium.launch({...(process.env.WORKBENCH_TEST_BROWSER==='chromium'?{}:{channel:'chrome'}),headless:true});page=await browser.newPage();await page.route('**/*',route=>route.abort());});
after(async()=>{await browser?.close();});

test('结构化商品数据不混入推荐商品，SKU及图片关联不丢失',async()=>{
  await page.setContent('<h1>测试铜合金胸针</h1><div class="product-attribute"><div class="attribute-item">材质 铜合金</div></div>');
  await page.evaluate(()=>{window.__INIT_DATA={offerId:'825459605485',subject:'测试商品',offerImgList:['https://cbu01.alicdn.com/img/ibank/main.jpg','https://cbu01.alicdn.com/img/ibank/main.jpg'],description:'<img src="https://cbu01.alicdn.com/img/ibank/detail.jpg">',skuInfoMap:{'小号':{skuId:'s1',specAttrs:'小号',imageUrl:'https://cbu01.alicdn.com/img/ibank/small.jpg',material:'铜合金'},'大号':{skuId:'s2',specAttrs:'大号',imageUrl:'https://cbu01.alicdn.com/img/ibank/large.jpg'}},recommendOffers:[{offerId:'999',imageList:['https://cbu01.alicdn.com/img/ibank/unrelated.jpg']}]};});
  const s=await page.evaluate(collectSnapshot,{offerId:'825459605485'});
  assert.equal(s.title,'测试铜合金胸针');assert.equal(s.images.length,4);assert.equal(s.variants.length,2);assert.equal(s.variantMode,'sku');assert.ok(s.images.find(i=>i.url.includes('small.jpg')).skuIds.includes('s1'));assert.ok(s.records.some(r=>r.text==='材质: 铜合金'));assert.ok(!s.images.some(i=>i.url.includes('unrelated')));
});
test('验证码页面与失效商品正确识别，不把HTTP正常当作采集成功',async()=>{
  await page.evaluate(()=>{delete window.__INIT_DATA;});
  await page.setContent('<title>安全验证</title><p>请按住滑块，完成访问验证</p>');let s=await page.evaluate(collectSnapshot,{offerId:'123'});assert.equal(s.verification,true);assert.equal(s.images.length,0);assert.equal(s.title,'');
  await page.setContent('<title>1688</title><p>您访问的商品不存在</p>');s=await page.evaluate(collectSnapshot,{offerId:'123'});assert.equal(s.unavailable,true);
});
test('只获得规格选项时不制造SKU组合；商品DOM排除评价与推荐图片',async()=>{
  await page.setContent('<h1>测试耳夹</h1><div class="od-gallery"><img src="https://cbu01.alicdn.com/img/main.jpg"></div><div class="detail-description"><img src="https://cbu01.alicdn.com/img/detail.jpg"><div class="recommend"><img src="https://cbu01.alicdn.com/img/recommend.jpg"></div></div>');
  const payloads=[{offerId:'123',skuProps:[{prop:'颜色',value:[{name:'金色',imageUrl:'https://cbu01.alicdn.com/img/gold.jpg'},{name:'银色',imageUrl:'https://cbu01.alicdn.com/img/silver.jpg'}]},{prop:'尺寸',value:[{name:'大号'},{name:'小号'}]}]}];
  const s=await page.evaluate(collectSnapshot,{offerId:'123',payloads});assert.equal(s.variantMode,'options');assert.equal(s.variants.length,4);assert.ok(!s.images.some(i=>i.url.includes('recommend.jpg')));assert.equal(s.images.filter(i=>i.categories.includes('main')).length,1);assert.equal(s.images.filter(i=>i.categories.includes('detail')).length,1);
});
test('真实页面回归：店名不作商品标题、缩略图还原、规格图映射到SKU',async()=>{
  await page.setContent('<title>几何线条耳骨夹-阿里巴巴</title><h1>义乌市测试电子商务有限公司</h1><div class="product-attribute"><li>材质 合金</li></div>');
  const payloads=[{data:{skuSelectorBizModel:{skuProps:[{prop:'颜色',fid:3216,value:[{name:'金色单只 4165',imageUrl:'https://cbu01.alicdn.com/img/gold.jpg_sum.jpg'}]}],skuInfoMap:{'金色单只 4165':{skuId:6289441918623,specId:'hash',specAttrs:'金色单只 4165'}}}}}];
  const s=await page.evaluate(collectSnapshot,{offerId:'1073738926018',payloads});assert.equal(s.title,'几何线条耳骨夹');assert.equal(s.images[0].url,'https://cbu01.alicdn.com/img/gold.jpg');assert.ok(s.images[0].skuIds.includes('6289441918623'));assert.equal(s.variants.length,1);
});
test('登录后参数矩阵按SKU与表头单位读取，包装列不会混进商品尺寸',async()=>{
  await page.setContent('<h1>参数测试商品</h1><table aria-label="商品参数"><thead><tr><th>规格</th><th>产品长(mm)</th><th>宽(cm)</th><th>高(cm)</th><th>净重(g)</th><th>材质</th><th>包装长(cm)</th></tr></thead><tbody><tr><td>金色</td><td>25</td><td>1.2</td><td>0.5</td><td>8</td><td>铜</td><td>10</td></tr><tr><td>银色</td><td>30</td><td>1.4</td><td>0.6</td><td>9</td><td>铜</td><td>11</td></tr></tbody></table>');
  const payloads=[{skuInfoMap:{金色:{skuId:'s1',specAttrs:'金色'},银色:{skuId:'s2',specAttrs:'银色'}}}];
  const s=await page.evaluate(collectSnapshot,{offerId:'123',payloads});
  const gold=extractFields(s.records.filter(r=>r.skuId==='s1'));const silver=extractFields(s.records.filter(r=>r.skuId==='s2'));
  assert.equal(gold.length.value,2.5);assert.equal(gold.width.value,1.2);assert.equal(gold.height.value,.5);assert.equal(gold.weight.value,8);assert.equal(gold.material.value,'铜');assert.equal(gold.packageLength.value,10);assert.equal(silver.length.value,3);assert.equal(gold.length.status,'found');assert.equal(s.parameterTables.length,1);
});
test('无表头的两列参数与未知规格保留明确来源，不把未知规格填成通用值',async()=>{
  await page.setContent('<h1>参数测试商品</h1><table><tr><td>材质</td><td>铜合金</td></tr><tr><td>长度(mm)</td><td>25</td></tr></table><table><thead><tr><th>规格</th><th>长(cm)</th></tr></thead><tbody><tr><td>未知款式</td><td>8</td></tr></tbody></table>');
  const s=await page.evaluate(collectSnapshot,{offerId:'123'});const f=extractFields(s.records.filter(r=>!r.unassigned));assert.equal(f.material.value,'铜合金');assert.equal(f.length.value,2.5);assert.ok(s.records.some(r=>r.unassigned&&r.skuLabel==='未知款式'));
});
test('1688真实详情组件：读取独立ShadowRoot中的懒加载详情图，排除推荐链接',async()=>{
  await page.setContent('<h1>测试胸针</h1><div id="description"><div class="module-od-product-description"><v-detail-e class="html-description"></v-detail-e></div></div>');
  await page.evaluate(()=>{
    const root=document.querySelector('v-detail-e').attachShadow({mode:'open'});
    root.innerHTML='<div id="detail"><img loading="lazy" src="https://cbu01.alicdn.com/img/ibank/parameter.jpg?__r__=1723"><nested-detail></nested-detail><a href="https://detail.1688.com/offer/999999999999.html"><img src="https://cbu01.alicdn.com/img/ibank/recommended.jpg"></a></div>';
    root.querySelector('nested-detail').attachShadow({mode:'open'}).innerHTML='<img data-src="https://cbu01.alicdn.com/img/ibank/extra.jpg">';
  });
  const snapshot=await page.evaluate(collectSnapshot,{offerId:'825459605485'});
  assert.equal(snapshot.images.filter(i=>i.categories.includes('detail')).length,2);assert.ok(snapshot.detailStats.shadowRoots>=2);assert.ok(!snapshot.images.some(i=>i.url.includes('recommended')));assert.ok(!snapshot.warnings.some(w=>w.startsWith('未获取到详情图')));
});
