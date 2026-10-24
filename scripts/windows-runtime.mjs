import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { assertSupportedNode } from "./runtime-policy.mjs";

export function readPackagingOptions(args) {
  const result = {};
  const flags = { "--runtime-dir": "runtimeDirectory", "--runtime-sha256": "runtimeSha256" };
  for (let i = 0; i < args.length; i++) {
    const key = Object.hasOwn(flags, args[i]) ? flags[args[i]] : undefined;
    if (key) {
      if (result[key] || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Missing or duplicate runtime option.");
      result[key] = args[++i];
    } else if (!args[i].startsWith("--") && result.output === undefined) result.output = args[i];
    else throw new Error("Unexpected packaging argument: " + args[i]);
  }
  if (Boolean(result.runtimeDirectory) !== Boolean(result.runtimeSha256) ||
      result.runtimeSha256 && !/^[a-f0-9]{64}$/.test(result.runtimeSha256)) {
    throw new Error("Supply both --runtime-dir and --runtime-sha256 (64 lowercase hex characters).");
  }
  return result;
}

/** Build-time trusted input only. A supplied hash is not publisher authentication. */
export async function prepareWindowsRuntime(directory, expectedSha256) {
  const executable = resolve(directory, "node.exe");
  const binary = await readFile(executable);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  if (sha256 !== expectedSha256) throw new Error("Windows runtime checksum does not match the pinned SHA-256.");
  const license = await readFile(resolve(directory, "LICENSE"));
  if (!license.toString().includes("Node.js is licensed for use as follows:") ||
      !license.toString().includes("externally maintained libraries")) {
    throw new Error("Supply the full matching Node.js LICENSE, including third-party notices.");
  }
  if (process.platform !== "win32") throw new Error("Prepare portable Windows bundles on Windows.");
  const { stdout } = await promisify(execFile)(executable, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"], {
    encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096,
  });
  const identity = JSON.parse(stdout);
  if (identity.platform !== "win32" || identity.arch !== "x64" || !/^24\.\d+\.\d+$/.test(identity.version)) {
    throw new Error("Portable bundles currently require Windows x64 Node.js 24.");
  }
  assertSupportedNode(identity.version);
  return { binary, license, identity: { ...identity, sha256, licenseSha256: createHash("sha256").update(license).digest("hex") } };
}
