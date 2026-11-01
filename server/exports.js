import ExcelJS from 'exceljs';
import archiver from 'archiver';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { FIELD_DEFS,fieldLabel } from './domain.js';
import {weightParts} from './weight.js';
import {cleanDownloadFiles} from './download-cleaner.js';

const states={queued:'等待采集',running:'采集中',waiting:'等待验证',paused:'已暂停',stopped:'已停止',done:'已采集',partial:'部分采集',failed:'采集失败'};
const categories={main:'01-主图',sku:'02-规格图',detail:'03-详情图'};
const baseColumns=[{header:'商品编号',key:'id',width:22},{header:'商品名称',key:'title',width:45},{header:'商品链接',key:'url',width:55},{header:'供应商',key:'supplier',width:28}];
const visibleFields=FIELD_DEFS.filter(([key])=>!key.startsWith('package'));
const valueColumns=visibleFields.map(([key,label,unit])=>({header:`${label}${unit?`（${unit}）`:''}`,key,width:key==='material'?25:18})).concat([{header:'净重（lb整数）',key:'weightLb',width:18},{header:'净重（剩余oz）',key:'weightOz',width:18}]);
function values(fields){const raw=Object.fromEntries(visibleFields.map(([key])=>[key,fieldLabel(fields?.[key])]));const w=fields?.weight;const p=w?.status!=='variants'?weightParts(w?.value):null;return {...raw,weightLb:p?p.lb:fieldLabel(w),weightOz:p?(p.oz.startsWith('<')?p.oz:Number(p.oz)):fieldLabel(w)};}
function sources(fields){return visibleFields.map(([key,label])=>{const f=fields?.[key];if(!f || f.status==='missing')return '';return `${label}: ${f.status==='manual'?'[人工修改] ':''}${f.raw||''} ${(f.sources||[]).map(s=>`[${s.kind==='ocr'?'图片识别':'网页'}${s.imageId?':'+s.imageId:''}] ${s.text||''}`).join(' | ')}`;}).filter(Boolean).join('\n');}
export async function workbookBuffer(products,listings=[]){
  const workbook=new ExcelJS.Workbook();workbook.creator='拾物 · 1688商品工作台';workbook.created=new Date();
  const main=workbook.addWorksheet('商品汇总');
  main.columns=[...baseColumns,...valueColumns,{header:'图片数量',key:'images',width:12},{header:'下载失败数',key:'failedImages',width:14},{header:'采集状态',key:'status',width:18},{header:'采集说明',key:'message',width:45},{header:'提示',key:'warnings',width:65},{header:'参数原文与来源',key:'sources',width:90},{header:'采集时间',key:'time',width:26}];
  const variants=workbook.addWorksheet('规格明细');
  variants.columns=[...baseColumns.slice(0,3),{header:'规格编号',key:'skuId',width:26},{header:'规格名称',key:'skuLabel',width:38},{header:'规格类型',key:'variantMode',width:20},...valueColumns,{header:'关联图片编号',key:'imageIds',width:45},{header:'参数原文与来源',key:'sources',width:90}];
  for(const p of products){
    main.addRow({...p,...values(p.fields),images:p.images.filter(i=>i.status==='downloaded').length,failedImages:p.images.filter(i=>i.status==='failed').length,status:states[p.status]||p.status,warnings:p.warnings.join('\n'),sources:sources(p.fields),time:p.collectedAt||''});
    for(const v of p.variants)variants.addRow({...p,...values(v.fields),skuId:v.id,skuLabel:v.label,variantMode:p.variantMode==='options'?'规格选项（非完整SKU）':'SKU',imageIds:p.images.filter(i=>i.skuIds.includes(v.id)).map(i=>i.id).join(', '),sources:sources(v.fields)});
  }
  const copy=workbook.addWorksheet('Etsy 上架文案');
  copy.columns=[{header:'商品编号',key:'id',width:22},{header:'英文标题',key:'title',width:65},{header:'英文描述',key:'description',width:100},{header:'建议标签（非商家后台标签）',key:'tags',width:65},{header:'中文核对说明',key:'notesZh',width:80},{header:'标题版本',key:'titleVersion',width:38},{header:'描述版本',key:'descriptionVersion',width:38},{header:'标签版本',key:'tagsVersion',width:38}];
  for(const p of products){const listing=listings.find(l=>l.productId===p.id);copy.addRow({id:p.id,...listing?.content,tags:listing?.content.tags.join(', ')||'',notesZh:listing?.notesZh.join('\n')||'尚未生成',titleVersion:listing?.fields.title||'',descriptionVersion:listing?.fields.description||'',tagsVersion:listing?.fields.tags||''});}
  for(const sheet of [main,variants,copy]){
    sheet.views=[{state:'frozen',ySplit:1,xSplit:2}];sheet.autoFilter={from:'A1',to:{row:1,column:sheet.columnCount}};
    sheet.getRow(1).height=30;sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF24362E'}};
    sheet.eachRow((row,n)=>{if(n===1)return;row.alignment={vertical:'top',wrapText:true};row.height=48;if(n%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F6F4'}};});
  }
  return workbook.xlsx.writeBuffer();
}

export async function zipImages(res,products,dataDir){
  const entries=[],manifests=[];
  for(const p of products){
    const folder=`${p.id}-${(p.title||'商品').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,60)}`;
    const manifest={offerId:p.id,title:p.title,url:p.url,collectedAt:p.collectedAt,variantMode:p.variantMode,variants:p.variants.map(v=>({id:v.id,label:v.label})),warnings:p.warnings,images:[]};
    for(const image of p.images){
      let zipPath=null,index=null;
      if(image.status==='downloaded'&&image.relativePath){
        const file=path.resolve(dataDir,'images',image.relativePath);const root=path.resolve(dataDir,'images');
        if(file.startsWith(root+path.sep))try{await access(file);zipPath=`${categories[image.categories[0]]||'其他'}/${String(image.order).padStart(3,'0')}-${path.basename(file)}`;index=entries.length;entries.push({file,name:folder+'/'+zipPath});}catch{}
      }
      manifest.images.push({id:image.id,url:image.url,resolvedUrl:image.resolvedUrl,sourceUrls:image.sourceUrls,width:image.width,height:image.height,qualityStatus:image.qualityStatus,resolutionVerified:image.resolutionVerified,categories:image.categories,skuIds:image.skuIds,order:image.order,status:zipPath?'downloaded':image.status==='downloaded'?'file_missing':image.status,error:image.error,file:zipPath,index});
    }
    manifests.push({folder,manifest});
  }
  const cleaned=await cleanDownloadFiles(entries);let disposed=false;const dispose=()=>{if(!disposed){disposed=true;cleaned.cleanup().catch(()=>{});}};res.once('finish',dispose);res.once('close',dispose);
  res.setHeader('X-Image-Metadata-Cleanup','completed');const archive=archiver('zip',{zlib:{level:5}});archive.on('error',err=>{dispose();res.destroy(err);});res.on('close',()=>{if(!res.writableEnded)archive.abort();});archive.pipe(res);
  for(const entry of cleaned.files)if(entry.file)archive.file(entry.file,{name:entry.name});
  for(const {folder,manifest} of manifests){for(const image of manifest.images){if(image.index!==null){const entry=cleaned.files[image.index];image.metadataCleanup=entry.cleaning;if(!entry.file){image.file=null;image.status='metadata_cleanup_'+entry.cleaning.status;}}delete image.index;}archive.append(JSON.stringify(manifest,null,2),{name:folder+'/图片清单.json'});}
  archive.append(JSON.stringify(cleaned.report,null,2),{name:'元数据清理报告.json'});await archive.finalize();
}
