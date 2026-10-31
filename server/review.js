import {randomUUID} from 'node:crypto';
import {REFERENCES} from './listing-reference-data.js';
const now=()=>new Date().toISOString();
const fields=['title','description','tags','image'];
const categories=['*','brooch','ear-clip','bag-charm','other'];
const scenes=['*','use','overview','angle','scale'];
export function reusableInstruction(text){return typeof text==='string'&&text.trim().length>0&&text.length<=1000&&!/\d+(?:\.\d+)?\s*(?:cm|mm|kg|grams?|g|inches?|毫米|厘米|英寸|千克|克)\b|(?:尺寸|重量|长宽高).{0,8}\d|材质.{0,5}(改为|改成|换成)|尺寸.{0,5}(改为|改成)|重量.{0,5}(改为|改成)|改成纯银|变成纯银/i.test(text);}
export class ReviewService{
  constructor({store}){this.store=store;for(const r of REFERENCES)if(!store.entry('listing_references',r.id))store.saveEntry('listing_references',{...r,createdAt:now()});}
  record(input){const event={id:randomUUID(),createdAt:now(),reviewStatus:'pending',resultStatus:'queued',adopted:false,...input};return this.store.saveEntry('feedback_events',event);}
  update(id,changes){const event=this.store.entry('feedback_events',id);if(event)this.store.saveEntry('feedback_events',{...event,...changes});}
  imageCreated(job,parent,candidate){return this.record({productId:job.productId,skuId:job.skuId,field:'image',scene:candidate.scene,category:job.snapshot.category,instruction:job.adjustment.instruction,
    before:{jobId:parent.id,candidateId:candidate.id,preview:candidate.status!=='completed'},after:{jobId:job.id,candidateId:candidate.id,available:false},resultJobId:job.id,
    proposal:reusableInstruction(job.adjustment.instruction)?{instruction:job.adjustment.instruction,field:'image',category:job.snapshot.category,scene:candidate.scene}:null,
    proposalReason:reusableInstruction(job.adjustment.instruction)?'摄影偏好建议，确认后才会影响下次生成。':'包含商品专属事实或数字，请编辑为通用风格规则后再批准。'});}
  syncImage(job){if(!job.feedbackId)return;const c=job.candidates[0];this.update(job.feedbackId,{resultStatus:job.status,resultMessage:job.message,after:{jobId:job.id,candidateId:c.id,preview:c.status!=='completed',available:c.status==='completed'||Boolean(c.preview)}});this.refreshImageAdoption();}
  refreshImageAdoption(){
    const jobs=this.store.imageJobs(),events=this.store.entries('feedback_events').filter(e=>e.field==='image');
    const rootOf=job=>{const seen=new Set();while(job?.parentJobId&&!seen.has(job.id)){seen.add(job.id);job=jobs.find(j=>j.id===job.parentJobId);}return job;};
    for(const event of events){const job=jobs.find(j=>j.id===event.after?.jobId),root=rootOf(job);if(!root)continue;const candidates=jobs.filter(j=>rootOf(j)?.id===root.id&&j.candidates.some(c=>c.id===event.after.candidateId&&(c.status==='completed'||c.preview))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const selected=root.chosenVersions?.[event.after.candidateId]||candidates[0]?.id;const adopted=selected===job.id&&job.candidates.some(c=>c.id===event.after.candidateId&&c.status==='completed');if(event.adopted!==adopted)this.update(event.id,{adopted});}
  }
  data(){return {events:this.store.entries('feedback_events'),current:this.store.ruleVersion(),versions:this.store.entries('rule_versions').sort((a,b)=>b.version-a.version),references:this.store.entries('listing_references'),legacy:this.store.stylePreferences().map(p=>({...p,origin:'历史已启用偏好'}))};}
  publish(rules,reason,extra={}){const old=this.store.ruleVersion();return this.store.saveEntry('rule_versions',{id:randomUUID(),version:old.version+1,createdAt:now(),rules:structuredClone(rules),reason,...extra});}
  approve({eventIds,instruction,field,category,scene='*',replaceIds=[],baseVersion}){
    if(!Array.isArray(eventIds)||!eventIds.length||eventIds.length>100)throw new Error('请选择要审阅或合并的修改记录。');
    const text=typeof instruction==='string'?instruction.trim():'';
    if(!reusableInstruction(text))throw new Error('长期规则需为不含具体尺寸、重量等商品事实的通用偏好（最多1000字）。');
    if(!fields.includes(field)||!categories.includes(category)||!scenes.includes(scene)||(field!=='image'&&scene!=='*'))throw new Error('请选择有效的规则适用范围。');
    return this.store.transaction(()=>{
      const current=this.store.ruleVersion();if(baseVersion!==current.version)throw new Error('规则已变化，请刷新后重新核对差异。');
      const events=[...new Set(eventIds)].map(id=>this.store.entry('feedback_events',id));
      if(events.some(e=>!e||e.reviewStatus!=='pending'||e.field!==field||!['done','manual'].includes(e.resultStatus)))throw new Error('请选择同类型、已有成功结果且待审阅的记录。');
      if(!Array.isArray(replaceIds)||replaceIds.some(id=>!current.rules.some(r=>r.id===id)))throw new Error('要替换的规则不存在。');
      const rule={id:randomUUID(),instruction:text,field,category,scene,enabled:true,eventIds:events.map(e=>e.id),createdAt:now()};
      const rules=current.rules.map(r=>replaceIds.includes(r.id)?{...r,enabled:false,replacedBy:rule.id}:r);rules.push(rule);
      const version=this.publish(rules,'用户批准修改规则');for(const e of events)this.update(e.id,{reviewStatus:'approved',ruleId:rule.id,approvedVersion:version.version,reviewedAt:now()});return version;
    });
  }
  reject(ids){if(!Array.isArray(ids)||!ids.length)throw new Error('请选择记录。');for(const id of ids){const e=this.store.entry('feedback_events',id);if(e?.reviewStatus==='pending')this.update(id,{reviewStatus:'rejected',reviewedAt:now()});}return this.data();}
  toggle(id,enabled,baseVersion){if(typeof enabled!=='boolean')throw new Error('请选择规则状态。');return this.store.transaction(()=>{const current=this.store.ruleVersion();if(baseVersion!==current.version)throw new Error('规则已变化，请刷新。');if(!current.rules.some(r=>r.id===id))throw new Error('规则不存在。');return this.publish(current.rules.map(r=>r.id===id?{...r,enabled}:r),enabled?'用户重新启用规则':'用户停用规则');});}
  rollback(id,baseVersion){return this.store.transaction(()=>{const current=this.store.ruleVersion();if(current.version!==baseVersion)throw new Error('规则已变化，请刷新。');const old=this.store.entry('rule_versions',id);if(!old)throw new Error('历史规则版本不存在。');return this.publish(old.rules,'用户回退规则',{restoredFrom:old.version});});}
}
