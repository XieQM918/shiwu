import {inspectEnvironment} from '../server/environment.js';
const report=await inspectEnvironment({checkLogin:!process.argv.includes('--ci')});
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else{console.log('\n拾物工作台 · 本机环境检查\n');for(const c of report.checks)console.log(`${({ok:'[正常]',warning:'[待设置]',error:'[缺少]'})[c.status]} ${c.label}：${c.message}`);console.log('\n'+report.accountIsolation+'\n'+report.generationNote);}
if(process.argv.includes('--strict')&&!report.ok)process.exitCode=1;
