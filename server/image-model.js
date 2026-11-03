// Shared by the browser runner and UI; no account or runtime dependencies.
export const WEB_IMAGE_MODEL='gpt-5.6-sol';
export const CODEX_IMAGE_MODEL='gpt-6.1-sol';
export const IMAGE_REASONING_EFFORT='medium';
export const IMAGE_EXECUTION_POLICY=Object.freeze({version:4,initialWaitMs:120000,additionalWaitMs:120000,maxAdditionalWaits:1,maxModelSteps:8,maxImageCalls:1});
const models={
  'gpt-5.6-sol':{label:'GPT-5.6 Sol',pattern:/\bGPT[\s\-‐‑–]*5\.6\s+Sol\b/i},
  'gpt-6.1-sol':{label:'GPT-6.1 Sol',pattern:/\bGPT[\s\-‐‑–]*6\.1\s+Sol\b/i},
  'gpt-6-luna':{label:'GPT-6 Luna',pattern:/\bGPT[\s\-‐‑–]*6(?:\.0)?\s+Luna\b/i}
};
export function webModel(id=WEB_IMAGE_MODEL){const model=models[id];if(!model)throw new Error('未支持的网页模型：'+id);return {id,...model};}
export function webModelLabel(id){return models[id]?.label||id||'未记录';}
