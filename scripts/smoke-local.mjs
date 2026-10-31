import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp,ROOT} from '../server/index.js';
import {bundledSkillPath} from '../server/platform.js';
const temporary=await mkdtemp(path.join(os.tmpdir(),'shiw-clean-install-'));const {app,store,collector,generation,listing,ocr}=createApp({dataDir:path.join(temporary,'data'),outputRoot:path.join(temporary,'images'),listingOutputRoot:path.join(temporary,'listings')});
app.use(express.static(path.join(ROOT,'dist')));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
try{
 const health=await(await fetch(base+'/api/health')).json();assert.equal(health.app,'1688-workbench');const state=await(await fetch(base+'/api/state')).json();assert.equal(state.products.length,0);assert.equal(state.generationJobs.length,0);assert.equal(state.listingJobs.length,0);
 const review=await(await fetch(base+'/api/review')).json();assert.equal(review.references.length,5);assert.equal(review.legacy.length,0);assert.equal(review.events.length,0);assert.equal(review.current.version,0);
 const index=await fetch(base+'/');assert.equal(index.status,200);assert.match(await index.text(),/assets\/index/);
 await access(bundledSkillPath(ROOT));await access(path.join(ROOT,'skills/etsy-accessory-images/assets/style-references/brooch/01.png'));assert.ok(generation.skillPath.startsWith(ROOT+path.sep));
 const dimensions=await ocr.dimensions(path.join(ROOT,'test/fixtures/brooch-parameter-card.jpg'));assert.equal(dimensions.width,750);
 console.log('独立安装启动检查通过：页面与接口可用、Skill在工程内、图片组件可用、新用户资料库为空，没有借用原电脑数据。');
}finally{await Promise.all([generation.close(),listing.close(),collector.close()]);await ocr.close();await new Promise(resolve=>server.close(resolve));store.close();await rm(temporary,{recursive:true,force:true});}
