export const IMAGE_POLICY_VERSION = 2;

// Remove only known AliCDN delivery transforms; preserve signatures and watermark/crop operations.
export function originalImageUrl(value) {
  try {
    const url=new URL(String(value).startsWith('//')?'https:'+value:value);
    if(!['http:','https:'].includes(url.protocol)||!/(^|\.)(alicdn\.com|1688\.com|alibaba\.com)$/.test(url.hostname))return null;
    if(!/\.(?:jpe?g|png|gif|webp|avif)(?:[_.!]|$)/i.test(url.pathname))return null;
    const transform=url.pathname.match(/\.(?:jpe?g|png|gif|webp|avif)(?=_(?:(?:b|sum|s|m|small|middle|big)(?:[_.]|$)|\d+x\d+|q\d+|\.webp)|\.webp$|!\d+x\d+)/i);
    if(transform)url.pathname=url.pathname.slice(0,transform.index+transform[0].length);
    const processing=url.searchParams.get('x-oss-process');
    if(processing?.startsWith('image/')){
      const parts=processing.split('/').filter((part,i)=>i===0||!/^(?:resize|quality|format|interlace)(?:,|$)/.test(part));
      if(parts.length===1)url.searchParams.delete('x-oss-process');else url.searchParams.set('x-oss-process',parts.join('/'));
    }
    if(/(^|\.)alicdn\.com$/.test(url.hostname)&&url.pathname.includes('/ibank/'))url.searchParams.delete('__r__');
    url.hash='';return url.href;
  }catch{return null;}
}

export function normalizeImages(images){
  const groups=new Map();
  for(const item of images){
    const original=originalImageUrl(item.url);if(!original)continue;
    let image=groups.get(original);
    if(!image){image={...item,url:original,categories:[],skuIds:[],sourceUrls:[],legacyIds:[],candidateUrls:[original],order:groups.size+1};groups.set(original,image);}
    image.legacyIds=[...new Set([...image.legacyIds,...[item.id,...(item.legacyIds||[])].filter(Boolean)])];
    image.categories=[...new Set([...image.categories,...(item.categories||[])])];
    image.skuIds=[...new Set([...image.skuIds,...(item.skuIds||[])])];
    for(const raw of [item.url,...(item.sourceUrls||[]),...(item.candidateUrls||[])]){
      const normalized=originalImageUrl(raw);if(!normalized||normalized!==original)continue;
      const observed=new URL(raw.startsWith('//')?'https:'+raw:raw).href;
      if(!image.sourceUrls.includes(observed))image.sourceUrls.push(observed);
      if(!image.candidateUrls.includes(observed))image.candidateUrls.push(observed);
    }
  }
  return [...groups.values()];
}
