// Diagnostic-only contracts; profiles never change release acceptance.
export function cpuProfilePlan(value) {
  if (value !== undefined && value !== '0' && value !== '1') throw Error('CPU profiling must be 0 or 1.');
  return { enabled: value === '1', intervalMicros: 10000,
    scope: 'Page main isolate only; not workers, native CPU, disk or network attribution.' };
}
export function summarizeCpuProfile(profile) {
  const fail = () => { throw Error('Incomplete or invalid CPU profile.'); };
  if (!profile || !Number.isFinite(profile.startTime) || !Number.isFinite(profile.endTime) || profile.endTime <= profile.startTime ||
      !Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !profile.samples.length ||
      !Array.isArray(profile.timeDeltas) || profile.timeDeltas.length !== profile.samples.length) fail();
  const nodes = new Map();
  for (const node of profile.nodes) {
    const frame = node?.callFrame;
    if (!Number.isSafeInteger(node?.id) || node.id < 1 || nodes.has(node.id) || !frame ||
        typeof frame.functionName !== 'string' || typeof frame.url !== 'string' ||
        ![frame.lineNumber, frame.columnNumber].every(v => Number.isSafeInteger(v) && v >= -1)) fail();
    nodes.set(node.id, { id: node.id, functionName: frame.functionName, url: frame.url,
      lineNumber: frame.lineNumber, columnNumber: frame.columnNumber, samples: 0, sampledSelfUs: 0 });
  }
  let sampledDurationUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = nodes.get(profile.samples[i]), delta = profile.timeDeltas[i];
    if (!node || !Number.isSafeInteger(delta) || delta < 0) fail();
    node.samples++; node.sampledSelfUs += delta; sampledDurationUs += delta;
  }
  return { sampleCount: profile.samples.length, profileDurationUs: profile.endTime - profile.startTime, sampledDurationUs,
    frames: [...nodes.values()].filter(node => node.samples).sort((a, b) => b.sampledSelfUs - a.sampledSelfUs || a.id - b.id),
    scope: 'Time-delta weighted periodic self samples, including idle. Approximate attribution, not continuous CPU time or a performance acceptance result.' };
}
