import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { collectSnapshot } from './page-extractor.js';
import { newProduct, extractFields, preserveManual, summarizeFields } from './domain.js';
import { ocrRecords,OCR_VERSION } from './ocr.js';
import { normalizeImages,originalImageUrl,IMAGE_POLICY_VERSION } from './image-policy.js';
import {browserLaunchOptions} from './platform.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const gateUrl = url => /login\.|passport\.|_____tmd_____|\/punish|\/captcha/i.test(url);
function parseResponse(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/^[\w$.]+\s*\(\s*([\s\S]+)\s*\)\s*;?\s*$/);
  if (m) try { return JSON.parse(m[1]); } catch {}
  return null;
}

export class Collector {
  constructor({store,dataDir,ocr}) {
    Object.assign(this,{store,dataDir,ocr}); this.context=null; this.page=null; this.active=null; this.busy=false; this.stopping=false; this.browserProblem=null; this.capture=null;
  }
  async browser() {
    if (this.context) return this.context;
    try {
      const profile = path.join(this.dataDir,'browser-profile');
      await mkdir(profile,{recursive:true});
      this.context = await chromium.launchPersistentContext(profile,{...browserLaunchOptions(),headless:false,viewport:null,acceptDownloads:false,locale:'zh-CN',args:['--start-maximized']});
      this.context.on('close',()=>{this.releaseCapture();this.context=null;this.page=null;});
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.browserProblem=null; return this.context;
    } catch(e) { this.browserProblem = `无法打开采集浏览器。请确认已安装 Google Chrome，且没有其他工作台占用采集窗口。${e.message.split('\n')[0]}`; throw new Error(this.browserProblem); }
  }
  async showBrowser() { await this.browser(); if (!this.page || this.page.isClosed()) this.page=await this.context.newPage(); if (this.page.url()==='about:blank') await this.page.goto('https://www.1688.com',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{}); await this.page.bringToFront(); }
  async login(){
    await this.browser();
    if(!this.page||this.page.isClosed())this.page=await this.context.newPage();
    if(!this.busy&&!/detail\.1688\.com\/offer\/|login\.|passport\./.test(this.page.url())){
      const target=this.store.products()[0]?.url||'https://www.1688.com';
      await this.page.goto(target,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
    }
    await this.page.bringToFront();
  }
  async browserStatus(){
    if(!this.page||this.page.isClosed())return{open:false,requiresLogin:null};
    const offerId=this.page.url().match(/\/offer\/(\d+)/)?.[1]||null;
    const snapshot=await this.page.evaluate(collectSnapshot,{offerId:offerId||'',payloads:[]});
    return{open:true,offerId,requiresLogin:snapshot.verification,pageType:gateUrl(this.page.url())?'login':offerId?'product':'other',title:snapshot.verification?'1688登录或验证':snapshot.title,parameterCount:snapshot.records.length,parameterTables:snapshot.parameterTables};
  }
  create(links) {
    if(this.busy)throw new Error('前一个任务正在处理或结束，请稍候再新建批次。');
    if (this.active || this.store.jobs().some(j=>['queued','running','waiting','paused'].includes(j.status))) throw new Error('请先继续或停止当前任务，再新建批次。');
    this.ocr.reset?.();
    for (const link of links) {
      const old=this.store.product(link.id);
      this.store.saveProduct(old?{...old,status:'queued',message:'等待重新采集'}:newProduct(link));
    }
    const job={id:randomUUID(),ids:links.map(l=>l.id),index:0,status:'queued',message:'等待启动',createdAt:new Date().toISOString(),results:{}};
    this.store.saveJob(job); this.active=job.id; this.stopping=false;
    setImmediate(()=>this.run(job.id)); return job;
  }
  resume(id) {
    const job=this.store.job(id); if (!job || !['waiting','paused'].includes(job.status)) throw new Error('这个任务目前不需要继续。');
    if (this.busy) throw new Error('采集仍在处理中，请稍后再试。');
    if (this.active && this.active!==id) throw new Error('已有其他任务在运行。');
    this.ocr.reset?.();this.active=id;this.stopping=false;job.status='running';job.message='正在继续';this.store.saveJob(job);
    setImmediate(()=>this.run(id,true)); return job;
  }
  stop(id) {
    const job=this.store.job(id); if (!job || !['running','waiting','paused','queued'].includes(job.status)) throw new Error('任务已结束。');
    this.stopping=true;this.releaseCapture();job.status='stopped';job.message='任务已停止，已采集结果保留';this.store.saveJob(job);
    for (const productId of job.ids.slice(job.index)) { const p=this.store.product(productId);if (p && ['running','waiting','queued','paused'].includes(p.status)) {p.status='stopped';p.message='已停止';this.store.saveProduct(p);} }
    if (!this.busy) this.active=null;
    return job;
  }
  checkStop() { if (this.stopping) throw new Error('TASK_STOPPED'); }
  releaseCapture(){if(this.capture){this.capture.page.off('response',this.capture.listener);this.capture=null;}}
  update(id, message, changes={}) { this.checkStop(); const current=this.store.product(id);this.store.saveProduct({...current,...changes,message}); }
  async snapshot(id,payloads) {
    const base=await this.page.evaluate(collectSnapshot,{offerId:id,payloads});
    for (const frame of this.page.frames()) {
      if (frame===this.page.mainFrame() || !/desc|detail/i.test(frame.url())) continue;
      try {
        const extra=await frame.evaluate(collectSnapshot,{offerId:id,payloads:[]});
        for (const img of extra.images) if (!base.images.some(i=>i.url===img.url)) base.images.push({...img,categories:['detail'],order:base.images.length+1});
        base.records.push(...extra.records);
        const frameImages=await frame.locator('body img').evaluateAll(imgs=>imgs.map(i=>i.getAttribute('data-src')||i.getAttribute('data-original')||i.src).filter(Boolean));
        for (let url of frameImages) {
          if (url.startsWith('//')) url='https:'+url;
          try { const u=new URL(url);if (!/(^|\.)alicdn\.com$/.test(u.hostname)||!['https:','http:'].includes(u.protocol)) continue; } catch { continue; }
          if (!base.images.some(i=>i.url===url)) base.images.push({url,categories:['detail'],skuIds:[],order:base.images.length+1,source:'详情框架'});
        }
      } catch { base.warnings.push('部分详情框架无法读取，请核对详情图是否完整。'); }
    }
    return base;
  }
  async readPage(product, reuse) {
    await this.browser();this.checkStop();
    if (!this.page || this.page.isClosed()) this.page=await this.context.newPage();
    if(this.capture && (this.capture.id!==product.id || this.capture.page!==this.page))this.releaseCapture();
    const payloads=this.capture?.payloads||[]; const pending=this.capture?.pending||new Set();
    const listener=response=>{
      const url=response.url();
      if (!/(1688\.com|alibaba\.com)/.test(url) || !/detail|offer|sku|description/i.test(url) || /recommend|related|comment|search|suggest/i.test(url)) return;
      if (payloads.length>=35) return;
      const work=(async()=>{try { const type=response.headers()['content-type']||'';if (!/json|javascript/i.test(type)) return;const body=await response.text();if(body.length>4000000)return;const data=parseResponse(body);if(data)payloads.push(data); }catch{}})();
      pending.add(work);work.finally(()=>pending.delete(work));
    };
    if(!this.capture){this.page.on('response',listener);this.capture={id:product.id,page:this.page,payloads,pending,listener};}
    let waiting=false;
    try {
      const isProduct = this.page.url().startsWith(product.url);
      if (!reuse || !isProduct || gateUrl(this.page.url())) {
        await this.page.goto(product.url,{waitUntil:'domcontentloaded',timeout:45000}).catch(async e=>{if(!this.page || this.page.isClosed() || this.page.url()==='about:blank')throw e;});
      }
      await this.page.waitForTimeout(1800);this.checkStop();
      let snapshot=await this.snapshot(product.id,payloads);
      if (snapshot.verification || snapshot.unavailable) {waiting=snapshot.verification;return snapshot;}
      this.update(product.id,'正在展开商品参数与规格表…');
      for(const expression of [/^(全部参数|查看全部参数|更多参数|展开参数|展开全部参数)$/,/^(商品详情|图文详情|产品详情)$/]){
        const button=this.page.getByText(expression).first();
        if(await button.isVisible().catch(()=>false)){await button.click({timeout:2500}).catch(()=>{});await sleep(450);}
      }
      const description=this.page.locator('#description,.module-od-product-description,v-detail-e,#offer-description,#mod-detail-description').first();
      if(await description.count()){
        await description.scrollIntoViewIfNeeded({timeout:5000}).catch(()=>{});
        await this.page.waitForFunction(()=>{
          const host=document.querySelector('v-detail-e');
          return !host||Boolean(host.shadowRoot?.querySelector('img'));
        },null,{timeout:6500}).catch(()=>{});
      }
      snapshot=await this.snapshot(product.id,payloads);
      if(snapshot.verification){waiting=true;return snapshot;}
      this.update(product.id,'正在加载商品图片与详情…');
      // Slow bounded scrolling triggers lazy-loaded detail images.
      // Keep the description in view before scrolling, so its lazy component mounts.
      for (let n=0;n<45;n++) {
        this.checkStop();
        if(n%8===0)this.update(product.id,`正在加载详情图片（第 ${n+1} 屏）…`);
        const pos=await this.page.evaluate(()=>{window.scrollBy(0,Math.max(600,window.innerHeight*.8));return{y:window.scrollY,h:document.documentElement.scrollHeight,v:window.innerHeight};});
        await sleep(220);
        if (pos.y+pos.v>=pos.h-10) { await sleep(650);const h=await this.page.evaluate(()=>document.documentElement.scrollHeight);if(h===pos.h)break; }
      }
      await this.page.waitForTimeout(900);
      await Promise.race([Promise.allSettled([...pending]),sleep(3000)]);
      this.update(product.id,'正在读取已加载的商品详情…');
      snapshot=await this.snapshot(product.id,payloads);
      if(!snapshot.verification && snapshot.detailUrls?.length && !snapshot.images.some(i=>i.categories.includes('detail'))) {
        for(const url of snapshot.detailUrls.slice(0,3)) {
          this.checkStop();
          try {
            const response=await this.context.request.get(url,{headers:{Referer:product.url},timeout:15000,maxRedirects:2});
            if(!response.ok())continue;
            const content=await response.text();if(content.length>4000000)continue;
            const parsed=parseResponse(content);
            const extra=await this.page.evaluate(collectSnapshot,{offerId:product.id,payloads:[parsed||{description:content}]});
            for(const img of extra.images.filter(i=>i.categories.includes('detail')))if(!snapshot.images.some(i=>i.url===img.url))snapshot.images.push({...img,order:snapshot.images.length+1});
            snapshot.records.push(...extra.records.filter(r=>r.path?.startsWith('详情响应')));
          } catch { snapshot.warnings.push('详情图片地址无法读取，已保留可访问的其他图片。'); }
        }
        if(snapshot.images.some(i=>i.categories.includes('detail')))snapshot.warnings=snapshot.warnings.filter(w=>!w.startsWith('未获取到详情图'));
      }
      const atBottom=await this.page.evaluate(()=>window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-50);
      if (!atBottom) snapshot.warnings.push('详情页面较长或仍在加载，已达到本次自动滚动上限；请核对详情图完整性。');
      await this.page.evaluate(()=>window.scrollTo(0,0));
      waiting=snapshot.verification;
      return snapshot;
    } finally { if(!waiting)this.releaseCapture(); }
  }
  async download(product,snapshot) {
    const images=[],byHash=new Map();let done=0;
    const oldByUrl=new Map((product.images||[]).filter(i=>i.status==='downloaded').map(i=>[i.url,i]));
    const candidates=normalizeImages(snapshot.images);
    for (const candidate of candidates) {
      this.checkStop();done++;
      this.update(product.id,`获取原图 ${done} / ${candidates.length}`);
      let image={...candidate,id:createHash('sha256').update(candidate.url).digest('hex').slice(0,20),status:'failed',error:null,qualityVersion:IMAGE_POLICY_VERSION};
      image.legacyIds=[...new Set([...image.legacyIds,...(product.images||[]).filter(i=>originalImageUrl(i.url)===candidate.url).flatMap(i=>[i.id,...(i.legacyIds||[])])])];
      delete image.ocr;delete image.ocrError;delete image.dimensionError;image.resolutionVerified=false;
      try {
        const old=oldByUrl.get(candidate.url);
        const reusable=old?.relativePath && old.qualityVersion===IMAGE_POLICY_VERSION && ['original','source-small'].includes(old.qualityStatus) && await access(path.join(this.dataDir,'images',old.relativePath)).then(()=>true,()=>false);
        if (reusable) { image={...old,...candidate,id:image.id,qualityVersion:IMAGE_POLICY_VERSION,status:'downloaded',error:null}; }
        else {
          let bytes,type,last,resolvedUrl;
          for(const url of candidate.candidateUrls.slice(0,5)){
            for (let attempt=0;attempt<(url===candidate.url?2:1);attempt++) {
              this.checkStop();
              try {
                const response=await this.context.request.get(url,{headers:{Referer:product.url},timeout:25000,maxRedirects:3});
                if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
                type=response.headers()['content-type']||'';
                if (!type.startsWith('image/')) throw new Error('返回内容不是图片');
                const length=Number(response.headers()['content-length']||0);
                if (length>40*1024*1024) throw new Error('图片超过40MB，未下载');
                const body=await response.body();
                if (body.length>40*1024*1024) throw new Error('图片超过40MB，未下载');
                bytes=body;resolvedUrl=url;break;
              } catch(e){last=e;if(attempt===0&&url===candidate.url)await sleep(500);}
            }
            if(bytes)break;
          }
          if(!bytes) throw last;
          const hash=createHash('sha256').update(bytes).digest('hex');
          const ext=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif'})[type.split(';')[0]]||'img';
          const relativePath=`${product.id}/${hash.slice(0,24)}.${ext}`;
          await mkdir(path.join(this.dataDir,'images',product.id),{recursive:true});
          await writeFile(path.join(this.dataDir,'images',relativePath),bytes);
          image={...image,hash,relativePath,bytes:bytes.length,status:'downloaded',resolvedUrl,qualityStatus:resolvedUrl===candidate.url?'original':'fallback'};
          try{
            const dimensions=await this.ocr.dimensions?.(path.join(this.dataDir,'images',relativePath));
            if(!dimensions?.width||!dimensions?.height)throw new Error('无法核验像素尺寸');
            Object.assign(image,dimensions,{resolutionVerified:true});
            if(image.qualityStatus==='original'&&Math.max(image.width,image.height)<500)image.qualityStatus='source-small';
          }catch(e){image.dimensionError=e.message;image.resolutionVerified=false;if(image.qualityStatus==='original')image.qualityStatus='unverified';}
        }
        const existing=byHash.get(image.hash);
        if (existing) {
          existing.categories=[...new Set([...existing.categories,...image.categories])];existing.skuIds=[...new Set([...existing.skuIds,...image.skuIds])];
          existing.sourceUrls=[...new Set([...(existing.sourceUrls||[existing.url]),...image.sourceUrls])];existing.legacyIds=[...new Set([...(existing.legacyIds||[]),image.id,...image.legacyIds])];continue;
        }
        byHash.set(image.hash,image);
      } catch(e) { if(e.message==='TASK_STOPPED')throw e;image.error=e.message; }
      images.push(image);
      // Commit partial progress so stopping cannot erase already downloaded images.
      this.update(product.id,`已处理 ${done} / ${candidates.length} 张原图`,{images});
    }
    return images;
  }
  async collect(product,reuse) {
    this.update(product.id,'正在打开商品页…',{status:'running',warnings:[]});
    let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{this.page?.close().catch(()=>{});reject(new Error('商品页面读取超过90秒，可能被访问验证或页面脚本阻塞。请重试，或先打开采集浏览器检查。'));},90000);});
    let snap;
    try{snap=await Promise.race([this.readPage(product,reuse),deadline]);}finally{clearTimeout(timer);}
    this.checkStop();
    if(snap.verification) return {waiting:true};
    if(snap.unavailable) throw new Error('商品已下架、失效或不存在。');
    if(!snap.images.length && !snap.records.length) throw new Error('未读取到商品内容。页面可能尚未加载、访问受限或结构发生变化；请在采集浏览器中检查后重试。');
    const warnings=[...snap.warnings];
    if (!snap.variants.length) warnings.push('未读取到规格数据，请核对商品是否有多种规格。');
    const records=[...snap.records];
    this.update(product.id,'已读取商品信息，准备下载图片…',{title:snap.title||product.title,supplier:snap.supplier,records,warnings,variantMode:snap.variantMode});
    const images=await this.download(product,snap);
    if(images.some(i=>i.status==='downloaded'&&i.qualityStatus==='fallback'))warnings.push('部分原始图片地址不可用，暂存了页面可访问的缩略图；图库已标明，未将其视为原图。');
    if(images.some(i=>i.status==='downloaded'&&!i.resolutionVerified))warnings.push('部分图片像素尺寸未能核验，请查看图库提示。');
    const downloaded=images.filter(i=>i.status==='downloaded');
    for(let i=0;i<downloaded.length;i++) {
      this.checkStop();const image=downloaded[i];this.update(product.id,`本机识别图片参数 ${i+1} / ${downloaded.length}`);
      try {
        const recognized=image.ocr?.version===OCR_VERSION?image.ocr:await this.ocr.recognize(path.join(this.dataDir,'images',image.relativePath));
        image.ocr=recognized;image.width=recognized.width;image.height=recognized.height;
        records.push(...ocrRecords(recognized,image,{productTitle:snap.title||product.title}));
      }catch(e){image.ocrError=e.message;if(!warnings.includes(e.message))warnings.push(e.message);}
      this.update(product.id,`已识别 ${i+1} / ${downloaded.length} 张图片`,{images,records,warnings});
    }
    const global=extractFields(records.filter(r=>!r.skuId));
    const live=this.store.product(product.id);
    const oldVariants=new Map((live.variants||[]).map(v=>[v.id,v]));
    const variants=snap.variants.map(v=>{
      const local=extractFields(records.filter(r=>r.skuId===v.id));
      // Only unambiguous page attributes can be inherited; image-only guesses stay unassigned.
      for(const key of Object.keys(local))if(global[key].status==='found'&&(local[key].status==='missing'||local[key].status==='review'&&local[key].value===global[key].value&&local[key].candidates.every(c=>c.source.kind==='ocr'))){const sources=local[key].sources;local[key]=structuredClone(global[key]);local[key].sources.push(...sources);}
      return {...v,fields:preserveManual(local,oldVariants.get(v.id)?.fields)};
    });
    const fields=preserveManual(summarizeFields(global,variants),live.fields);
    const weights=[...new Set((fields.weight.candidates||[]).filter(c=>c.value!=null).map(c=>c.value))];
    if(weights.length>1)warnings.push(`重量来源存在差异（${weights.join(' / ')}g），已保留原文；请点击重量核对参数图与页面表格。`);
    const review=Object.entries(fields).some(([key,f])=>!key.startsWith('package')&&['review','variants'].includes(f.status));
    const missing=Object.values(fields).slice(0,5).some(f=>f.status==='missing');
    const failed=images.filter(i=>i.status==='failed').length;
    const partial=failed>0 || warnings.length>0;
    const current=this.store.product(product.id);
    this.store.saveProduct({...current,title:snap.title||product.title,supplier:snap.supplier,images,records,fields,variants,warnings,status:partial?'partial':'done',message:partial?`采集结束，${failed?'有 '+failed+' 张图片下载失败；':''}请检查提示`:(review||missing?'采集结束，部分参数需要核对':'采集完成'),collectedAt:new Date().toISOString()});
    // Text generation has its own queue; it never delays the next collection.
    if(this.onCollected)Promise.resolve().then(()=>this.onCollected(this.store.product(product.id))).catch(e=>{this.listingProblem=e.message;});
    return {waiting:false};
  }
  async run(id,reuse=false) {
    if(this.busy)return;this.busy=true;
    let job=this.store.job(id);
    try {
      job.status='running';job.message='正在采集';this.store.saveJob(job);
      while(job.index<job.ids.length) {
        this.checkStop();
        const productId=job.ids[job.index];const product=this.store.product(productId);
        try {
          const outcome=await this.collect(product,reuse);reuse=false;
          if(outcome.waiting) {
            this.update(productId,'需要你在采集浏览器中完成登录或验证，然后点击“继续采集”',{status:'waiting'});
            job.status='waiting';job.message='等待登录或验证';this.store.saveJob(job);await this.page?.bringToFront().catch(()=>{});return;
          }
          job.results[productId]=this.store.product(productId).status;
        }catch(e){
          if(e.message==='TASK_STOPPED')throw e;
          this.update(productId,e.message,{status:'failed'});job.results[productId]='failed';
        }
        job.index++;job.message=`已处理 ${job.index} / ${job.ids.length} 个商品`;this.store.saveJob(job);
      }
      job.status='done';job.message=`批次结束：${job.ids.length} 个商品已处理`;this.store.saveJob(job);this.active=null;
    }catch(e){if(e.message!=='TASK_STOPPED'){job.status='paused';job.message=e.message;this.store.saveJob(job);}else this.active=null;}
    finally{this.busy=false;}
  }
  async close(){this.stopping=true;this.releaseCapture();await this.context?.close().catch(()=>{});}
}
