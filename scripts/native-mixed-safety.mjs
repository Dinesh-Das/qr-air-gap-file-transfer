import assert from "node:assert/strict";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { nativeSampleComplete } from "./native-ui-contract.mjs";

const contains = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
};

// Resolve the existing parent first so junctions cannot hide a sealed ancestor.
export async function assertIndependentMixedOutput(output, fixturePath, fixture) {
  const parent = await realpath(dirname(output)), target = resolve(parent, basename(output));
  for (const protectedPath of [await realpath(dirname(fixturePath)), await realpath(fixture.sourceDirectory)]) {
    assert(!contains(protectedPath, target) && !contains(target, protectedPath), "Mixed output/source overlap");
  }
  for (let current = parent;; current = dirname(current)) {
    try { await access(join(current, "CLOSURE-HASHES.json")); }
    catch (error) { if (error.code === "ENOENT") { if (dirname(current) === current) break; continue; } throw error; }
    throw Error("Mixed output is inside sealed evidence");
  }
}

export async function closeMixedAudit(operations, errors) {
  for (const close of operations) {
    try { await close(); } catch (error) { errors.push(String(error)); }
  }
}

export function stableMixedNativeSample(row) {
  if (!nativeSampleComplete(row) || !Array.isArray(row.after) || row.after.length !== row.before.length) return false;
  const ids = row.before.map(p => p.id), after = row.after.map(p => p?.id);
  return new Set(after).size === after.length && after.every(id => ids.includes(id));
}
