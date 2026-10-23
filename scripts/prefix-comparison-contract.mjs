import { nativeUiPlan, nativeSampleComplete } from './native-ui-contract.mjs';
const PLAN=nativeUiPlan('5120');
function requireComparison(ok) { if(!ok) throw Error('Incomplete or incomparable prefix comparison evidence.'); }
function browserKey(raw) {
  const browsers=raw.browserVersions;
  requireComparison(Array.isArray(browsers)&&browsers.length===2&&['sender','receiver'].every(role=>browsers.filter(b=>b.role===role).length===1));
  requireComparison(browsers.every(b=>typeof b.version==='string'&&b.version&&b.channel==='bundled'));
  return JSON.stringify([...browsers].map(({role,version,channel})=>({role,version,channel})).sort((a,b)=>a.role.localeCompare(b.role)));
}
export function validatePrefixCase(record) {
  const { context:c,raw:r,parent:p,metadata:m }=record;
  requireComparison(c&&r&&p&&m?.valid===true&&p.exit?.code===0&&!p.guardError);
  requireComparison(/^[0-9a-f]{40}$/.test(c.sourceCommit)&&r.sourceCommit===c.sourceCommit&&/^[0-9a-f]{64}$/.test(c.runtimeSha256));
  for(const plan of [c.plan,r.plan,p.plan])requireComparison(plan&&Object.keys(PLAN).every(key=>plan[key]===PLAN[key]));
  requireComparison(r.smokeOnly===false&&r.functionalPassed===true&&r.nativeComplete===true&&r.sampledReserveMet===true);
  requireComparison(r.fixture?.sha256===PLAN.expectedSha256&&r.fixture.fileBytes===PLAN.fileBytes&&r.fixture.writtenBytes===PLAN.fileBytes);
  requireComparison(r.independent?.passed===true&&r.independent.everyByteCompared===PLAN.fileBytes&&r.independent.sourceSha256===PLAN.expectedSha256);
  requireComparison(Array.isArray(r.memory)&&r.memory.length>0&&r.memory.every(nativeSampleComplete)&&['sender','receiver'].every(role=>r.memory.some(row=>row.role===role)));
  requireComparison(Array.isArray(p.resources)&&p.resources.length>0&&p.resources.every(row=>row.free>=PLAN.reserveBytes&&row.systemFree>=PLAN.reserveBytes));
  for(const profile of [c.cpuProfile,r.cpuProfile])requireComparison(profile?.enabled===true&&profile.intervalMicros===10000);
  requireComparison(r.cpuProfileComplete===true&&r.cpuProfile.captures?.length===2&&['sender','receiver'].every(role=>r.cpuProfile.captures.filter(cap=>cap.role===role&&cap.valid&&Number.isSafeInteger(cap.summary?.sampleCount)&&cap.summary.sampleCount>0).length===1));
  return browserKey(r);
}
export function validatePrefixComparison(baseline,candidate) {
  const before=validatePrefixCase(baseline),after=validatePrefixCase(candidate);
  requireComparison(baseline.context.sourceCommit!==candidate.context.sourceCommit);
  requireComparison(before===after&&baseline.context.node===candidate.context.node&&baseline.context.runtimeSha256===candidate.context.runtimeSha256);
  return {comparable:true,fileBytes:PLAN.fileBytes,baselineCommit:baseline.context.sourceCommit,candidateCommit:candidate.context.sourceCommit,
    runtimeSha256:baseline.context.runtimeSha256,browserVersions:JSON.parse(before),
    scope:'One serial baseline-then-candidate pair on the orchestrator host, identical source bytes and runtime. Profiling perturbs timing; no broad throughput, statistical or physical Wi-Fi acceptance.',
    performanceAccepted:false,releaseReady:false};
}
