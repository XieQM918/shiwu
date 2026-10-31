import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
export const OCR_VERSION=2;

export class LocalOCR {
  constructor(root, dataDir,{engine=process.env.WORKBENCH_OCR_ENGINE|| (process.platform==='darwin'?'vision':'tesseract')}={}) { this.source = path.join(root,'native','ocr.m'); this.binary = path.join(dataDir,'bin','vision-ocr');this.modelDirectory=path.join(dataDir,'ocr-models'); this.problem = null; this.ready = null;this.engine=engine;if(!['vision','tesseract'].includes(engine))throw new Error('未知图片识别引擎。'); }
  async prepare() {
    if(this.engine==='tesseract'){const {PortableOCR}=await import('./portable-ocr.js');this.portable||=new PortableOCR({modelDirectory:this.modelDirectory});return;}
    if (process.platform !== 'darwin') throw new Error('本机文字识别需要 macOS');
    const [sourceStat, binaryStat] = await Promise.all([stat(this.source), stat(this.binary).catch(() => null)]);
    if (binaryStat && binaryStat.mtimeMs >= sourceStat.mtimeMs) return;
    await mkdir(path.dirname(this.binary), {recursive:true});
    const cache = path.join(path.dirname(this.binary),'module-cache');
    await mkdir(cache,{recursive:true});
    await exec('/usr/bin/xcrun', ['clang','-fobjc-arc','-O2',this.source,'-framework','Foundation','-framework','Vision','-framework','ImageIO','-framework','CoreGraphics','-o',this.binary], {timeout:90000,maxBuffer:2*1024*1024,env:{...process.env,CLANG_MODULE_CACHE_PATH:cache}});
    await access(this.binary);
  }
  async recognize(file) {
    try {
      this.ready ||= this.prepare();
      await this.ready;
      if(this.portable){const result=await this.portable.recognize(file);this.problem=null;return {...result,version:OCR_VERSION};}
      const {stdout} = await exec(this.binary,[file],{timeout:90000,maxBuffer:8*1024*1024});
      this.problem = null;
      return {...JSON.parse(stdout),version:OCR_VERSION};
    } catch (e) { this.problem = /swift|xcrun|developer/i.test(e.message) ? '本机文字识别组件未就绪，请安装 Apple 命令行工具后重试。' : `图片文字识别失败：${e.stderr?.trim() || e.message}`; throw new Error(this.problem); }
  }
  async dimensions(file){
    this.ready ||= this.prepare();await this.ready;
    if(this.portable)return this.portable.dimensions(file);
    const {stdout}=await exec(this.binary,[file,'--info'],{timeout:20000,maxBuffer:1024*1024});
    return JSON.parse(stdout);
  }
  reset(){this.ready=null;this.problem=null;}
  async close(){await this.portable?.close();}
}

export function ocrRecords(result, image, context={}) {
  const rows = [];
  const parameterCard=(result.lines||[]).some(l=>/产品参数|商品参数|PARAMETERS/i.test(l.text));
  if(!parameterCard&&(result.lines||[]).some(l=>/厂家介绍|工厂面积|企业介绍|公司文化/.test(l.text)))return rows;
  const source={kind:'ocr',imageId:image.id,skuId:image.skuIds?.length===1?image.skuIds[0]:undefined,parameterCard};
  // Assign axes for flat brooch diagrams only when both printed rulers are present
  // and their values are corroborated by the printed two-dimensional size tuple.
  const tuple=(result.lines||[]).map(l=>l.text).join('\n').match(/尺寸\s*[:：]\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)/i);
  const normalized=(n,unit)=>Number(n)*(/^(mm|毫米)$/i.test(unit) ? 0.1 : 1);
  const rulerLines=(result.lines||[]).filter(l=>l.rulerAxis&&l.rulerScore>.2).map(l=>{
    const m=l.text.match(/^[\-−–—]?\s*(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)$/i);
    return m?{...l,value:normalized(m[1],m[2])}:null;
  }).filter(Boolean);
  let diagramResolved=false;
  if(parameterCard&&/胸针|胸花|别针/.test(context.productTitle||'')&&tuple){
    const vertical=rulerLines.filter(l=>l.rulerAxis==='vertical'),horizontal=rulerLines.filter(l=>l.rulerAxis==='horizontal');
    if(vertical.length===1&&horizontal.length===1){
      const printed=[normalized(tuple[1],tuple[3]),normalized(tuple[2],tuple[3])].sort((a,b)=>a-b);
      const rulers=[vertical[0].value,horizontal[0].value].sort((a,b)=>a-b);
      if(printed.every((v,i)=>Math.abs(v-rulers[i])<.001)){
        diagramResolved=true;
        for(const [key,label,line] of [['length','长度',vertical[0]],['width','宽度',horizontal[0]]]){
          rows.push({...source,text:`${label}: ${line.value}cm`,path:`图片 ${image.order} · ${key==='length'?'纵向':'横向'}尺寸标注线`,axisEvidence:{axis:line.rulerAxis,label:line.text,tuple:tuple[0],bbox:{x:line.x,y:line.y,width:line.width,height:line.height},score:line.rulerScore},diagramResolved:true});
        }
      }
    }
  }
  // Join only adjacent lines on the same visual row, or a label directly above its value.
  const groups = [];
  for (const line of result.lines || []) {
    let group = groups.find(g => Math.abs(g.y-line.y) < Math.max(.005,Math.min(g.height,line.height)*.55));
    if (!group) { group = {y:line.y,height:line.height,lines:[]}; groups.push(group); }
    group.lines.push(line);
  }
  groups.sort((a,b)=>a.y-b.y);
  groups.forEach((group,i) => {
    group.lines.sort((a,b)=>a.x-b.x);
    let text = group.lines.map(l=>l.text).join(' ');
    if (/^(?:材质|材料|重量|净重|毛重|单重|尺寸|长度|宽度|高度|包装重量)\s*[:：]?$/.test(text.trim()) && groups[i+1] && groups[i+1].y-group.y < group.height*3.5) text = `${text.replace(/[:：]$/,'')}: ${groups[i+1].lines.map(l=>l.text).join(' ')}`;
    // Keep different fields in adjacent table columns as separate evidence records.
    const independentlyLabelled=group.lines.filter(l=>/^(?:材质|材料|重量|净重|毛重|单重|尺寸|长度|宽度|高度)\s*[:：]/.test(l.text));
    const texts=independentlyLabelled.length>1?independentlyLabelled.map(l=>l.text):[text];
    for(const value of texts)if (/材质|材料|尺寸|长|宽|高|重量|净重|单重|毛重|包装/.test(value)) rows.push({...source,text:value,path:`图片 ${image.order} · 纵向 ${Math.round(group.y*100)}%`,diagramResolved});
  });
  return rows;
}
