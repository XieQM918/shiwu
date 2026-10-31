import {parseLinks,cleanLinkLine} from './domain.js';

function shareUrl(value){
  try{const u=new URL(value);if(['https:','http:'].includes(u.protocol)&&u.hostname==='qr.1688.com'&&!u.port&&!u.username&&!u.password&&/^\/s\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))return `https://qr.1688.com${u.pathname.replace(/\/$/,'')}`;}catch{}
  return null;
}
function unpackTarget(value){
  let text=String(value).trim().replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/\\\//g,'/').replace(/\\u0026/gi,'&');
  for(let n=0;n<4;n++){
    try{
      const u=new URL(text);
      if(['https:','http:'].includes(u.protocol)&&!/[\s<>"']/.test(text)){const product=parseLinks(u.href).valid[0];if(product)return product;}
      if(u.protocol==='wireless1688:'&&u.hostname==='ma.m.1688.com'&&u.pathname==='/plugin'){
        const nested=u.searchParams.get('url');if(nested){text=nested;continue;}
      }
    }catch{}
    try{const decoded=decodeURIComponent(text);if(decoded===text)break;text=decoded;}catch{break;}
  }
  return null;
}
function bodyTarget(text){
  const direct=unpackTarget(text);if(direct)return direct;
  const candidates=[];
  try{const json=JSON.parse(text);for(const key of ['url','targetUrl','redirectUrl'])if(typeof json[key]==='string')candidates.push(json[key]);}catch{}
  for(const match of text.matchAll(/(?:window\.|top\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|(?:window\.)?location\.replace\(\s*['"]([^'"]+)['"]/gi))candidates.push(match[1]||match[2]);
  for(const tag of text.matchAll(/<meta\b[^>]*>/gi))if(/http-equiv\s*=\s*['"]?refresh/i.test(tag[0])){const match=tag[0].match(/\bcontent\s*=\s*["'][^"']*?url\s*=\s*([^"']+)/i);if(match)candidates.push(match[1]);}
  for(const candidate of candidates){const product=unpackTarget(candidate);if(product)return product;}
  return null;
}
async function boundedText(response){
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024)throw new Error('分享链接返回内容异常，请复制商品详情链接。');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}

export function createLinkResolver({fetchImpl=fetch,timeoutMs=10000,cacheMs=15*60*1000}={}){
  const cache=new Map(),pending=new Map();
  async function resolveShare(url){
    const hit=cache.get(url);if(hit&&hit.expires>Date.now())return hit.product;
    if(pending.has(url))return pending.get(url);
    const work=(async()=>{
      let current=url;const seen=new Set();const signal=AbortSignal.timeout(timeoutMs);
      try{
        for(let n=0;n<5;n++){
          if(seen.has(current))throw new Error('分享链接发生循环跳转，请复制商品详情链接。');seen.add(current);
          const response=await fetchImpl(current,{redirect:'manual',signal,headers:{'User-Agent':'Mozilla/5.0','Accept':'text/html,text/plain,application/json'}});
          if(response.status>=300&&response.status<400){
            const location=response.headers.get('location');await response.body?.cancel().catch(()=>{});
            if(!location)throw new Error('分享链接缺少跳转目标。');
            const target=new URL(location,current).href;const product=unpackTarget(target);if(product)return product;
            const next=shareUrl(target);if(!next)throw new Error('分享链接没有指向可识别的1688商品。');current=next;continue;
          }
          if(!response.ok){await response.body?.cancel().catch(()=>{});throw new Error(`分享链接暂时无法打开（HTTP ${response.status}），请稍后重试或复制商品详情链接。`);}
          const product=bodyTarget(await boundedText(response));if(product)return product;
          throw new Error('分享链接未返回明确商品地址，可能已失效或需要验证；请复制商品详情链接。');
        }
        throw new Error('分享链接跳转次数过多，请复制商品详情链接。');
      }catch(e){if(signal.aborted||e.name==='TimeoutError')throw new Error('分享链接解析超时，请稍后重试或复制商品详情链接。');throw e;}
    })();
    pending.set(url,work);
    try{const product=await work;if(cache.size>500)cache.clear();cache.set(url,{product,expires:Date.now()+cacheMs});return product;}finally{pending.delete(url);}
  }
  return async function resolveLinks(input){
    const lines=String(input||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if(lines.length>100)return {valid:[],invalid:[],duplicates:0,tooMany:true,errors:[],resolved:[]};
    const results=[];
    // Bound concurrent requests even for pasted batches of share links.
    for(let offset=0;offset<lines.length;offset+=4){
      results.push(...await Promise.all(lines.slice(offset,offset+4).map(async original=>{
        const direct=parseLinks(original).valid[0];if(direct)return {original,product:direct};
        const short=shareUrl(cleanLinkLine(original));if(!short)return {original,error:'请输入1688商品详情链接或 qr.1688.com 分享链接。'};
        try{return {original,product:await resolveShare(short),short:true};}catch(e){return {original,error:e.message};}
      })));
    }
    const valid=[],invalid=[],errors=[],resolved=[],seen=new Set();let duplicates=0;
    for(const r of results){
      if(r.error){invalid.push(r.original);errors.push({input:r.original,message:r.error});continue;}
      if(r.short)resolved.push({input:r.original,...r.product});
      if(seen.has(r.product.id)){duplicates++;continue;}seen.add(r.product.id);valid.push(r.product);
    }
    return {valid,invalid,errors,resolved,duplicates,tooMany:valid.length>30};
  };
}
