import path from 'node:path';
import os from 'node:os';
import {open,realpath} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import {IMAGE_EXECUTION_POLICY} from './image-model.js';

export function imageFailure(code,message){const e=new Error(message);e.failureCode=code;e.waitReason=code;return e;}
function args(value){if(typeof value==='string'){try{return JSON.parse(value);}catch{return {code:value};}}return value||{};}
function outputText(value){
  if(typeof value==='string'){if(value.startsWith('[')){try{return outputText(JSON.parse(value));}catch{}}return value;}
  if(Array.isArray(value))return value.filter(v=>['text','input_text'].includes(v?.type)).map(v=>v.text||'').join('\n');return '';
}

// Count real tool requests, not UI refreshes, repeated notifications, or elapsed
// intervals. The same state machine is used by live monitoring and replay tests.
export class ImageTracePolicy{
  constructor({policy=IMAGE_EXECUTION_POLICY,now=()=>Date.now(),onChange=()=>{},onViolation=()=>{}}={}){
    Object.assign(this,{policy,now,onChange,onViolation});this.seen=new Set();this.imageIds=new Set();this.state={phase:'preparing',additionalWaits:0,imageCalls:0,elapsedMs:0};this.began=now();
  }
  fail(code,message){if(this.error)return;this.error=imageFailure(code,message);this.state.failureCode=code;this.publish();this.onViolation(this.error);}
  publish(){this.state.elapsedMs=this.now()-this.began;this.onChange({...this.state});}
  tick(){if(this.error)return;const elapsed=this.now()-(this.imageStarted??this.began);
    if(this.imageStarted!=null&&!this.returned&&elapsed>=this.policy.initialWaitMs+this.policy.additionalWaitMs)this.fail('image_timeout','首次等待及唯一一次补查已结束，4分钟内未返回图片；已停止，不自动重发。');
    else if(this.imageStarted==null&&elapsed>=60000)this.fail('preparation_timeout','生图准备超过1分钟，已停止以避免继续消耗。');
  }
  returnedImage(){this.returned=true;this.state.phase='saving';this.publish();}
  feed(record){
    if(this.error||record.type!=='response_item')return;
    const p=record.payload||{};
    if(['function_call','custom_tool_call'].includes(p.type)){
      const id=p.call_id||p.id;if(!id){this.fail('trace_unavailable','工具调用记录缺少编号，无法保证只补查一次；已停止。');return;}
      if(this.seen.has(id))return;this.seen.add(id);
      const name=(p.name||'').split('.').at(-1),a=args(p.arguments??p.input);
      const code=a.code||a.input||a.source||(typeof(p.arguments??p.input)==='string'?(p.arguments??p.input):'');
      const matches=typeof code==='string'?[...code.matchAll(/\btools\.image_gen__imagegen\s*\(/g)]:[];
      if(name==='view_image'||/\btools\.view_image\s*\(/.test(code)){this.fail('review_limit','原图和结果已由工具展示，不再追加打开图片核验；已停止重复查看。');return;}
      if(matches.length&&/\btext\s*\(\s*(?:r|result)\s*\)/.test(code)){this.fail('output_protocol','执行代码尝试输出完整生图返回对象，已停止以避免图片编码进入上下文。');return;}
      if(matches.length||/imagegen|image_gen/.test(name)){
        this.state.imageCalls+=matches.length||1;
        if(this.state.imageCalls>1){this.fail('image_call_limit','本张只允许生成一次，已拦截额外生图，不自动重画。');return;}
        this.imageIds.add(id);this.imageStarted=this.now();this.state.phase='initial_wait';
        if(name==='exec'){
          const pragma=code.match(/^\s*\/\/\s*@exec:\s*(\{[^\n]+\})/);let delay;try{delay=JSON.parse(pragma?.[1]||'{}').yield_time_ms;}catch{}
          if(delay!==this.policy.initialWaitMs){this.fail('poll_protocol','生图执行没有采用120秒首次等待，已停止，避免退回短轮询。');return;}
        }
        this.publish();
      }
      if(name==='wait'){
        if(a.terminate===true){this.fail('image_cancelled','生图尚未返回，执行端已取消等待；没有自动重发。');return;}
        if(this.imageStarted==null||!this.cell||a.cell_id!==this.cell){this.fail('poll_protocol','补查对象不是当前生图任务，已停止。');return;}
        this.state.additionalWaitAttempts=(this.state.additionalWaitAttempts||0)+1;
        if(this.state.additionalWaitAttempts>this.policy.maxAdditionalWaits){this.fail('poll_limit','本张只允许追加一次等待，已拦截第二次补查。');return;}
        if(a.yield_time_ms!==this.policy.additionalWaitMs){this.fail('poll_protocol','补查没有采用120秒长等待，已停止，避免短轮询重复输入。');return;}
        this.state.additionalWaits++;this.state.phase='additional_wait';this.publish();
      }
    }else if(['function_call_output','custom_tool_call_output'].includes(p.type)){
      const text=outputText(p.output);
      if(this.imageIds.has(p.call_id)){
        const m=text.match(/Script running with cell ID\s+([^\s]+)/);if(m)this.cell=m[1];
      }
      if(this.imageStarted!=null&&/image generation failed|connection failed|error sending request/i.test(text))this.fail('image_connection','生图工具连接失败：'+(text.match(/image generation failed:[^\n"}]+/i)?.[0]||'请求发送失败').slice(0,240));
    }
  }
}

export class ImageTraceMonitor{
  constructor(options={}){this.guard=new ImageTracePolicy(options);this.allowedRoot=options.allowedRoot||path.join(process.env.CODEX_HOME||os.homedir()+'/.codex','sessions');this.intervalMs=options.intervalMs||100;}
  get error(){return this.guard.error;}get state(){return {...this.guard.state};}
  returnedImage(){this.guard.returnedImage();}
  async start(file,threadId){
    try{
      const base=await realpath(this.allowedRoot),target=await realpath(file||'');
      if(!target.startsWith(base+path.sep)||!path.basename(target).includes(threadId))throw new Error('invalid trace path');
      this.handle=await open(target,'r');const stat=await this.handle.stat();if(!stat.isFile())throw new Error('not a file');
      this.position=stat.size;this.decoder=new StringDecoder('utf8');this.pending='';
      this.timer=setInterval(()=>this.flush().catch(()=>{}),this.intervalMs);return this;
    }catch{await this.handle?.close().catch(()=>{});throw imageFailure('trace_unavailable','当前Codex没有提供可读取的本任务工具记录，无法保证一次补查；未启动生图，请更新Codex后重试。');}
  }
  async flush(){
    if(this.reading)return this.reading;if(!this.handle)return;
    this.reading=(async()=>{
      try{
        const size=(await this.handle.stat()).size;if(size<this.position)throw new Error('trace truncated');
        while(this.position<size){
          const buffer=Buffer.alloc(Math.min(262144,size-this.position));const {bytesRead}=await this.handle.read(buffer,0,buffer.length,this.position);if(!bytesRead)break;this.position+=bytesRead;
          this.pending+=this.decoder.write(buffer.subarray(0,bytesRead));
          let newline;while((newline=this.pending.indexOf('\n'))>=0){const line=this.pending.slice(0,newline);this.pending=this.pending.slice(newline+1);if(line.trim())this.guard.feed(JSON.parse(line));}
          if(this.pending.length>64*1024*1024)throw new Error('trace record too large');
        }
        this.guard.tick();
      }catch{this.guard.fail('trace_unavailable','当前任务的工具记录无法继续读取，已停止，未退回无限等待。');}
    })();try{await this.reading;}finally{this.reading=null;}
  }
  async stop(){clearInterval(this.timer);await this.reading;await this.handle?.close().catch(()=>{});this.handle=null;}
}
