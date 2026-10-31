import {request} from 'playwright';
import {Store} from '../server/db.js';
import {Collector} from '../server/collector.js';
import {LocalOCR} from '../server/ocr.js';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.join(root,'data');const store=new Store(dataDir);
if(store.jobs().some(j=>['running','queued','waiting','paused'].includes(j.status))){store.close();throw new Error('请先完成或停止当前采集任务，再升级图片。');}
const client=await request.newContext();
const collector=new Collector({store,dataDir,ocr:new LocalOCR(root,dataDir)});collector.context={request:client};
const report=[];
try{
  for(const product of store.products()){
    if(!product.images.length)continue;
    const images=await collector.download(product,{images:product.images});
    const live=store.product(product.id);
    const warnings=[...live.warnings.filter(w=>!w.startsWith('原图升级：'))];
    if(images.some(i=>i.qualityStatus==='fallback'))warnings.push('原图升级：部分原图无法访问，图库中已明确标注缩略图。');
    if(images.some(i=>i.status==='failed'))warnings.push('原图升级：部分图片下载失败，可重新采集重试。');
    store.saveProduct({...live,images,warnings,message:product.message,status:product.status});
    const row={id:product.id,before:product.images.map(i=>({url:i.url,width:i.width,height:i.height})),after:images.map(i=>({url:i.url,width:i.width,height:i.height,qualityStatus:i.qualityStatus,status:i.status,resolutionVerified:i.resolutionVerified}))};report.push(row);
    console.log(JSON.stringify({id:product.id,beforeCount:product.images.length,afterCount:images.length,results:row.after}));
  }
  await mkdir(path.join(root,'output','verification'),{recursive:true});await writeFile(path.join(root,'output','verification','image-quality-v2.json'),JSON.stringify(report,null,2));
}finally{await client.dispose();store.close();}
