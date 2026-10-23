import { expect, it } from 'vitest';
import { validatePrefixComparison } from '../scripts/prefix-comparison-contract.mjs';
import { nativeUiPlan } from '../scripts/native-ui-contract.mjs';
const SHA='059c8416a6df00a6b4bc391b82a8f2962888e083fb4ab4fec261a96954a06b90';
function record(commit) {
  const plan=nativeUiPlan('5120'),memory=['sender','receiver'].map(role=>({role,before:[{id:123}],native:{missingIds:[],missingReasons:[],processes:[{id:123,privateBytes:1,workingSetBytes:1}]}}));
  return { context:{sourceCommit:commit,node:'v24.22.1',runtimeSha256:'a'.repeat(64),plan,cpuProfile:{enabled:true,intervalMicros:10000}},
    metadata:{valid:true},parent:{plan,exit:{code:0},resources:[{free:30*1024**3,systemFree:10*1024**3}]},
    raw:{sourceCommit:commit,plan,smokeOnly:false,functionalPassed:true,nativeComplete:true,sampledReserveMet:true,memory,
      fixture:{sha256:SHA,fileBytes:plan.fileBytes,writtenBytes:plan.fileBytes},independent:{passed:true,everyByteCompared:plan.fileBytes,sourceSha256:SHA},
      browserVersions:['sender','receiver'].map(role=>({role,version:'156.0.8078.4',channel:'bundled'})),
      cpuProfile:{enabled:true,intervalMicros:10000,captures:['sender','receiver'].map(role=>({role,valid:true,summary:{sampleCount:10}}))},cpuProfileComplete:true} };
}
const pair=()=>[record('1'.repeat(40)),record('2'.repeat(40))];
it('accepts two complete5GiB cases with matching runtime, browser and source bytes without claiming a speedup',()=>{
  expect(validatePrefixComparison(...pair())).toMatchObject({comparable:true,fileBytes:5368709120,performanceAccepted:false,releaseReady:false});
});
it.each(['runtime','browser','role','smoke','fixture','native-row','profile','reserve','deadline','source-binding','partial','same-source'])('rejects incomparable pair evidence: %s',kind=>{
  const [a,b]=pair();
  if(kind==='runtime')b.context.runtimeSha256='b'.repeat(64);
  if(kind==='browser')b.raw.browserVersions[0].version='different';
  if(kind==='role')b.raw.browserVersions[0].role='receiver';
  if(kind==='smoke'){b.raw.plan={...b.raw.plan,mib:16};b.raw.smokeOnly=true;}
  if(kind==='fixture')b.raw.fixture.sha256='0'.repeat(64);
  if(kind==='native-row')b.raw.memory[0].native.missingIds=[123];
  if(kind==='profile')b.raw.cpuProfile.captures.pop();
  if(kind==='reserve')b.parent.resources[0].free=2147483647;
  if(kind==='deadline')b.parent.plan={...b.parent.plan,deadlineMs:1800001};
  if(kind==='source-binding')b.raw.sourceCommit='3'.repeat(40);
  if(kind==='partial')b.metadata.valid=false;
  if(kind==='same-source'){b.context.sourceCommit=a.context.sourceCommit;b.raw.sourceCommit=a.context.sourceCommit;}
  expect(()=>validatePrefixComparison(a,b)).toThrow(/comparison/i);
});
