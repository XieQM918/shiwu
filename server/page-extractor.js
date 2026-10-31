// Runs inside the product page. Do not execute scripts found in page data.
export function collectSnapshot({ offerId, payloads = [] }) {
  const titleText = document.title || '';
  const bodyText = (document.body?.innerText || '').slice(0, 180000);
  const result = { title: '', supplier: '', images: [], variants: [], records: [], parameterTables:[], warnings: [], detailUrls: [], pageUrl: location.href, verification: false };
  const text = v => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  const cleanText = s => String(s || '').replace(/\s+/g, ' ').trim();
  const seenImages = new Map(), seenRecords = new Set(), seenObjects = new WeakSet(), seenVariants = new Map();
  function imageUrl(v) {
    let s = text(v);
    if (s.startsWith('//')) s = 'https:' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (!/(^|\.)(alicdn\.com|1688\.com|alibaba\.com)$/.test(u.hostname)) return null;
      if (!/\.(?:jpe?g|png|webp|gif|avif)(?:[_.!?]|$)/i.test(u.pathname)) return null;
      // AliCDN thumbnail transformations follow the original image extension.
      u.pathname = u.pathname.replace(/(\.(?:jpg|jpeg|png|webp|gif))_(?:\d+x\d+[^/]*|q\d+[^/]*|\.webp)$/i, '$1');
      u.pathname = u.pathname.replace(/(\.(?:jpg|jpeg|png|webp|gif))_(?:sum|b|s|m|small|middle|big)\.(?:jpg|jpeg|png|webp)(?:_\.webp)?$/i,'$1');
      return u.href;
    } catch { return null; }
  }
  function addImage(v, category, skuId, source) {
    const url = imageUrl(v); if (!url) return;
    let image = seenImages.get(url);
    if (!image) { image = { url, sourceUrls:[], categories: [], skuIds: [], order: result.images.length + 1, source }; result.images.push(image); seenImages.set(url, image); }
    const raw=text(v);if(raw&&!image.sourceUrls.includes(raw))image.sourceUrls.push(raw);
    if (!image.categories.includes(category)) image.categories.push(category);
    if (skuId && !image.skuIds.includes(skuId)) image.skuIds.push(skuId);
  }
  function addRecord(s, path, skuId, metadata={}) {
    s = cleanText(s);
    s = s.replace(/^(材质|材料|重量|净重|毛重|单重|尺寸|长度|宽度|高度|包装重量)\s+(?![:：])/, '$1: ');
    if (!s || s.length > 220 || !/(尺寸|材质|材料|长度|宽度|高度|[长宽高]\s*[:：\d]|重量|单重|净重|毛重|包装|规格)/.test(s)) return;
    const key = `${skuId || ''}:${s}`; if (seenRecords.has(key)) return;
    seenRecords.add(key); result.records.push({ text: s, kind: 'page', path, skuId, ...metadata });
  }
  function imagesIn(value, category, skuId, source, depth = 0) {
    if (depth > 7 || value == null) return;
    if (typeof value === 'string') {
      addImage(value, category, skuId, source);
      if (/<img/i.test(value)) {
        const doc = new DOMParser().parseFromString(value, 'text/html');
        doc.querySelectorAll('img').forEach(img => { for (const k of ['data-src','data-lazy-src','data-original','src']) if (img.getAttribute(k)) { addImage(img.getAttribute(k), category, skuId, source); break; } });
      }
    } else if (Array.isArray(value)) value.forEach(v => imagesIn(v, category, skuId, source, depth + 1));
    else if (typeof value === 'object') Object.entries(value).forEach(([k,v]) => { if (/url|image|img|pic|src|original|full/i.test(k)) imagesIn(v, category, skuId, source, depth + 1); });
  }
  function variant(id, label, props, path) {
    id = String(id); if (!id || id === 'undefined') return;
    const old = seenVariants.get(id);
    if (old) { if (label && (!old.label || old.label === old.id)) old.label = label; return; }
    const v = { id, label: label || id, props: props || {}, path };
    seenVariants.set(id, v); result.variants.push(v);
    if (label) addRecord(`规格: ${label}`, path, id);
  }
  function walk(value, path = '页面数据', depth = 0, skuId = null) {
    if (depth > 14 || !value || typeof value !== 'object' || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) { value.slice(0, 1500).forEach((v,i) => walk(v, `${path}[${i}]`, depth + 1, skuId)); return; }
    // Avoid collecting recommendation cards embedded in the same page payload.
    const ownId = value.offerId ?? value.itemId ?? value.productId;
    if (ownId != null && /^\d{8,}$/.test(String(ownId)) && String(ownId) !== offerId) return;
    const entries = Object.entries(value);
    const attrName = text(value.attributeName || value.attrName || value.propertyName || value.name || value.key);
    const attrVal = text(value.attributeValue || value.attrValue || value.propertyValue || value.value);
    if (attrName && attrVal) addRecord(`${attrName}: ${attrVal}`, path, skuId);
    for (const [k,v] of entries) {
      const p = `${path}.${k}`;
      if (/recommend|related|similar|hotOffer|crossSell|shopOffer|shopLogo|sellerLogo|review|comment|feedback|evaluate|video/i.test(k)) continue;
      if (!result.title && /^(subject|offerTitle|productTitle|productName|itemTitle)$/.test(k) && text(v)) result.title = text(v);
      if (!result.supplier && /^(companyName|supplierName|sellerCompanyName)$/.test(k) && text(v)) result.supplier = text(v);
      if (/^(descUrl|descriptionUrl|detailUrl|detailDescUrl)$/.test(k) && typeof v==='string') {
        try { const u=new URL(v.startsWith('//')?'https:'+v:v);if(['https:','http:'].includes(u.protocol)&&/(^|\.)(1688\.com|alicdn\.com|alibaba\.com)$/.test(u.hostname)&&!u.pathname.includes('/offer/')&&!result.detailUrls.includes(u.href))result.detailUrls.push(u.href); }catch{}
      }
      if (/^(skuInfoMap|skuMap)$/.test(k) && v && typeof v === 'object') {
        for (const [key, row] of Object.entries(v)) {
          if (!row || typeof row !== 'object') continue;
          const id = String(row.skuId || row.id || key);
          const label = text(row.specAttrs || row.skuName || row.specName || row.specId || key);
          variant(id, label, row, `${p}.${key}`);
          walk(row, `${p}.${key}`, depth + 1, id);
          imagesIn(row.imageUrl || row.skuImageUrl || row.image, 'sku', id, p);
        }
      } else if (/^(skuInfos|skuList|skuProducts|skuItems)$/.test(k) && Array.isArray(v)) {
        v.forEach((row,i) => { if (row && typeof row === 'object') { const id = String(row.skuId || row.id || `sku-${i}`); variant(id,text(row.skuName || row.specAttrs || row.specName),row,p); walk(row,p,depth+1,id); } });
      } else if (/^(skuProps|saleProps|specProps)$/.test(k) && Array.isArray(v)) {
        // Collect value images separately; do not manufacture SKU combinations.
        v.forEach(prop => {
          const values = prop.value || prop.values || prop.propValues || [];
          if (!Array.isArray(values)) return;
          values.forEach(val => { if (!val || typeof val !== 'object') return; const label = [text(prop.prop || prop.name || prop.propName), text(val.name || val.value || val.valueName)].filter(Boolean).join(': '); const id = `prop:${text(prop.fid || prop.propId || prop.id || prop.prop || prop.name)}:${text(val.vid || val.valueId || val.id || val.name)}`; variant(id,label,val,p); imagesIn(val,'sku',id,p); });
        });
        walk(v,p,depth+1);
      } else if (/^(offerImgList|offerImageList|mainImages|mainImage|mainImageUrl|imageList|imageUrls|imageUrlList|gallery|offerImages|productImages|galleryImages|pictureList)$/.test(k)) imagesIn(v,skuId?'sku':/description|descImages|detailContent|detailDesc/i.test(path)?'detail':'main',skuId,p);
      else if (/^(images|imageUrl|picUrl|pictureUrl|originalImageUrl)$/.test(k) && !skuId && /gallery|picture|offerBaseInfo|imageModel|carousel/i.test(path)) imagesIn(v,'main',null,p);
      else if (/^(detailImages|descImages|descriptionImages|descImageList|descImgList|description|detailHtml|detailContent|descriptionHtml|detailDesc)$/.test(k)) { imagesIn(v,'detail',null,p); if (typeof v === 'string') { const doc = new DOMParser().parseFromString(v,'text/html'); doc.body.innerText?.split(/\n/).forEach(s => addRecord(s,p)); } }
      else if (skuId && /image|img|pic/i.test(k)) imagesIn(v,'sku',skuId,p);
      if (/^(material|材质|材料|重量|净重|毛重|包装重量|长度|宽度|高度|尺寸)$/.test(k) && text(v)) addRecord(`${k === 'material' ? '材质' : k}: ${text(v)}`,p,skuId);
      if (/^(length|width|height|netWeight|weight|grossWeight)$/.test(k) && text(v)) {
        const unit = text(value[`${k}Unit`] || (/weight/i.test(k) ? value.weightUnit : value.dimensionUnit || value.lengthUnit));
        if (unit || /\d\s*(?:mm|cm|kg|mg|g|克|厘米|毫米|千克)$/i.test(text(v))) {
          const label = {length:'长度',width:'宽度',height:'高度',netWeight:'净重',weight:'重量',grossWeight:'毛重'}[k];
          addRecord(`${/package|shipping|packing/i.test(path) ? '包装' : ''}${label}: ${text(v)}${unit}`,p,skuId);
        }
      }
      walk(v,p,depth+1,skuId);
    }
  }
  const globals = ['__INIT_DATA','__INIT_DATA__','__INITIAL_STATE__','__GLOBAL_DATA','__GLOBAL_DATA__','__GLOBAL_STORE__','__STORE__','__ICE_APP_DATA__','__NEXT_DATA__'];
  for (const key of globals) { try { if (window[key]) walk(window[key],key); } catch {} }
  document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach(s => { if (s.textContent.length < 4000000) { try { walk(JSON.parse(s.textContent),'页面JSON'); } catch {} } });
  payloads.forEach((p,i) => walk(p,`详情响应[${i}]`));

  const badContainer = el => el.closest('[class*="recommend" i],[class*="related" i],[class*="comment" i],[class*="review" i],[class*="feedback" i],[class*="evaluate" i],[class*="shop-offer" i],[class*="hot-sale" i]');
  const first = selectors => { for (const selector of selectors) { const el = document.querySelector(selector); if (el && !badContainer(el)) return el; } return null; };
  const heading = first(['[class*="title-text"]','[class*="offer-title"]','[class*="title-content"]']);
  if (heading && !/公司$/.test(cleanText(heading.textContent))) result.title = cleanText(heading.textContent);
  if (!heading) { const h1=first(['h1']); if(h1 && !/公司$/.test(cleanText(h1.textContent)))result.title=cleanText(h1.textContent); }
  if (!result.title && !/验证|登录|安全|error|captcha/i.test(titleText)) result.title = titleText.replace(/[-_\s]*(阿里巴巴|1688).*$/,'').trim();
  if (!result.title) { const h1=first(['h1']); if(h1 && !/公司$/.test(cleanText(h1.textContent)))result.title=cleanText(h1.textContent); }
  const supplier = first(['[class*="company-name"]','[class*="companyName"]','[class*="shop-name"]']);
  if (supplier) result.supplier = cleanText(supplier.textContent);
  const roots = document.querySelectorAll('[class*="od-gallery"],[class*="main-image"],[class*="mainImage"],[class*="gallery"],[class*="detail-gallery"],[class*="sku"],[class*="Sku"],#desc-lazyload-container,#offer-description,#mod-detail-description,[class*="detail-description"],[class*="detailDescription"],[class*="description-content"],[class*="detail-content"],[class*="detailContent"],[class*="detail-attribute"],[class*="product-attribute"],[class*="offer-attr"],[class*="od-pc-attribute"],[class*="od-pc-offer-detail"],[class*="detail-parameter"],[class*="product-parameter"],[class*="od-pc-offer-description"]');
  roots.forEach(root => {
    if (badContainer(root)) return;
    const marker = `${root.id} ${root.className}`;
    const category = /sku/i.test(marker) ? 'sku' : /gallery|main.?image/i.test(marker) ? 'main' : 'detail';
    root.querySelectorAll('img').forEach(img => {
      if (badContainer(img)) return;
      const hints=[img.getAttribute('data-original'),img.getAttribute('data-src'),img.getAttribute('data-lazy-src'),img.getAttribute('src')].filter(Boolean).join(' ');
      if (img.naturalWidth > 0 && (img.naturalWidth < 80 || img.naturalHeight < 80) && !hints.includes('/ibank/')) return;
      let skuId;
      if (category === 'sku') {
        const parent = img.closest('[data-sku-id],[data-skuid],[data-value],[title]');
        const label = cleanText(parent?.getAttribute('title') || img.alt || '');
        const explicit = parent?.getAttribute('data-sku-id') || parent?.getAttribute('data-skuid');
        if (explicit) { skuId = explicit; variant(skuId,label,{},'规格选项'); }
        else if (label) { const found = result.variants.find(v => v.label === label || v.label.endsWith(`: ${label}`)); skuId = found?.id || `option:${label}`; if (!found) variant(skuId,label,{},'规格选项'); }
      }
      for (const key of ['data-original','data-zoom-image','data-large','data-big-img','data-src','data-lazy-src','src']) { const url = img.getAttribute(key); if (imageUrl(url)) addImage(url,category,skuId,`页面:${marker.slice(0,100)}`); }
      for(const entry of (img.getAttribute('srcset')||'').split(/,\s*(?=(?:https?:)?\/\/)/)){
        const url=entry.trim().replace(/\s+\d+(?:\.\d+)?[wx]$/,'');if(imageUrl(url))addImage(url,category,skuId,`页面高清候选:${marker.slice(0,100)}`);
      }
    });
    // The current 1688 gallery renders some product pictures as background images.
    root.querySelectorAll('[style*="url"],[class*="gallery-img"],[class*="gallery-image"],[class*="detail-img"],[class*="main-img"]').forEach(el=>{
      if(badContainer(el))return;
      const style=el.getAttribute('style')||'';
      const background=/url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(style)?.[1] || /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(getComputedStyle(el).backgroundImage)?.[1];
      if(background)addImage(background,category,null,`页面背景:${marker.slice(0,100)}`);
    });
    // Keep attribute rows short so a package label cannot contaminate another row.
    root.querySelectorAll('tr,li,[class*="attribute-item"],[class*="attr-item"],[class*="param-item"]').forEach(row => addRecord(row.innerText,`页面:${marker.slice(0,100)}`));
    if (/attribute|attr|parameter|description|detail.?content/i.test(marker)) {
      (root.innerText || '').split(/\n/).map(s => s.trim()).filter(Boolean).forEach((line,i,lines) => {
        if (/^(材质|材料|重量|净重|毛重|单重|尺寸|长度|宽度|高度|包装重量)\s*[:：]?$/.test(line) && lines[i+1]) addRecord(`${line.replace(/[:：]$/,'')}: ${lines[i+1]}`,marker);
        else addRecord(line,marker);
      });
    }
  });
  // 1688's v-detail-e puts the actual seller description in an open ShadowRoot.
  // Traverse only description containers, never unrelated account/navigation components.
  const visitedDetailRoots=new WeakSet();
  let detailRootCount=0,detailShadowCount=0;
  function readDetailRoot(root,source,depth=0){
    if(depth>8||visitedDetailRoots.has(root))return;visitedDetailRoots.add(root);detailRootCount++;
    root.querySelectorAll('img').forEach(img=>{
      if(badContainer(img))return;
      const link=img.closest('a[href]');
      const linkedOffer=link?.getAttribute('href')?.match(/detail\.1688\.com\/offer\/(\d+)/)?.[1];
      if(linkedOffer&&linkedOffer!==offerId)return;
      const mapName=img.getAttribute('usemap')?.replace(/^#/,'');
      const map=mapName?[...root.querySelectorAll('map')].find(m=>m.name===mapName):null;
      if(map&&[...map.querySelectorAll('area[href]')].some(a=>/detail\.1688\.com\/offer\//.test(a.href)&&!a.href.includes(`/offer/${offerId}.html`)))return;
      for(const attr of ['data-original','data-src','data-lazy-src','data-ks-lazyload','src']){
        const value=img.getAttribute(attr);if(value)addImage(value,'detail',null,source);
      }
    });
    const detailText=root.querySelector('#detail')?.innerText;
    if(detailText)detailText.split(/\n/).forEach(line=>addRecord(line,source));
    for(const el of root.querySelectorAll('*'))if(el.shadowRoot){detailShadowCount++;readDetailRoot(el.shadowRoot,`${source} > ${el.localName}`,depth+1);}
  }
  document.querySelectorAll('#description,#offer-description,#mod-detail-description,.module-od-product-description,.html-description,v-detail-e,[class*="detail-description"],[class*="detailDescription"]').forEach(root=>{
    if(!badContainer(root))readDetailRoot(root,`商品详情:${root.localName}${root.id?'#'+root.id:''}`);
  });
  result.detailStats={roots:detailRootCount,shadowRoots:detailShadowCount,images:result.images.filter(i=>i.categories.includes('detail')).length};
  // Logged-in pages expose parameter matrices: read column units and match each row to its SKU.
  document.querySelectorAll('table,[role="table"]').forEach((table,tableIndex)=>{
    if(badContainer(table)||!table.getClientRects().length)return;
    const rows=[...table.querySelectorAll('tr,[role="row"]')].filter(r=>r.closest('table,[role="table"]')===table);
    if(!rows.length)return;
    const cells=row=>[...row.querySelectorAll('th,td,[role="columnheader"],[role="cell"]')].filter(c=>c.closest('tr,[role="row"]')===row);
    let headerRow=rows.find(r=>r.querySelector('th,[role="columnheader"]'))||rows[0];
    const headers=cells(headerRow).map(c=>cleanText(c.innerText));
    if(!headers.some(h=>/长|宽|高|重|材质|材料|尺寸/.test(h)))return;
    const caption=cleanText(table.querySelector('caption')?.textContent||table.getAttribute('aria-label')||'');
    const previous=cleanText(table.previousElementSibling?.textContent||'').slice(0,70);
    const metrics=headers.filter(h=>/长|宽|高|重/.test(h));
    const scope=/包装|装箱|外箱|包裹/.test(caption+' '+previous)||(metrics.length>0&&metrics.every(h=>/包装|毛重|外箱/.test(h)))?'package':'product';
    result.parameterTables.push({headers,scope,rowCount:rows.length-1});
    if(headers.length===2&&/^(?:产品)?(?:材质|材料|长度|宽度|高度|尺寸|净重|重量|单重)(?:[（(].*)?$/.test(headers[0])){
      for(const row of rows){
        const columns=cells(row).map(c=>cleanText(c.innerText));if(columns.length!==2)continue;
        const unit=columns[0].match(/[（(]\s*(mm|cm|m|kg|mg|g|毫米|厘米|米|千克|克)\s*[）)]/i)?.[1]||'';
        const label=columns[0].replace(/[（(][\s\S]*?[）)]/g,'').trim();
        addRecord(`${label}: ${columns[1]}${/^\d+(?:\.\d+)?$/.test(columns[1])?unit:''}`,`参数表${tableIndex+1}`,undefined,{table:true});
      }
      return;
    }
    const skuColumns=headers.map((h,i)=>/规格|颜色|款式|型号|sku|色号/i.test(h)?i:-1).filter(i=>i>=0);
    const realVariants=result.variants.filter(v=>!v.id.startsWith('prop:')&&!v.id.startsWith('option:'));
    const choices=realVariants.length?realVariants:result.variants;
    for(const row of rows){
      if(row===headerRow)continue;
      const columns=cells(row).map(c=>cleanText(c.innerText));if(!columns.length)continue;
      const labels=skuColumns.map(i=>columns[i]).filter(Boolean);
      const explicit=row.getAttribute('data-sku-id')||row.getAttribute('data-skuid');
      const matches=explicit?choices.filter(v=>v.id===explicit):labels.length?choices.filter(v=>labels.every(label=>v.label===label||v.label.split(/\s*\/\s*|;|>/).some(part=>part===label||part.endsWith(': '+label)))):[];
      const skuId=matches.length===1?matches[0].id:undefined;
      const metadata={table:true,skuLabel:labels.join(' / '),unassigned:labels.length>0&&!skuId};
      headers.forEach((header,i)=>{
        const value=columns[i];if(!value||/^[-—/]+$/.test(value)||skuColumns.includes(i))return;
        const unit=header.match(/(?:\(|（|\[|单位\s*[:：]?)\s*(毫米|厘米|公分|千克|公斤|mm|cm|kg|mg|克|g|米|m)\s*(?:\)|）|\])?/i)?.[1]||'';
        const plain=header.replace(/[（(\[][\s\S]*?[）)\]]/g,'').replace(/\s+/g,'');
        let label=/材质|材料/.test(plain)?'材质':/重量|净重|单重|毛重/.test(plain)?plain:/长/.test(plain)?'长度':/宽/.test(plain)?'宽度':/高/.test(plain)?'高度':/尺寸/.test(plain)?'尺寸':null;
        if(!label)return;
        const columnScope=/包装|毛重|外箱/.test(plain)?'package':/产品|商品|净重|单重/.test(plain)?'product':scope;
        if(columnScope==='package'&&!/包装|毛重/.test(label))label='包装'+label;
        const text=`${label}: ${value}${/^\d+(?:\.\d+)?$/.test(value)?unit:''}`;
        addRecord(text,`参数表${tableIndex+1} · ${caption||'商品参数'} · ${header}${metadata.skuLabel?' · '+metadata.skuLabel:''}`,skuId,metadata);
      });
    }
  });
  const frames = [];
  document.querySelectorAll('iframe').forEach(el => {
    if (/desc|detail/i.test(`${el.id} ${el.className} ${el.src}`)) frames.push(el.src);
  });
  result.detailFrameUrls = frames;
  const urlGate = /login\.|passport\.|_____tmd_____|\/punish|\/captcha/i.test(location.href);
  const visibleGate = /访问验证|滑动验证|请按住滑块|向右滑动|请完成.{0,8}验证|验证通过后|安全验证|登录后查看|请先登录|登录后可见|登录后.{0,12}(?:参数|详情|规格)|(?:参数|详情|规格).{0,10}登录后|登录.{0,5}查看.{0,6}(?:详情|参数|规格)/.test(bodyText);
  const gateNode = [...document.querySelectorAll('#baxia-dialog-content,#nocaptcha,#nc_1_wrapper,iframe[src*="captcha"],iframe[src*="punish"],iframe[src*="baxia"]')].some(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0);
  const noProduct = result.images.length === 0 && result.records.length === 0;
  result.verification = urlGate || visibleGate || gateNode || (noProduct && /验证码|验证拦截|安全验证|访问受限|captcha/i.test(titleText)) || (noProduct && /验证码|扫码登录|密码登录|短信登录|登录1688/.test(bodyText));
  result.unavailable = /商品已下架|商品不存在|该商品已被删除|您访问的商品不存在|商品已失效/.test(bodyText) && noProduct;
  if (!roots.length && !result.images.length) result.warnings.push('未识别到商品图片区域，需要检查页面是否完整加载或页面结构是否变化。');
  // Value options are not complete SKUs. Prefer actual SKU rows whenever available.
  const actualSkus = result.variants.filter(v => !v.id.startsWith('prop:') && !v.id.startsWith('option:'));
  if (actualSkus.length) {
    const options = result.variants.filter(v => !actualSkus.includes(v));
    const valueName = o => (o.label.split(': ').at(-1) || '').trim();
    for (const v of actualSkus) {
      const ids = String(v.props.specAttrs || v.label || v.props.specId).split(/[;>，,]/).map(s => s.trim());
      const matched = options.filter(o => ids.includes(valueName(o)));
      if (matched.length) v.label = matched.map(o => o.label).join(' / ');
      for (const img of result.images) for (const o of matched) if (img.skuIds.includes(o.id) && !img.skuIds.includes(v.id)) img.skuIds.push(v.id);
    }
    result.variants = actualSkus;
    const skuIds=new Set(actualSkus.map(v=>v.id));
    for(const img of result.images)img.skuIds=img.skuIds.filter(id=>skuIds.has(id));
    result.records = result.records.filter(r => !r.skuId || actualSkus.some(v => v.id === r.skuId));
  } else if (result.variants.length) result.warnings.push('页面只提供了规格选项，未确认完整SKU组合；选项分别列出，未自动组合。');
  result.variantMode = actualSkus.length ? 'sku' : result.variants.length ? 'options' : 'none';
  if (!result.images.some(i => i.categories.includes('main'))) result.warnings.push('未获取到主图，请核对页面加载或访问权限。');
  if (!result.images.some(i => i.categories.includes('detail'))) result.warnings.push('未获取到详情图，可能未加载、不可访问或页面未提供。');
  return result;
}
