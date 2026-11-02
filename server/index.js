import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {Store} from './db.js';
import {Collector} from './collector.js';
import {LocalOCR} from './ocr.js';
import {FIELD_DEFS,extractFields,summarizeFields,preserveManual} from './domain.js';
import {workbookBuffer,zipImages} from './exports.js';
import {GenerationService} from './generation.js';
import {containedFile} from './generation-input.js';
import {createLinkResolver} from './link-resolver.js';
import {sendCleanImage} from './download-cleaner.js';
import {ReviewService} from './review.js';
import {ListingService} from './listing.js';
import {bundledSkillPath} from './platform.js';
import {inspectEnvironment} from './environment.js';
import {CODEX_IMAGE_MODEL,IMAGE_REASONING_EFFORT} from './image-model.js';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp({dataDir=path.join(ROOT,'data'),collectorFactory,store:providedStore,generationFactory,listingFactory,linkResolver,outputRoot=path.join(ROOT,'output/etsy-accessory-images'),listingOutputRoot=path.join(ROOT,'output/etsy-listings')}={}){
  const app=express();const store=providedStore||new Store(dataDir);store.recover();
  const ocr=new LocalOCR(ROOT,dataDir);const collector=collectorFactory?collectorFactory({store,dataDir,ocr}):new Collector({store,dataDir,ocr});
  const review=new ReviewService({store});
  const listingOptions={store,dataDir,outputRoot:listingOutputRoot,review};const listing=listingFactory?listingFactory(listingOptions):new ListingService(listingOptions);
  collector.onCollected=product=>listing.create(product.id,{automatic:true});
  const generationOptions={store,dataDir,outputRoot,ocr,review,skillPath:bundledSkillPath(ROOT)};
  const generation=generationFactory?generationFactory(generationOptions):new GenerationService(generationOptions);
  const resolveLinks=linkResolver||createLinkResolver();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const hostname=req.hostname;
    if(!['127.0.0.1','localhost','[::1]','::1'].includes(hostname))return res.status(403).json({error:'工作台仅允许本机访问。'});
    if(req.path.startsWith('/api/chatgpt/companion/bridge/'))return res.status(410).json({error:'网页生图连接已停用；请使用Codex GPT-6.1 Sol。'});
    const origin=req.get('origin');
    if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'不接受其他网站发来的操作。'});}catch{return res.sendStatus(403);}}
    if(req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'不接受跨站请求。'});
    next();
  });
  app.use(express.json({limit:'150kb'}));
  app.get('/api/health',(req,res)=>res.json({app:'1688-workbench',version:'1.1.0'}));
  app.get('/api/environment',async(req,res)=>{try{res.json(await inspectEnvironment({root:ROOT}));}catch(e){res.status(500).json({error:e.message});}});
  app.get('/api/state',(req,res)=>{
    const generationJobs=generation.summaries();
    const listingJobs=listing.summaries();
    res.json({products:store.products().map(({records,...p})=>({...p,listing:listingJobs.find(j=>j.productId===p.id)||null,images:p.images.map(({ocr,...image})=>image),variants:p.variants.map(v=>({...v,generation:generationJobs.find(j=>j.productId===p.id&&j.skuId===v.id)||null}))})),jobs:store.jobs(),generationJobs,listingJobs,pendingReviews:store.entries('feedback_events').filter(e=>e.reviewStatus==='pending').length,listingProblem:listing.problem||collector.listingProblem||null,generationProblem:generation.problem||null,busy:collector.busy,browserOpen:Boolean(collector.context),browserProblem:collector.browserProblem,ocrProblem:ocr.problem});
  });
  app.get('/api/products/:id/listing',(req,res)=>{if(!store.product(req.params.id))return res.status(404).json({error:'商品不存在。'});res.json(listing.detail(req.params.id));});
  app.post('/api/products/:id/listing/generate',async(req,res)=>{try{res.status(201).json({id:(await listing.create(req.params.id,{force:req.body.force===true})).id});}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/listings/generate',async(req,res)=>{const ids=req.body.ids;if(!Array.isArray(ids)||!ids.length||ids.length>30||ids.some(id=>typeof id!=='string'))return res.status(400).json({error:'请选择1–30个商品。'});const results=[];for(const id of new Set(ids)){try{results.push({productId:id,id:(await listing.create(id)).id});}catch(e){results.push({productId:id,error:e.message});}}res.json({results});});
  app.post('/api/products/:id/listing/adjust',async(req,res)=>{try{res.status(201).json({id:(await listing.adjust(req.params.id,req.body.field,req.body.instruction,req.body.baseVersionId)).id});}catch(e){res.status(409).json({error:e.message});}});
  app.patch('/api/products/:id/listing',(req,res)=>{try{res.json(listing.saveManual(req.params.id,req.body.field,req.body.value,req.body.baseVersionId));}catch(e){res.status(400).json({error:e.message});}});
  app.post('/api/products/:id/listing/adopt',(req,res)=>{try{res.json(listing.adopt(req.params.id,req.body.versionId,req.body.fields));}catch(e){res.status(400).json({error:e.message});}});
  app.get('/api/listing-jobs/:id',(req,res)=>{try{res.json(listing.get(req.params.id));}catch(e){res.status(404).json({error:e.message});}});
  for(const op of ['stop','resume','retry'])app.post(`/api/listing-jobs/:id/${op}`,async(req,res)=>{try{res.json(await listing[op==='stop'?'stop':'resume'](req.params.id));}catch(e){res.status(409).json({error:e.message});}});
  app.get('/api/review',(req,res)=>res.json(review.data()));
  app.post('/api/review/approve',(req,res)=>{try{res.json(review.approve(req.body));}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/review/reject',(req,res)=>{try{res.json(review.reject(req.body.eventIds));}catch(e){res.status(400).json({error:e.message});}});
  app.patch('/api/rules/:id',(req,res)=>{try{res.json(review.toggle(req.params.id,req.body.enabled,req.body.baseVersion));}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/rules/rollback',(req,res)=>{try{res.json(review.rollback(req.body.versionId,req.body.baseVersion));}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/products/:id/variants/:skuId/generate',async(req,res)=>{
    try{const job=await generation.create(req.params.id,req.params.skuId,{autoRepair:req.body.autoRepair===true});res.status(201).json({id:job.id});}catch(e){res.status(409).json({error:e.message});}
  });
  app.use('/api/chatgpt',(req,res)=>res.status(410).json({error:'网页生图方案已停用；新图片任务使用Codex GPT-6.1 Sol。'}));
  app.get('/api/generation/config',(req,res)=>res.json({provider:'codex',requestedModel:CODEX_IMAGE_MODEL,reasoningEffort:IMAGE_REASONING_EFFORT}));
  app.patch('/api/generation-jobs/:id/evidence',async(req,res)=>{try{res.json(await generation.setEvidence(req.params.id,req.body.view,req.body.imageIds));}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/generation-jobs/:id/source-angles',async(req,res)=>{try{res.json(await generation.sourceAngles(req.params.id));}catch(e){res.status(409).json({error:e.message});}});
  app.get('/api/style-preferences',(req,res)=>res.json({preferences:generation.preferences()}));
  app.patch('/api/style-preferences/:id',(req,res)=>{try{res.json(generation.setPreference(req.params.id,req.body.enabled));}catch(e){res.status(400).json({error:e.message});}});
  app.patch('/api/generation-jobs/:id/options',async(req,res)=>{try{res.json(await generation.setOptions(req.params.id,req.body));}catch(e){res.status(400).json({error:e.message});}});
  app.patch('/api/generation-jobs/:id/selection',async(req,res)=>{try{res.json(await generation.selectVersion(req.params.id,req.body.candidateId,req.body.assetJobId));}catch(e){res.status(400).json({error:e.message});}});
  app.post('/api/generation-jobs/:id/candidates/:candidateId/adjust',async(req,res)=>{
    try{const job=await generation.adjust(req.params.id,req.params.candidateId,req.body.instruction);res.status(201).json({id:job.id});}catch(e){res.status(409).json({error:e.message});}
  });
  app.get('/api/generation-jobs/:id',(req,res)=>{
    try{res.json(generation.get(req.params.id));}catch(e){res.status(404).json({error:e.message});}
  });
  for(const operation of ['resume','retry','stop'])app.post(`/api/generation-jobs/:id/${operation}`,async(req,res)=>{
    try{res.json(operation==='stop'?await generation.stop(req.params.id):await generation.resume(req.params.id,{retry:operation==='retry'}));}catch(e){res.status(409).json({error:e.message});}
  });
  app.get('/api/generation-jobs/:id/images/:candidateId',async(req,res)=>{
    try{const {file,candidate}=await generation.imageFile(req.params.id,req.params.candidateId,{preview:req.query.preview==='1'});res.setHeader('Cache-Control','private, no-cache');if(req.query.download==='1')await sendCleanImage(res,file,path.basename(candidate.file));else res.sendFile(file);}catch(e){res.status(404).json({error:e.message});}
  });
  app.get('/api/generation-jobs/:id/inputs/:imageId',async(req,res)=>{
    try{const job=generation.get(req.params.id);const ref=[...job.snapshot.refs,...(job.snapshot.angleRefs||[])].find(r=>r.imageId===req.params.imageId);if(!ref)return res.sendStatus(404);res.sendFile(await containedFile(await generation.directory(job),ref.path));}catch(e){res.status(404).json({error:e.message});}
  });
  app.get('/api/generation-jobs/:id/angle-sources/:candidateId',async(req,res)=>{
    try{const job=generation.get(req.params.id),candidate=job.candidates.find(c=>c.id===req.params.candidateId);const source=candidate?.angleSource;
      if(candidate?.view!=='source'||source?.status!=='ready'||source.file!==`angle-sources/${candidate.letter}.png`)return res.sendStatus(404);
      res.sendFile(await containedFile(await generation.directory(job),source.file));
    }catch(e){res.status(404).json({error:e.message});}
  });
  app.get('/api/generation-jobs/:id/download',async(req,res)=>{
    try{await generation.zip(req.params.id,res);}catch(e){if(!res.headersSent)res.status(409).json({error:e.message});else res.destroy(e);}
  });
  app.post('/api/links/validate',async(req,res)=>res.json(await resolveLinks(req.body.links)));
  app.post('/api/jobs',async(req,res)=>{
    const parsed=await resolveLinks(req.body.links);
    if(parsed.invalid.length||parsed.tooMany||!parsed.valid.length)return res.status(400).json({error:parsed.tooMany?'每批最多30个不同商品。':parsed.errors?.[0]?.message|| (parsed.invalid.length?'请先修正无效链接。':'请输入商品链接。'),...parsed});
    try{res.status(201).json(collector.create(parsed.valid));}catch(e){res.status(409).json({error:e.message});}
  });
  app.post('/api/jobs/:id/resume',(req,res)=>{try{res.json(collector.resume(req.params.id));}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/jobs/:id/stop',(req,res)=>{try{res.json(collector.stop(req.params.id));}catch(e){res.status(409).json({error:e.message});}});
  app.post('/api/browser',async(req,res)=>{try{await collector.showBrowser();res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
  app.post('/api/browser/login',async(req,res)=>{try{await collector.login();res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
  app.get('/api/browser/status',async(req,res)=>{try{res.json(await collector.browserStatus());}catch(e){res.status(500).json({error:e.message});}});
  app.patch('/api/products/:id/fields', (req,res)=>{
    const product=store.product(req.params.id);if(!product)return res.status(404).json({error:'商品不存在。'});
    if(['running','queued','waiting'].includes(product.status))return res.status(409).json({error:'请等采集结束，或停止任务后再修改参数。'});
    const {key,value,skuId,reset}=req.body;
    if(!FIELD_DEFS.some(([k])=>k===key))return res.status(400).json({error:'未知参数。'});
    const target=skuId?product.variants.find(v=>v.id===skuId):product;
    if(!target)return res.status(404).json({error:'规格不存在。'});
    let clean=value==null||value===''?null:key==='material'?String(value).trim():Number(value);
    if(!reset && clean!==null && (key==='material'?(clean.length>200):(!Number.isFinite(clean)||clean<=0)))return res.status(400).json({error:key==='material'?'材质最多200个字符。':'请填写大于0的数字。'});
    const global=extractFields(product.records.filter(r=>!r.skuId));
    if(reset){
      if(skuId){const local=extractFields(product.records.filter(r=>r.skuId===skuId));target.fields[key]=local[key].status==='missing'&&global[key].status==='found'?global[key]:local[key];}
      else target.fields[key]=summarizeFields(global,product.variants)[key];
    }else target.fields[key]={...target.fields[key],value:clean,status:'manual',manualAt:new Date().toISOString()};
    if(skuId)product.fields=preserveManual(summarizeFields(global,product.variants),product.fields);
    store.saveProduct(product);res.json(product);
  });
  app.get('/api/images/:offerId/:imageId', (req,res)=>{
    const p=store.product(req.params.offerId);const image=p?.images.find(i=>i.id===req.params.imageId||i.legacyIds?.includes(req.params.imageId));
    if(!image?.relativePath||image.status!=='downloaded')return res.status(404).json({error:'图片未下载或不存在。'});
    const root=path.join(dataDir,'images');const file=path.resolve(root,image.relativePath);
    if(!file.startsWith(root+path.sep))return res.sendStatus(400);
    res.setHeader('Cache-Control','private, no-cache');res.sendFile(file);
  });
  function selectedProducts(req){const ids=String(req.query.ids||'').split(',').filter(Boolean);return store.products().filter(p=>!ids.length||ids.includes(p.id));}
  app.get('/api/export/excel',async(req,res)=>{const products=selectedProducts(req);if(!products.length)return res.status(400).json({error:'请先选择商品。'});const buffer=await workbookBuffer(products,products.map(p=>({productId:p.id,...listing.current(p.id)})));res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="1688-products-${new Date().toISOString().slice(0,10)}.xlsx"`);res.send(Buffer.from(buffer));});
  app.get('/api/export/images',async(req,res)=>{const products=selectedProducts(req);if(!products.length)return res.status(400).json({error:'请先选择商品。'});res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition','attachment; filename="1688-product-images.zip"');await zipImages(res,products,dataDir);});
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在。'}));
  app.use((err,req,res,next)=>{console.error(err.message);if(!res.headersSent)res.status(500).json({error:err.type==='entity.parse.failed'?'请求格式有误。':err.message||'操作失败，请重试。'});else next(err);});
  return {app,store,collector,ocr,generation,listing,review};
}

async function start(){
  const {app,store,collector,generation,listing,ocr}=createApp();const dev=process.argv.includes('--dev');
  if(dev){const {createServer}=await import('vite');const vite=await createServer({root:ROOT,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
  else{if(!existsSync(path.join(ROOT,'dist','index.html')))throw new Error('页面尚未构建，请先运行 npm run build。');app.use(express.static(path.join(ROOT,'dist')));app.get('/{*splat}',(req,res)=>res.sendFile(path.join(ROOT,'dist','index.html')));}
  const port=Number(process.env.WORKBENCH_PORT||3210);
  const server=app.listen(port,'127.0.0.1',()=>console.log(`拾物工作台已启动：http://127.0.0.1:${port}`));
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`端口${port}已被占用，请检查工作台是否已启动。`:e.message);process.exit(1);});
  const shutdown=async()=>{await Promise.all([generation.close(),listing.close(),collector.close()]);await ocr.close?.();server.close();store.close();process.exit(0);};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))start().catch(e=>{console.error(e.message);process.exit(1);});
