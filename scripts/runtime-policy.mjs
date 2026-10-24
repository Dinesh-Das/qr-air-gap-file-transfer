// Reviewed security floors: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
// Unknown release lines require review rather than an assumed security guarantee.
export function assertSupportedNode(version = process.versions.node) {
  const match = typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const parts = match ? match.slice(1).map(Number) : [];
  const [major, minor, patch] = parts;
  const floor = new Map([[22, [23, 4]], [24, [22, 1]], [26, [12, 1]]]).get(major);
  if (!floor || !parts.every(Number.isSafeInteger) ||
      minor < floor[0] || minor === floor[0] && patch < floor[1]) {
    throw new Error("This copy needs a newer runtime. Ask the person who supplied it for an updated Windows bundle. (Requires patched Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those release lines.)");
  }
}
