// Human-readable observations, not a copy of sellers' private tags or product promises.
export const REFERENCE_VERSION='2026-10-31-v1';
const base='https://www.etsy.com/listing/';
export const REFERENCES=[
  {id:'4592883696',url:base+'4592883696/fashion-no-piercing-ear-cuff-minimalist',category:'ear-clip',status:'blocked',summary:'访问验证限制；未读取到可采信的商品内容，不参与风格提炼。'},
  {id:'1816407842',url:base+'1816407842/thick-irregular-ear-cuff-earring-no',category:'ear-clip',status:'read',shop:'SeaSideMotifs',summary:'标题先说明耳骨夹的形态及佩戴方式。描述用短段落交代穿搭，再分列材质、内径、调整方式及购买选项。只参考结构，不继承该商品承诺。'},
  {id:'1830576925',url:base+'1830576925/dainty-double-ear-cuff-earring-no',category:'ear-clip',status:'read',shop:'SeaSideMotifs',summary:'说明双层造型及无需耳洞的佩戴形式，再分列参数与选项。和上一条属于同一商家，不能当作两个独立店铺的共识。'},
  {id:'4602163123',url:base+'4602163123/enamel-floral-brooch-with-freshwater',category:'brooch',status:'partial',shop:'NolaArc',summary:'已读取标题和基础属性；标题连接花卉胸针的设计特点与西装、大衣等佩戴位置。完整描述尚未读取，不推断后台标签。'},
  {id:'4380058206',url:base+'4380058206/flower-flower-brooch-jewellery-jewelry',category:'brooch',status:'read',shop:'Becyanodesign',summary:'描述关注花卉造型、穿搭及礼赠场景，另列尺寸和材质。标题有重复堆词，不照搬；品牌故事、包装和产地不迁移。'}
].map(r=>({...r,observedAt:'2026-10-31',sourceType:'public-listing-observation',privateTagsAvailable:false,referenceVersion:REFERENCE_VERSION}));
export const BASELINE={version:REFERENCE_VERSION,voice:'清楚、自然、克制，重视设计细节和实际佩戴。英文原创表达，不复制商家句子或堆砌奢华形容词。',title:'商品类型与关键设计特点在前；仅在确有依据时加入材质与佩戴方式。',description:'先用短段落说明造型和搭配，再列真实参数与规格选项；礼赠只描述适用场景，不承诺包装、数量或物流。',tags:'基于当前商品组合品类、造型、风格、已确认颜色/材质与合适用途；建议标签不等于商家后台标签，没有搜索热度数据。'};
