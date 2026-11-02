import {webModelLabel} from '../server/image-model.js';
import React,{useEffect,useState,useRef} from 'react';
import {PromptDialog} from './ContentTools.jsx';
import {Sparkles,LoaderCircle,X,ArrowDownToLine,FolderDown,RefreshCw,Play,Square,TriangleAlert,CheckCircle2,Clock3,Image as ImageIcon} from 'lucide-react';


const LABELS={queued:'等待生成',running:'正在生成',paused:'已暂停',stopped:'已停止',done:'全部完成',partial:'部分完成',failed:'生成失败',blocked:'需要补充依据',pending:'等待生成',completed:'已完成'};
const active=job=>['queued','running'].includes(job?.status);
const groups=[['use','使用主图'],['overview','完整外观'],['angle','不同角度'],['scale','手持尺度']];
const imageUrl=(jobId,candidate)=>`/api/generation-jobs/${candidate.assetJobId||jobId}/images/${candidate.id}?${candidate.status==='completed'?'':'preview=1&'}v=${candidate.hash||candidate.preview?.hash||''}`;
function candidateMessage(c){
  if(c.status==='completed')return c.recommendation||c.reason;
  if(c.preview&&/(?:未返回|没有返回).*(?:图片|图像|路径)/.test(c.reason||''))return '图片已保存，但本次未完成核验；可下载草稿，请确认商品细节后使用。';
  return c.reason||c.viewBrief||'按队列顺序生成，每张都会核对原图。';
}

function queueInfo(job,history){
  if(job?.status!=='queued')return null;
  const queued=history.filter(j=>j.status==='queued').sort((a,b)=>(a.kind==='adjustment'?0:1)-(b.kind==='adjustment'?0:1)||a.createdAt.localeCompare(b.createdAt));
  const position=Math.max(1,queued.findIndex(j=>j.id===job.id)+1);const running=history.find(j=>j.status==='running'&&j.id!==job.id);
  return {label:'排队第 '+position+' 位 · 尚未开始',message:running?'正在等待前面的任务：'+running.skuLabel+'（商品 '+running.productId+'），已完成 '+running.completed+'/'+running.total+' 张。当前：'+(running.current||'准备中')+'。本任务尚未开始调用生图。':'已加入队列，等待调度开始；当前尚未调用生图。'};
}

export function GenerationActions({product,variant,disabled,onStart,onOpen,history=[]}){
  const job=history.find(j=>j.productId===product.id&&j.skuId===variant.id&&j.kind!=='adjustment')||variant.generation;const queue=queueInfo(job,history);
  return <div className="generation-actions">
    <button className="button generation-button" disabled={disabled||active(job)} onClick={()=>onStart(product,variant)} aria-label={`为${variant.label}生成 Etsy 图片`}>
      {job?.status==='queued'?<Clock3 size={14}/>:active(job)?<LoaderCircle size={14} className="spin"/>:<Sparkles size={14}/>}生成 Etsy 图片
    </button>
    {!job&&<small>最多6张：主图1、外观1、角度3、手持1；缺少依据则跳过。</small>}
    {job&&<div className="generation-row-status"><span className={job.status==='failed'?'text-red':''}>{queue?queue.label:LABELS[job.status]+' · '+job.completed+'/'+job.total}</span><button className="text-button" onClick={()=>onOpen(job.id)}>{job.completed?'查看成品':'查看进度'}</button></div>}
  </div>;
}

export function GenerationPanel({jobId,history,onClose,onCreated,onRefresh}){
  const [showPreferences,setShowPreferences]=useState(false);const [job,setJob]=useState(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [zoom,setZoom]=useState(null);
  const [versions,setVersions]=useState([]);const [chosen,setChosen]=useState({});const historyRef=useRef(history);historyRef.current=history;const bodyRef=useRef(null);const positioned=useRef(false);
  useEffect(()=>{
    let alive=true,loading=false,first=true;const cache=new Map();
    const read=async id=>{const r=await fetch('/api/generation-jobs/'+id);const j=await r.json();if(!r.ok)throw new Error(j.error);return j;};
    const load=async()=>{if(loading)return;loading=true;try{
      const requested=await read(jobId);let root=requested;const seen=new Set();
      while(root.parentJobId&&!seen.has(root.id)){seen.add(root.id);root=await read(root.parentJobId);}
      const all=historyRef.current;const family=new Set([root.id]);let changed=true;while(changed){changed=false;for(const h of all)if(h.parentJobId&&family.has(h.parentJobId)&&!family.has(h.id)){family.add(h.id);changed=true;}}
      const revisions=await Promise.all(all.filter(h=>h.id!==root.id&&family.has(h.id)).map(async h=>{const old=cache.get(h.id);if(old?.updatedAt===h.updatedAt)return old;const j=await read(h.id);cache.set(h.id,j);return j;}));
      if(alive){setJob(root);setVersions(revisions);if(first)setChosen({...root.chosenVersions,...(requested.parentJobId?{[requested.parentCandidateId]:requested.id}:{})});first=false;setError('');}
    }catch(e){if(alive)setError(e.message);}finally{loading=false;}};
    setJob(null);setVersions([]);setChosen({});positioned.current=false;load();const t=setInterval(load,1600);return()=>{alive=false;clearInterval(t);};
  },[jobId]);
  useEffect(()=>{if(!job||positioned.current)return;positioned.current=true;const body=bodyRef.current;const result=body?.querySelector('.generation-candidate.completed')?.closest('.generation-group');if(result)body.scrollTop+=result.getBoundingClientRect().top-body.getBoundingClientRect().top;},[job,jobId]);
  useEffect(()=>{const esc=e=>{if(e.key==='Escape'){if(document.querySelector('.prompt-overlay'))return;e.stopImmediatePropagation();zoom?setZoom(null):onClose();}};window.addEventListener('keydown',esc,true);return()=>window.removeEventListener('keydown',esc,true);},[zoom,onClose]);
  async function command(operation){setBusy(true);try{const r=await fetch(`/api/generation-jobs/${job.id}/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await r.json();if(!r.ok)throw new Error(data.error);setJob(data);onRefresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function options(autoRepair){try{const r=await fetch(`/api/generation-jobs/${job.id}/options`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoRepair})});const j=await r.json();if(!r.ok)throw new Error(j.error);setJob(j);}catch(e){setError(e.message);}}
  async function again(){setBusy(true);try{const r=await fetch(`/api/products/${job.productId}/variants/${job.skuId}/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await r.json();if(!r.ok)throw new Error(data.error);onCreated(data.id);onRefresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function download(){setBusy(true);try{const r=await fetch(`/api/generation-jobs/${job.id}/download`);if(!r.ok)throw new Error((await r.json()).error);const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=`Etsy-${job.productId}-${job.skuId}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function downloadSingle(c){setBusy(true);try{const r=await fetch(imageUrl(job.id,c)+'&download=1');if(!r.ok)throw new Error((await r.json()).error);const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;const draft=c.status!=='completed';a.download=(draft?'草稿-':'')+((draft?c.preview?.file:c.file)?.split('/').pop()||c.filename+'.png');a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){setError(e.message);}finally{setBusy(false);}}
  const queue=queueInfo(job,history);
  const cards=(job?.candidates||[]).map(original=>{const candidates=versions.filter(v=>v.candidates.some(c=>c.id===original.id)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const selected=chosen[original.id];const revision=selected===job.id?null:candidates.find(v=>v.id===selected)||(selected?null:candidates.find(v=>v.candidates.some(c=>c.id===original.id&&(c.status==='completed'||c.preview))));const c=revision?.candidates.find(c=>c.id===original.id)||original;return {...c,assetJobId:revision?.id||job.id,versionOptions:candidates};});
  const completed=cards.filter(c=>c.status==='completed').length;
  const related=job?history.filter(j=>j.productId===job.productId&&j.skuId===job.skuId):[];
  return <div className="overlay gallery-overlay generation-overlay" onClick={onClose}><section className="generation-modal" role="dialog" aria-modal="true" aria-label="Etsy 图片生成" onClick={e=>e.stopPropagation()}>
    <div className="gallery-heading"><div><div className="eyebrow">ETSY PHOTO STUDIO</div><h2><Sparkles size={21}/>Etsy 图片生成</h2><p>{job?`${job.snapshot.title} · ${job.snapshot.skuLabel}`:'正在读取任务…'}</p></div><button className="icon-button" aria-label="关闭 Etsy 图片生成" onClick={onClose}><X size={21}/></button></div>
    {error&&<div role="alert" className="alert red generation-error"><TriangleAlert size={17}/>{error}</div>}
    {job?<>
      <div className="generation-toolbar"><div className="generation-progress-copy"><strong>{LABELS[job.status]}<span>{completed} / {job.candidates.length} 张</span></strong><p>{queue?.message||job.message}</p><div className="progress"><span style={{width:`${completed/job.candidates.length*100}%`}}/></div></div><div className="generation-controls">
        {active(job)?<button className="button secondary" disabled={busy} onClick={()=>command('stop')}><Square size={13}/>停止</button>:<>
          {job.status!=='done'&&job.provider!=='chatgpt_web'&&<button className="button secondary" disabled={busy} onClick={()=>command(job.candidates.some(c=>c.status==='failed')?'retry':'resume')}><Play size={14}/>继续 / 重试</button>}
          <button className="button secondary" disabled={busy} onClick={again}><RefreshCw size={14}/>重新生成</button>
        </>}
        <button className="button secondary" onClick={()=>setShowPreferences(v=>!v)}>风格偏好库</button><button className="button dark" disabled={busy||!completed} onClick={download}><FolderDown size={14}/>下载原批次图片包</button>
      </div></div>
      <div className="generation-body" ref={bodyRef}><div className="version-workspace-note">新批次最多6张：使用主图1、完整外观1、原素材视角最多3、手持1。从原图选择轻斜拍、俯拍等实际非正视角，抠出商品并沿用 Etsy 风格，不推造新角度；不足3个则注明缺口。历史批次保留原图与位置，单张修改只新增对应版本；图片包下载原批次，单张下载当前版本。</div>{job.provider==='chatgpt_web'?<p className="auto-repair-option">历史网页批次（已停用） · {webModelLabel(job.requestedModel)} · 请点重新生成，创建Codex GPT-6.1 Sol新批次。</p>:<label className="auto-repair-option"><input type="checkbox" checked={job.options?.autoRepair===true} onChange={e=>options(e.target.checked)}/>自动修正明显错误（额外消耗额度，最多重画2次；默认关闭，对下一张生效）</label>}{job.provider!=='chatgpt_web'&&<p className="auto-repair-option">Codex内置生图 · {webModelLabel(job.requestedModel||job.model)} · 低推理 · 每张独立短会话，默认一稿</p>}<UsageDetails job={job}/>{showPreferences&&<StylePreferences/>}{job.parentJobId&&<div className="adjustment-context"><button className="text-button" onClick={()=>onCreated(job.parentJobId)}>返回原批次与旧版本</button><p>本次风格调整：{job.adjustment?.instruction}</p></div>}
        {job.angleMode==='source_photos'&&<p className="auto-repair-option">角度位采用原素材实际视角：一次选角后复用裁切结果，只调整摄影风格。{job.anglePlan?`已检查 ${job.anglePlan.scanned} 张原素材，找到 ${job.anglePlan.slots.filter(s=>s.status==='ready').length} 个可用视角。`:'选角会在处理角度场景时进行。'}共用详情图须先匹配当前规格。</p>}
        {job.planVersion===2&&!active(job)&&job.provider!=='chatgpt_web'&&job.candidates.some(c=>c.scene==='angle'&&c.status!=='completed')&&<button className="button secondary compact" disabled={busy} onClick={()=>command('source-angles')}>未完成角度位改用原素材视角</button>}
        <div className="generation-batch"><span>{new Date(job.createdAt).toLocaleString('zh-CN',{hour12:false})} · 独立批次</span>{related.length>1&&<label>历史批次<select aria-label="生图历史批次" value={job.id} onChange={e=>onCreated(e.target.value)}>{related.filter(j=>j.kind!=='adjustment').map(j=><option value={j.id} key={j.id}>{new Date(j.createdAt).toLocaleString('zh-CN')} · {j.completed}/{j.total}</option>)}</select></label>}</div>
        <details className="generation-inputs"><summary>本次使用的原图与参数 · 已冻结保存</summary><div className="generation-reference-grid">{job.snapshot.refs.map(ref=><img key={ref.imageId} src={`/api/generation-jobs/${job.id}/inputs/${ref.imageId}`} alt={`本次${job.snapshot.skuLabel}原图`}/>)}</div><p>只使用此规格关联的商品原图；风格参考仅指导摄影。</p><div className="generation-facts">{[['length','长','cm'],['width','宽','cm'],['height','高','cm'],['weight','重量','g'],['material','材质','']].map(([key,label,unit])=>{const f=job.confirmedUpdates?.[key]||job.snapshot.fields[key];return <span key={key}>{label}：{f?.value??'未找到'} {f?.value!=null?unit:''}{!['manual','found'].includes(f?.status)&&f?.value!=null?'（待确认）':''}</span>;})}</div>{job.planVersion===2&&<ViewEvidence job={job} onSaved={j=>{setJob(j);onRefresh();}} onError={setError}/>}</details>
        {groups.filter(([scene])=>job.candidates.some(c=>c.scene===scene)).map(([scene,label])=><section className="generation-group" key={scene}><h3>{label}<small>{job.candidates.filter(c=>c.scene===scene).length} {scene==='angle'&&job.planVersion>=2?'个独立视角':'张图片'}</small></h3><div className="generation-candidates">{cards.filter(c=>c.scene===scene).map(c=><article className={`generation-candidate ${c.status}`} key={c.id}>
          {c.status==='completed'||c.preview?<button className="generation-preview" onClick={()=>setZoom(c)} aria-label={`放大${label} ${c.letter}`}><img src={imageUrl(job.id,c)} alt={`${job.snapshot.skuLabel} ${label} ${c.letter}`}/></button>:<div className="generation-placeholder">{c.status==='running'?<LoaderCircle className="spin" size={26}/>:c.status==='blocked'||c.status==='failed'?<TriangleAlert size={24}/>:<ImageIcon size={25}/>}<strong>{LABELS[c.status]}</strong></div>}
          <div className="generation-caption">{c.preview&&c.status!=='completed'&&<span className="preview-label">{c.status==='running'?'草稿 · 正在核验':'草稿 · 尚未通过核验'}</span>}<strong>{label} · {c.viewLabel||c.letter}{c.status==='completed'&&<CheckCircle2 size={13}/>}</strong><p>{candidateMessage(c)}</p>{(c.status==='completed'||c.preview)&&<div><small>{c.status==='completed'?`${c.width} × ${c.height} · ${c.reviewState==='pending_user'?'待核对商品细节':'已查看核对'}`:`${c.preview.width} × ${c.preview.height} · 草稿未经核验，请确认后使用`}</small><button className="text-button" disabled={busy} onClick={()=>downloadSingle(c)}><ArrowDownToLine size={12}/>{c.status==='completed'?'下载':'下载草稿'}</button></div>}{c.angleSource?.status==='ready'&&<details className="angle-source"><summary>查看实际视角来源</summary><p>{c.angleSource.viewDescription}</p><a href={`/api/generation-jobs/${c.assetJobId}/inputs/${c.angleSource.imageId}`} target="_blank" rel="noreferrer">打开来源原图</a><img src={`/api/generation-jobs/${c.assetJobId}/angle-sources/${c.id}`} alt={c.viewLabel+' 原图裁切'}/><small>原图裁切，保留实际拍摄视角。{c.angleSource.requiresSkuMatch?'共用图经选角分析匹配当前规格。':'来源已关联当前规格。'}</small></details>}<div className="image-version-switch"><label>图片版本<select aria-label={label+' '+c.letter+' 图片版本'} value={c.assetJobId} onChange={async e=>{const assetJobId=e.target.value;try{const r=await fetch('/api/generation-jobs/'+job.id+'/selection',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({candidateId:c.id,assetJobId})});const j=await r.json();if(!r.ok)throw new Error(j.error);setChosen(prev=>({...prev,[c.id]:assetJobId}));onRefresh();}catch(error){setError(error.message);}}}><option value={job.id}>原始版本</option>{c.versionOptions.map((v,index)=><option key={v.id} value={v.id}>调整版本 {c.versionOptions.length-index} · {LABELS[v.status]}</option>)}</select></label>{c.assetJobId!==job.id&&<small>当前显示调整版本，其他图片保持原位置。</small>}</div><StyleAdjustment job={c.assetJobId===job.id?job:versions.find(v=>v.id===c.assetJobId)} candidate={c} history={history} busy={busy} onCreated={onCreated} onRefresh={onRefresh} onError={setError}/></div>
        </article>)}</div></section>)}
      </div><div className="gallery-note">沿用你的 Etsy 生图 Skill · 新批次通过你自己的Codex账号，使用GPT-6.1 Sol调度内置生图，旧批次保留原生成记录。缺少依据的场景会明确标注，下载自动清理文件来源元数据，不改变画面内容；不自动发布商品。</div>
    </>:!error&&<div className="empty-state"><LoaderCircle className="spin" size={25}/><p>正在读取生图任务</p></div>}
  </section>{zoom&&<div className="lightbox" onClick={e=>{e.stopPropagation();setZoom(null);}}><button className="lightbox-close" aria-label="关闭成品大图"><X size={24}/></button><img src={imageUrl(job.id,zoom)} alt={`${zoom.label} ${zoom.letter}`} onClick={e=>e.stopPropagation()}/></div>}</div>;
}

function UsageDetails({job}){
  if(job.provider==='chatgpt_web')return <details className="generation-inputs generation-usage"><summary>本批调用与用量</summary><p>渠道：ChatGPT会员网页；请求模型：{webModelLabel(job.requestedModel)}。图片流程不启动Codex任务。网页不提供官方单图token账单，不能按零消耗计算；上架文案仍可能消耗Codex用量。</p><p>已提交 {job.candidates.filter(c=>c.web?.submittedAt).length} 张，已下载 {job.candidates.filter(c=>c.web?.phase==='downloaded').length} 张。遇到登录、验证或模型不可用会暂停。</p></details>;
  const u=job.usage;const number=n=>Number(n||0).toLocaleString('zh-CN');
  return <details className="generation-inputs generation-usage"><summary>本批调用与用量</summary>{u?<><p>已记录 {u.recordedTurns} 次任务 · 实际调用生图 {u.imageCalls} 次 · 额外查看图片 {u.imageViews} 次</p>{job.anglePlan?.usage&&job.anglePlan.jobId===job.id&&<p>包含一次原素材选角分析（不生图），选角结果在本批次复用。</p>}<p>{u.tokenRecordedTurns?`输入 ${number(u.inputTokens)} token（其中缓存 ${number(u.cachedInputTokens)}） · 输出 ${number(u.outputTokens)} token`:'服务未返回 token 明细，不能按零消耗计算。'}</p>{u.tokenRecordedTurns<u.recordedTurns&&<p>部分任务未返回 token 统计，以上仅为已记录部分。</p>}<p>这些是调用记录，不是收费账单；账户额度还受其他聊天及重置窗口影响，不能将 token 直接换算为额度百分比。</p></>:<p>此批尚无用量记录。历史任务不会被当作零消耗；新增调用会自动记录。</p>}</details>;
}

function StyleAdjustment({job,candidate:c,history,busy,onCreated,onRefresh,onError}){
  const [open,setOpen]=useState(false);
  const revisions=history.filter(j=>j.parentJobId===job.id&&j.parentCandidateId===c.id);
  return <div className="style-adjustment"><button className="button secondary compact" aria-label={'修改'+c.label+' '+c.letter+' 图片'} disabled={busy||!(c.status==='completed'||c.preview)} onClick={()=>setOpen(true)}><Sparkles size={13}/>修改</button>{!(c.status==='completed'||c.preview)&&<small>图片返回后可修改。</small>}{revisions.map(j=><button className="text-button" key={j.id} onClick={()=>onCreated(j.id)}>查看调整版本 · {LABELS[j.status]} {j.completed}/{j.total}</button>)}{open&&<PromptDialog title={'修改'+c.label+' '+c.letter+' 图片'} currentValue={{image:imageUrl(job.id,c)}} onClose={()=>setOpen(false)} onSubmit={async instruction=>{const r=await fetch('/api/generation-jobs/'+job.id+'/candidates/'+c.id+'/adjust',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instruction})});const j=await r.json();if(!r.ok)throw new Error(j.error);onRefresh();onCreated(j.id);}}/>}</div>;
}
function StylePreferences(){
  const [prefs,setPrefs]=useState([]);const [error,setError]=useState('');
  const load=async()=>{try{const r=await fetch('/api/style-preferences');const j=await r.json();if(!r.ok)throw new Error(j.error);setPrefs(j.preferences);}catch(e){setError(e.message);}};
  useEffect(()=>{load();},[]);
  async function toggle(p){try{const r=await fetch('/api/style-preferences/'+p.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!p.enabled})});if(!r.ok)throw new Error((await r.json()).error);await load();}catch(e){setError(e.message);}}
  const categories={'brooch':'胸针','ear-clip':'耳饰','bag-charm':'包挂',other:'其他饰品'};
  return <section className="style-library"><h3>风格偏好库</h3><p>这里保留历史已启用偏好。新的调整进入左侧「修改审阅中心」，经你确认后供下次生成使用；不改变商品事实。</p>{error&&<p role="alert">{error}</p>}{!prefs.length&&<p>暂无历史偏好；新修改与已批准规则可在「修改审阅中心」查看。</p>}{prefs.map(p=><article key={p.id} className={p.enabled?'':'disabled'}><div><strong>{categories[p.category]} · {groups.find(g=>g[0]===p.scene)?.[1]||'全部场景'}</strong><small>{new Date(p.createdAt).toLocaleString('zh-CN')} · {p.productId}</small><p>{p.instruction}</p></div><button className="button secondary" onClick={()=>toggle(p)}>{p.enabled?'停用':'启用'}</button></article>)}</section>;
}

function ViewEvidence({job,onSaved,onError}){
 return <div className="weight-edit-note"><p>侧面／背面须有当前规格原图依据。确认对应图片后勾选，停止或暂停状态可修改，再点击继续。</p>{job.snapshot.refs.map(ref=><div key={ref.imageId}>{[['side','侧面'],['back','背面']].map(([view,label])=><label key={view}><input type="checkbox" disabled={active(job)} checked={Boolean(job.viewEvidence?.[view]?.includes(ref.imageId))} onChange={async e=>{const ids=new Set(job.viewEvidence?.[view]||[]);e.target.checked?ids.add(ref.imageId):ids.delete(ref.imageId);try{const r=await fetch('/api/generation-jobs/'+job.id+'/evidence',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({view,imageIds:[...ids]})});const j=await r.json();if(!r.ok)throw new Error(j.error);onSaved(j);}catch(err){onError(err.message);}}}/> 原图{job.snapshot.refs.indexOf(ref)+1}明确展示{label}</label>)}</div>)}</div>;
}
