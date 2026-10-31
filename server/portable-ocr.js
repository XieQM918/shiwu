import sharp from 'sharp';
import {createWorker,PSM} from 'tesseract.js';
import {mkdir,copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
export function modelFile(code){return path.join(path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)),'4.0.0_best_int',`${code}.traineddata.gz`);}
function darkRatio(pixels,w,h,fixed,start,end,vertical){const limit=vertical?h:w,cross=vertical?w:h;if(fixed<0||fixed>=cross)return 0;start=Math.max(0,Math.trunc(start));end=Math.min(limit,Math.trunc(end));if(end-start<25)return 0;let dark=0;for(let n=start;n<end;n++)if(pixels[vertical?n*w+fixed:fixed*w+n]<145)dark++;return dark/(end-start);}
export function rulerEvidence(pixels,w,h,line){
  if(!pixels||!/^[\-−–—]?\s*\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米)$/i.test(line.text))return {};
  const {x,y,width:bw,height:bh}=line,cx=(x+bw/2)*w,cy=(y+bh/2)*h;
  const rx=Math.max(4,Math.trunc(bw*w*.18)),ry=Math.max(4,Math.trunc(bh*h*.6));let vertical=0,horizontal=0;
  for(let c=Math.trunc(cx)-rx;c<=Math.trunc(cx)+rx;c++)vertical=Math.max(vertical,Math.min(darkRatio(pixels,w,h,c,cy-.16*h,y*h-.012*h,true),darkRatio(pixels,w,h,c,(y+bh)*h+.012*h,cy+.16*h,true)));
  for(let r=Math.trunc(cy)-ry;r<=Math.trunc(cy)+ry;r++)horizontal=Math.max(horizontal,Math.min(darkRatio(pixels,w,h,r,cx-.19*w,x*w-.012*w,false),darkRatio(pixels,w,h,r,(x+bw)*w+.012*w,cx+.19*w,false)));
  return vertical>.2&&vertical>horizontal+.12?{rulerAxis:'vertical',rulerScore:vertical}:horizontal>.2&&horizontal>vertical+.12?{rulerAxis:'horizontal',rulerScore:horizontal}:{};
}
const normalize=text=>text.trim().replace(/材\s+质/g,'材质').replace(/重\s+量/g,'重量').replace(/尺\s+寸/g,'尺寸').replace(/净\s+重/g,'净重').replace(/长\s+度/g,'长度').replace(/宽\s+度/g,'宽度');
export class PortableOCR{
  constructor({idleMs=30000,modelDirectory=path.resolve(import.meta.dirname,'../data/ocr-models')}={}){this.idleMs=idleMs;this.modelDirectory=modelDirectory;this.worker=null;this.initializing=null;this.queue=Promise.resolve();}
  async workerReady(){
    if(this.worker)return this.worker;if(this.initializing)return this.initializing;
    this.initializing=(async()=>{
      // Models and WASM are installed by npm ci. No image upload or runtime CDN request.
      await mkdir(this.modelDirectory,{recursive:true});await Promise.all(['chi_sim','eng'].map(code=>copyFile(modelFile(code),path.join(this.modelDirectory,`${code}.traineddata.gz`))));
      this.worker=await createWorker('chi_sim+eng',1,{langPath:this.modelDirectory,cacheMethod:'none',errorHandler:()=>{}},{load_system_dawg:'0',load_freq_dawg:'0'});
      await this.worker.setParameters({tessedit_pageseg_mode:PSM.SPARSE_TEXT,preserve_interword_spaces:'1',user_defined_dpi:'150'});return this.worker;
    })();try{return await this.initializing;}finally{this.initializing=null;}
  }
  async dimensions(file){const metadata=await sharp(file,{limitInputPixels:120000000}).metadata();if(!metadata.width||!metadata.height)throw new Error('图片像素无法读取');return {width:metadata.width,height:metadata.height};}
  recognize(file){const work=this.queue.then(()=>this.recognizeImage(file));this.queue=work.catch(()=>{});return work;}
  async recognizeImage(file){
    clearTimeout(this.idle);let timer;
    const recognize=async()=>{
      const {width,height}=await this.dimensions(file);const worker=await this.workerReady();const lines=[];
      const pixels=width*height<=40000000&&height<=width*4?await sharp(file).removeAlpha().greyscale().raw().toBuffer():null;
      let segment=0;
      for(let top=0;top<height;top+=2040){
        const h=Math.min(2200,height-top);const crop=await sharp(file).extract({left:0,top,width,height:h}).png().toBuffer();
        const {data}=await worker.recognize(crop,{tessedit_pageseg_mode:PSM.SPARSE_TEXT,tessedit_char_whitelist:''}, {text:true,blocks:true});
        for(const block of data.blocks||[])for(const paragraph of block.paragraphs||[])for(const row of paragraph.lines||[]){
          const text=normalize(row.text);if(!text)continue;const b=row.bbox;
          const line={text,confidence:Math.max(0,Math.min(1,(row.confidence||0)/100)),x:b.x0/width,y:(top+b.y0)/height,width:(b.x1-b.x0)/width,height:(b.y1-b.y0)/height,segment};
          if(!lines.some(l=>l.text===line.text&&Math.abs(l.x-line.x)<.02&&Math.abs(l.y-line.y)<.012))lines.push({...line,...rulerEvidence(pixels,width,height,line)});
        }
        if(top+h>=height)break;segment++;
      }
      const text=lines.map(l=>l.text).join('\n');const tuple=text.match(/尺寸\s*[:：]\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(cm|mm|厘米|毫米)/i);
      if(tuple&&/产品\s*参数|PARAMETERS/i.test(text)){
        const printed=[Number(tuple[1]),Number(tuple[2])];let refinements=0;
        for(const line of lines){const number=line.text.match(/^[\-−–—]?\s*(\d+(?:\.\d+)?)/);if(!line.rulerAxis||!number||printed.includes(Number(number[1]))||refinements>=2)continue;
          const left=Math.max(0,Math.floor(line.x*width)-4),top=Math.max(0,Math.floor(line.y*height)-2),w=Math.min(width-left,Math.ceil(line.width*width)+8),h=Math.min(height-top,Math.ceil(line.height*height)+4);
          const gray=await sharp(file).extract({left,top,width:w,height:h}).removeAlpha().greyscale().raw().toBuffer();const textRows=[];
          for(let y=0;y<h;y++){let count=0;for(let x=0;x<w;x++)if(gray[y*w+x]<170)count++;if(count>Math.max(5,w*.07))textRows.push(y);}
          const trimTop=textRows.length?Math.max(0,textRows[0]-2):0,trimBottom=textRows.length?Math.min(h,textRows.at(-1)+3):h;
          const label=await sharp(file).extract({left,top:top+trimTop,width:w,height:trimBottom-trimTop}).resize({width:w*4}).greyscale().normalise().png().toBuffer();
          const {data}=await worker.recognize(label,{tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:'0123456789.cm-毫米厘米'},{text:true});refinements++;
          const refined=normalize(data.text);line.refinementRead=refined;const matched=refined.match(/^[\-−–—]?\s*(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)$/i);
          if(matched&&printed.includes(Number(matched[1]))){line.originalOcrText=line.text;line.text=refined;line.refinement='原图标注区域局部文字重读，并与原文互证';}
        }
      }
      lines.sort((a,b)=>Math.abs(a.y-b.y)<.004?a.x-b.x:a.y-b.y);return {width,height,lines,engine:'tesseract-local'};
    };
    try{return await Promise.race([recognize(),new Promise((_,reject)=>{timer=setTimeout(()=>{this.close().catch(()=>{});reject(new Error('本机图片识别超过90秒，已停止本图识别。'));},90000);})]);}
    catch(e){await this.close();throw new Error(e.message||String(e));}
    finally{clearTimeout(timer);this.idle=setTimeout(()=>this.close().catch(()=>{}),this.idleMs);this.idle.unref();}
  }
  async close(){clearTimeout(this.idle);const worker=this.worker;this.worker=null;if(worker)await worker.terminate();}
}
