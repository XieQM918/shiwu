import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'workbench.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS image_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS style_preferences(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS image_profiles(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    for(const name of ['listing_jobs','listing_versions','listing_selections','listing_references','feedback_events','rule_versions'])this.db.exec(`CREATE TABLE IF NOT EXISTS ${name}(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL)`);
  }
  products() { return this.db.prepare('SELECT payload FROM products ORDER BY updated_at DESC').all().map(r => JSON.parse(r.payload)); }
  product(id) { const r = this.db.prepare('SELECT payload FROM products WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveProduct(p) { p.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO products VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(p.id, JSON.stringify(p), p.updatedAt); return p; }
  jobs() { return this.db.prepare('SELECT payload FROM jobs ORDER BY created_at DESC').all().map(r => JSON.parse(r.payload)); }
  job(id) { const r = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id); return r ? JSON.parse(r.payload) : null; }
  saveJob(j) { this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(j.id, JSON.stringify(j), j.createdAt); return j; }
  imageJobs(){return this.db.prepare('SELECT payload FROM image_jobs ORDER BY created_at DESC').all().map(r=>JSON.parse(r.payload));}
  imageJob(id){const r=this.db.prepare('SELECT payload FROM image_jobs WHERE id=?').get(id);return r?JSON.parse(r.payload):null;}
  saveImageJob(job){job.updatedAt=new Date().toISOString();this.db.prepare('INSERT INTO image_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id,JSON.stringify(job),job.createdAt);return job;}
  stylePreferences(){return this.db.prepare('SELECT payload FROM style_preferences ORDER BY created_at DESC').all().map(r=>JSON.parse(r.payload));}
  saveStylePreference(p){this.db.prepare('INSERT INTO style_preferences VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(p.id,JSON.stringify(p),p.createdAt);return p;}
  applicableStyles(category,scene){return [...this.stylePreferences().filter(p=>p.enabled&&p.category===category&&(p.scene===scene||p.scene==='*')).slice(0,8).reverse().map(p=>({...p,origin:'legacy'})),...this.activeRules(category,'image',scene)];}
  entries(table){this.checkTable(table);return this.db.prepare(`SELECT payload FROM ${table} ORDER BY created_at DESC,id DESC`).all().map(r=>JSON.parse(r.payload));}
  entry(table,id){this.checkTable(table);const row=this.db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.payload):null;}
  saveEntry(table,value){this.checkTable(table);value.updatedAt=new Date().toISOString();this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(value.id,JSON.stringify(value),value.createdAt||value.updatedAt);return value;}
  checkTable(table){if(!['listing_jobs','listing_versions','listing_selections','listing_references','feedback_events','rule_versions'].includes(table))throw new Error('未知资料类型');}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  ruleVersion(){return this.entries('rule_versions').sort((a,b)=>b.version-a.version)[0]||{version:0,rules:[]};}
  activeRules(category,field,scene='*'){return this.ruleVersion().rules.filter(r=>r.enabled&&(r.category==='*'||r.category===category)&&r.field===field&&(r.scene==='*'||r.scene===scene));}
  imageProfile(id){const r=this.db.prepare('SELECT payload FROM image_profiles WHERE id=?').get(id);return r?JSON.parse(r.payload):null;}
  saveImageProfile(id,p){this.db.prepare('INSERT INTO image_profiles VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(p));}
  recover() {
    for(const job of this.entries('listing_jobs'))if(['running','queued'].includes(job.status)){job.status='paused';job.message='上次文案生成已中断，已保存版本保留，点击继续。';this.saveEntry('listing_jobs',job);}
    for(const job of this.imageJobs())if(['running','queued'].includes(job.status)){
      job.status='paused';job.message='上次生图已中断，已完成图片保留，点击继续。';
      for(const c of job.candidates)if(c.status==='running'){c.status='pending';c.reason='上次生成中断';}
      this.saveImageJob(job);
    }
    for (const job of this.jobs()) if (['running', 'waiting', 'queued'].includes(job.status)) {
      job.status = 'paused'; job.message = '上次运行已中断，点击继续恢复'; this.saveJob(job);
      for (const id of job.ids.slice(job.index)) { const p = this.product(id); if (p && ['running','waiting','queued'].includes(p.status)) { p.status = 'paused'; p.message = job.message; this.saveProduct(p); } }
    }
  }
  close() { this.db.close(); }
}
