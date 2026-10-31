export const FIELD_DEFS = [
  ['length', '长', 'cm'], ['width', '宽', 'cm'], ['height', '高', 'cm'],
  ['weight', '净重', 'g'], ['material', '材质', ''],
  ['packageLength', '包装长', 'cm'], ['packageWidth', '包装宽', 'cm'],
  ['packageHeight', '包装高', 'cm'], ['packageWeight', '包装重量', 'g'],
];
export const emptyField = () => ({ value: null, status: 'missing', raw: '', sources: [], candidates: [] });
export const emptyFields = () => Object.fromEntries(FIELD_DEFS.map(([k]) => [k, emptyField()]));

export function cleanLinkLine(original){
  let s=String(original||'').trim().replace(/\\([:&/])/g,'$1');
  const md=s.match(/\]\((https?:\/\/[^\s)]+)\)/i);
  if(md)return md[1];
  const shared=s.match(/https?:\/\/[^\s<>"“”]+/i);
  if(shared)s=shared[0].replace(/[)\]】）》〉，。；;！!]+$/g,'');
  return s;
}

export function parseLinks(input) {
  const valid = [], invalid = [], seen = new Set();
  const lines = String(input || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const original of lines) {
    const s=cleanLinkLine(original);
    try {
      const u = new URL(s);
      const m = u.pathname.match(/^\/offer\/(\d+)\.html\/?$/);
      if (!['https:', 'http:'].includes(u.protocol) || !['detail.1688.com','m.1688.com'].includes(u.hostname) || u.port || u.username || u.password || !m) throw new Error();
      if (!seen.has(m[1])) { valid.push({ id: m[1], url: `https://detail.1688.com/offer/${m[1]}.html` }); seen.add(m[1]); }
    } catch { invalid.push(original); }
  }
  return { valid, invalid, duplicates: lines.length - valid.length - invalid.length, tooMany: valid.length > 30 };
}

function unitNumber(n, unit, kind) {
  const v = Number(n);
  const factors = kind === 'weight'
    ? { g: 1, '克': 1, kg: 1000, '千克': 1000, '公斤': 1000, mg: .001, '毫克': .001, '斤': 500, '两': 50 }
    : { mm: .1, '毫米': .1, cm: 1, '厘米': 1, '公分': 1, m: 100, '米': 100, '英寸': 2.54, inch: 2.54, in: 2.54 };
  const factor = factors[unit.toLowerCase()];
  return factor == null || !Number.isFinite(v) || v <= 0 ? null : Math.round(v * factor * 10000) / 10000;
}

// Only explicitly labelled dimensions are assigned axes. A bare “3×2cm” stays in the evidence.
export function extractFields(records) {
  const fields = emptyFields();
  const add = (key, value, raw, source, uncertain = false) => {
    if (value == null || value === '') return;
    fields[key].candidates.push({ value, raw, source, uncertain: uncertain || source.kind === 'ocr' });
  };
  for (const record of records) {
    const text = String(record.text || '').replace(/：/g, ':').replace(/ＣＭ/gi, 'cm').replace(/ＭＭ/gi, 'mm');
    const source = { kind: record.kind || 'page', text: record.text, imageId: record.imageId, skuId: record.skuId, path: record.path,unassigned:record.unassigned||undefined,skuLabel:record.skuLabel||undefined,parameterCard:record.parameterCard||undefined,axisEvidence:record.axisEvidence };
    const packageAt = (index,label='') => {
      if (/包装|毛重/.test(label)) return true;
      if (/产品|净重|单重|单个/.test(label)) return false;
      const prefix=text.slice(0,index);
      const markers=[...prefix.matchAll(/包装|包裹|外箱|装箱|产品|商品|单个/g)];
      return /包装|包裹|外箱|装箱/.test(markers.at(-1)?.[0]||'');
    };
    const ambiguous = Boolean(record.unassigned)||/每对|一对|一套|整套|每套|个\/对|约|参考|左右|误差|±|至|\d\s*[-~～]\s*\d|\d\s*\/\s*\d/.test(text);
    const dimension = /(包装长|包装宽|包装高|产品长|产品宽|产品高|长度|宽度|高度|长|宽|高)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(毫米|厘米|公分|英寸|mm|cm|inch|in|米|m)(?![a-z])/gi;
    let match;
    while ((match = dimension.exec(text))) {
      const axis = /长/.test(match[1]) ? 'Length' : /宽/.test(match[1]) ? 'Width' : 'Height';
      const k = packageAt(match.index,match[1]) ? `package${axis}` : axis.toLowerCase();
      add(k, unitNumber(match[2], match[3], 'dimension'), match[0], source, ambiguous);
    }
    const tuple = text.match(/(长\s*[×xX*／/]\s*宽\s*[×xX*／/]\s*高|长宽高)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(毫米|厘米|公分|mm|cm|米|m)(?![a-z])/i);
    if (tuple) ['Length','Width','Height'].forEach((axis, i) => add(packageAt(tuple.index) ? `package${axis}` : axis.toLowerCase(), unitNumber(tuple[i + 2], tuple[5], 'dimension'), tuple[0], source, ambiguous));
    const weight = /(包装重量|包装重|毛重|净重|单重|重量|产品重量|单个重量)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(千克|公斤|毫克|kg|mg|克|g|斤|两)(?![a-z])/gi;
    while ((match = weight.exec(text))) {
      const k = packageAt(match.index,match[1]) ? 'packageWeight' : 'weight';
      // An unlabeled “重量” may describe a pair/set; retain the candidate for confirmation.
      const unspecified = !/净重|单个|单重/.test(match[1]) && k === 'weight';
      add(k, unitNumber(match[2], match[3], 'weight'), match[0], source, ambiguous || unspecified);
    }
    const material = text.match(/(?:主要材质|主体材质|产品材质|材质|材料)\s*[:=]\s*([^\n;；|]{1,100})/);
    if (material) add('material', material[1].split(/\s+(?:处理工艺|工艺|品牌|风格|颜色|产地|货号|尺寸|重量)\s*[:：]?/)[0].trim(), material[0], source, ambiguous);
    const range=text.match(/(长度|宽度|高度|长|宽|高)\s*[:=]?\s*\d+(?:\.\d+)?\s*[-~～至]\s*\d+(?:\.\d+)?\s*(?:毫米|厘米|mm|cm|米|m)(?![a-z])/i);
    if(range){const axis=/长/.test(range[1])?'Length':/宽/.test(range[1])?'Width':'Height';const key=packageAt(range.index,range[1])?`package${axis}`:axis.toLowerCase();fields[key].candidates.push({value:null,raw:range[0],source,uncertain:true});}
    const size = text.match(/(?:尺寸|规格|大小)\s*[:=]\s*[^\n;；]{0,80}/);
    if (size && !record.diagramResolved && /\d(?:\.\d+)?\s*(?:mm|cm|m|毫米|厘米|公分|英寸)(?![a-z])/i.test(size[0]) && !tuple && !/(?:长|宽|高)\s*[:=]?\s*\d/.test(size[0])) {
      for (const key of ['length', 'width', 'height']) fields[key].candidates.push({ value: null, raw: size[0], source, uncertain: true });
    }
  }
  for (const f of Object.values(fields)) {
    const unique = [...new Map(f.candidates.map(c => [JSON.stringify([c.value,c.raw,c.source.kind,c.source.imageId,c.source.path]), c])).values()];
    f.candidates = unique;
    f.sources = unique.map(c => c.source);
    f.raw = [...new Set(unique.map(c => c.raw))].join('；');
    const page=unique.filter(c=>c.source.kind==='page'&&!c.source.unassigned);
    const parameterCard=unique.filter(c=>c.source.parameterCard&&c.value!=null);
    const deciding=page.some(c=>c.value!=null&&!c.uncertain)?page:parameterCard.length?parameterCard:page.some(c=>c.value!=null)?page:unique;
    const values = [...new Set(deciding.filter(c => c.value != null).map(c => c.value))];
    if (values.length === 1) f.value = values[0];
    if (values.length > 1 || deciding.some(c => c.uncertain) || (unique.length && !values.length)) f.status = 'review';
    else if (values.length === 1) f.status = 'found';
  }
  return fields;
}

export function preserveManual(fresh, old) {
  const fields = { ...fresh };
  for (const [key, val] of Object.entries(old || {})) if (val.status === 'manual') fields[key] = structuredClone(val);
  return fields;
}

export function summarizeFields(fields, variants) {
  const result = structuredClone(fields);
  for (const [key] of FIELD_DEFS) {
    if (result[key]?.status === 'manual') continue;
    const vals = variants.map(v => v.fields?.[key]).filter(Boolean);
    if (!vals.length) continue;
    const nonMissing = vals.filter(f => f.status !== 'missing');
    if (!nonMissing.length) continue;
    const distinct = new Set(nonMissing.map(f => JSON.stringify(f.value)));
    if (distinct.size > 1 || nonMissing.length !== vals.length || nonMissing.some(f => f.status === 'review')) {
      result[key] = { ...emptyField(), status: 'variants', raw: '请展开核对不同规格', candidates: nonMissing.flatMap(f => f.candidates || []), sources: nonMissing.flatMap(f => f.sources || []) };
    } else {
      const f = structuredClone(nonMissing[0]);
      // A derived common value is not an independent manual override on the product.
      if(f.status==='manual'){f.status='found';delete f.manualAt;}
      const own = result[key];
      if (own?.value != null && f.value != null && own.value !== f.value) {
        result[key] = { ...own, value: null, status: 'review', raw: [own.raw, f.raw].filter(Boolean).join('；'), sources: [...(own.sources || []), ...(f.sources || [])], candidates: [...(own.candidates || []), ...(f.candidates || [])] };
      } else result[key] = f;
    }
  }
  return result;
}

export function fieldLabel(f) {
  if (!f || f.status === 'missing') return '未找到';
  if (f.status === 'variants') return '多规格';
  if (f.status === 'review') return f.value == null ? '待确认' : `${f.value}（待确认）`;
  return f.value ?? '未找到';
}

export function newProduct(link) {
  return { ...link, title: '', supplier: '', status: 'queued', message: '等待采集', fields: emptyFields(), variants: [], images: [], records: [], warnings: [], updatedAt: new Date().toISOString() };
}
