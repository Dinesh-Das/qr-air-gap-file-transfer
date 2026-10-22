// Development-only experiment boundary. Product defaults are never edited on disk.
export function readBenchmarkWindow(value) {
  if (value === undefined) return 96;
  if (value !== "64" && value !== "96") throw new Error("Benchmark window must be 64 or 96.");
  return Number(value);
}
export function benchmarkWindowSource(source, blocks) {
  if (blocks !== 64 && blocks !== 96) throw new Error("Benchmark window must be 64 or 96.");
  const marker = "const MAX_IN_FLIGHT_BLOCKS = 96;";
  if (source.split(marker).length !== 2) throw new Error("Benchmark window anchor no longer matches production source.");
  return source.replace(marker, `const MAX_IN_FLIGHT_BLOCKS = ${blocks};`);
}

export function benchmarkWindowCases() {
  const cases = [];
  for (let repetition = 1; repetition <= 4; repetition++) {
    for (const blocks of repetition % 2 ? [96, 64] : [64, 96]) {
      for (const mode of repetition % 2 ? ["raw", "transfer"] : ["transfer", "raw"]) {
        cases.push({ repetition, blocks, mode, id: `r${repetition}-w${blocks}-${mode}` });
      }
    }
  }
  return cases;
}
