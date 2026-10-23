// Explicit hosted experiment: two serial, fully guarded5GiB cases; no retries.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hostname,cpus,totalmem} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {validatePrefixCase,validatePrefixComparison} from './prefix-comparison-contract.mjs';
assert.equal(process.platform,'win32');
assert(process.env.QRFT_PREFIX_OUTPUT&&process.env.GITHUB_SHA&&process.argv[2]&&process.argv[3],'Explicit hosted paths and candidate commit required.');
const root=resolve(process.env.QRFT_PREFIX_OUTPUT),stages={baseline:resolve(process.argv[2]),candidate:resolve(process.argv[3])};
const expected={baseline:'203c64d502478cb9267fb074485c0698a0bcc20b',candidate:process.env.GITHUB_SHA};
assert.notEqual(expected.baseline,expected.candidate);
const head=stage=>execFileSync('git',['rev-parse','HEAD'],{cwd:stage,encoding:'utf8',windowsHide:true}).trim();
for(const tag of Object.keys(stages))assert.equal(head(stages[tag]),expected[tag]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of ['package.json','package-lock.json'])assert.equal(hash(await readFile(join(stages.baseline,file))),hash(await readFile(join(stages.candidate,file))),file);
await mkdir(root); // Refuse to reuse any earlier trial/evidence root.
const pair={startedAt:new Date().toISOString(),host:{hostname:hostname(),cpuModels:[...new Set(cpus().map(c=>c.model))],logicalCpus:cpus().length,totalMemory:totalmem(),node:process.version},
  expected,order:['baseline','candidate'],cases:[],performanceAccepted:false,releaseReady:false};
const persist=()=>writeFile(join(root,'PAIR.json'),JSON.stringify(pair,null,2)+'\n');
const records={};
try {
  await persist();
  for(const tag of pair.order) {
    const output=join(root,tag),stage=stages[tag];
    console.log(JSON.stringify({event:'case-start',tag,sourceCommit:expected[tag],at:new Date().toISOString()}));
    const exit=await new Promise((done,reject)=>{
      const child=spawn(process.execPath,[join(stage,'scripts/run-native-ui-qualification.mjs')],{cwd:stage,windowsHide:true,stdio:'inherit',
        env:{...process.env,QRFT_NATIVE_UI_OUTPUT:output,QRFT_NATIVE_UI_MIB:'5120',QRFT_NATIVE_UI_CPU_PROFILE:'1'}});
      child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));
    });
    pair.cases.push({tag,sourceCommit:expected[tag],output,exit,finishedAt:new Date().toISOString()});await persist();
    assert.equal(exit.code,0,tag+' guarded case failed; do not run a replacement.');
    const json=async path=>JSON.parse(await readFile(join(output,path),'utf8'));
    const record={context:await json('CONTEXT.json'),raw:await json('evidence/RAW.json'),parent:await json('PARENT.json'),metadata:await json('METADATA-HASHES.json')};
    assert.equal(record.context.sourceCommit,expected[tag]);assert.equal(record.context.worktreeStatus,'');
    validatePrefixCase(record);records[tag]=record;
    console.log(JSON.stringify({event:'case-finished',tag,at:new Date().toISOString()}));
  }
  pair.comparison=validatePrefixComparison(records.baseline,records.candidate);
} catch(error) {pair.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally {pair.finishedAt=new Date().toISOString();await persist();}
console.log(JSON.stringify({root,comparable:pair.comparison?.comparable??false,error:pair.error?.message,releaseReady:false}));
