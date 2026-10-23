import { expect, it } from 'vitest';
import { cpuProfilePlan, summarizeCpuProfile } from '../scripts/native-cpu-profile.mjs';

it('requires explicit profiling and records its interval and limited target scope', () => {
  expect(cpuProfilePlan()).toEqual({ enabled: false, intervalMicros: 10000, scope: 'Page main isolate only; not workers, native CPU, disk or network attribution.' });
  expect(cpuProfilePlan('0').enabled).toBe(false);
  expect(cpuProfilePlan('1').enabled).toBe(true);
});
it.each(['', 'true', '2', true])('rejects ambiguous CPU profiling configuration %s', value => {
  expect(() => cpuProfilePlan(value)).toThrow(/0 or 1/);
});
const fixture = () => ({startTime:1000,endTime:1700,nodes:[
  {id:1,callFrame:{functionName:'(root)',url:'',lineNumber:-1,columnNumber:-1},children:[2,3]},
  {id:2,callFrame:{functionName:'process',url:'http://127.0.0.1/assets/app.js',lineNumber:0,columnNumber:42}},
  {id:3,callFrame:{functionName:'(idle)',url:'',lineNumber:-1,columnNumber:-1}},
],samples:[2,3,2],timeDeltas:[100,200,300]});
it('retains idle and source locations while weighting self samples by their actual deltas', () => {
  expect(summarizeCpuProfile(fixture())).toMatchObject({sampleCount:3,profileDurationUs:700,sampledDurationUs:600,
    frames:[{id:2,sampledSelfUs:400,samples:2,functionName:'process',columnNumber:42},{id:3,sampledSelfUs:200,samples:1,functionName:'(idle)'}]});
});
it.each(['missing-node','duplicate-node','missing-delta','negative-delta','nan-delta','empty-samples','bad-clock','missing-location'])('rejects incomplete profiler evidence: %s', kind => {
  const p=fixture();
  if(kind==='missing-node')p.samples[0]=99;
  if(kind==='duplicate-node')p.nodes.push({...p.nodes[1]});
  if(kind==='missing-delta')p.timeDeltas.pop();
  if(kind==='negative-delta')p.timeDeltas[0]=-1;
  if(kind==='nan-delta')p.timeDeltas[0]=NaN;
  if(kind==='empty-samples') {p.samples=[];p.timeDeltas=[];}
  if(kind==='bad-clock')p.endTime=p.startTime-1;
  if(kind==='missing-location')delete p.nodes[1].callFrame;
  expect(()=>summarizeCpuProfile(p)).toThrow(/CPU profile/);
});
