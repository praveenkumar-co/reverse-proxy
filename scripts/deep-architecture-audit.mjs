#!/usr/bin/env node
// =============================================================================
//  CODEBASE CONNECTIVITY & BEHAVIORAL INVARIANT AUDIT
// =============================================================================
//  - Full-graph AST-ish traversal of src/ to classify every file: CONNECTED,
//    CONTRACT_OR_TYPE, BARREL_EXPORT, ISOLATED_MODULE, TEST_ONLY, or DEAD_CODE
//    (counting test importers when labelling a module isolated vs. dead)
//  - Runtime feature claims are proven by actually running
//    tests/datapath-regression.mjs and tests/production-gates.mjs and
//    reporting their real pass/fail results — not by grepping for strings.
//  - Exits 1 if any dead files remain, or if either behavioral suite fails.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const TESTS_DIR = path.join(REPO_ROOT, "tests");

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const C = (s) => `\x1b[36m${s}\x1b[0m`;
const M = (s) => `\x1b[35m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

function getAllFiles(dir, exts) {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === "simulations") continue;
      files = files.concat(getAllFiles(fullPath, exts));
    } else if (exts.some((e) => item.name.endsWith(e))) {
      files.push(fullPath);
    }
  }
  return files;
}

const allSrcFiles = getAllFiles(SRC_DIR, [".ts"]).map((f) => path.relative(REPO_ROOT, f));
const allTestFiles = getAllFiles(TESTS_DIR, [".mjs", ".js", ".ts"]).map((f) => path.relative(REPO_ROOT, f));

// -----------------------------------------------------------------------------
// 1. Full Dependency Graph & Importers Map
// -----------------------------------------------------------------------------
const importMap = new Map(); // file -> [importedFiles]
const importedByMap = new Map(); // file -> [importers]

for (const file of allSrcFiles) {
  importMap.set(file, []);
  importedByMap.set(file, []);
}

const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g;
const dynamicImportRegex = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function resolveImport(importerRelPath, targetRelPath) {
  const dir = path.dirname(importerRelPath);
  let resolved = path.normalize(path.join(dir, targetRelPath));
  if (resolved.endsWith(".js")) resolved = resolved.slice(0, -3) + ".ts";
  else if (!resolved.endsWith(".ts")) {
    if (fs.existsSync(path.join(REPO_ROOT, resolved + ".ts"))) resolved += ".ts";
    else if (fs.existsSync(path.join(REPO_ROOT, resolved, "index.ts"))) resolved = path.join(resolved, "index.ts");
  }
  return resolved;
}

for (const relPath of allSrcFiles) {
  const fullPath = path.join(REPO_ROOT, relPath);
  const content = fs.readFileSync(fullPath, "utf8");

  const registerTarget = (target) => {
    const resolved = resolveImport(relPath, target);
    if (importMap.has(resolved)) {
      if (!importMap.get(relPath).includes(resolved)) importMap.get(relPath).push(resolved);
      if (!importedByMap.get(resolved).includes(relPath)) importedByMap.get(resolved).push(relPath);
    }
  };

  let match;
  while ((match = importRegex.exec(content)) !== null) registerTarget(match[1]);
  while ((match = dynamicImportRegex.exec(content)) !== null) registerTarget(match[1]);
}

// Parse test files to find test importers (tests/simulations/ excluded above —
// it models concepts, not src/, so it must not keep a dead src/ file "alive").
const testImportersMap = new Map();
for (const file of allSrcFiles) testImportersMap.set(file, []);

for (const testRelPath of allTestFiles) {
  const fullPath = path.join(REPO_ROOT, testRelPath);
  const content = fs.readFileSync(fullPath, "utf8");

  const registerTestTarget = (target) => {
    let resolved = resolveImport(testRelPath, target);
    if (resolved.includes("dist/")) {
      resolved = resolved.replace(/dist\//g, "src/");
    }
    if (testImportersMap.has(resolved)) {
      if (!testImportersMap.get(resolved).includes(testRelPath)) {
        testImportersMap.get(resolved).push(testRelPath);
      }
    }
  };

  let match;
  while ((match = importRegex.exec(content)) !== null) registerTestTarget(match[1]);
  while ((match = dynamicImportRegex.exec(content)) !== null) registerTestTarget(match[1]);
}

// -----------------------------------------------------------------------------
// 2. Reachability from Core Cluster Entrypoints
// -----------------------------------------------------------------------------
// src/lib.ts is package.json's "main"/"exports" entry for npm consumers
// (`import { createServer } from "ninja-reverse-proxy"`) — a real root, not dead code.
const rootEntrypoints = ["src/index.ts", "src/lib.ts", "src/core/cluster/master.ts", "src/core/cluster/worker.ts"];

const reachable = new Set();
function markReachable(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  const targets = importMap.get(file) || [];
  for (const t of targets) markReachable(t);
}

for (const ep of rootEntrypoints) {
  if (importMap.has(ep)) markReachable(ep);
}

// -----------------------------------------------------------------------------
// 3. File Classification Engine
// -----------------------------------------------------------------------------
const fileRegistry = [];

for (const file of allSrcFiles) {
  const srcImporters = importedByMap.get(file) || [];
  const testImporters = testImportersMap.get(file) || [];
  const isReachable = reachable.has(file);
  const isTypeContract = file.includes("/contracts/") || file.endsWith(".types.ts");
  const isBarrel = file.endsWith("index.ts");
  const isEntry = rootEntrypoints.includes(file);

  let status = "DEAD_CODE";
  let description = "";

  if (isEntry || isReachable) {
    status = "CONNECTED";
    description = "Active in runtime cluster execution path";
  } else if (isTypeContract) {
    status = "CONTRACT_OR_TYPE";
    description = "TypeScript interface/type declaration (erased at compile-time)";
  } else if (isBarrel) {
    status = "BARREL_EXPORT";
    description = "Subsystem barrel re-export (available for public library consumption)";
  } else if (srcImporters.length > 0) {
    status = "ISOLATED_MODULE";
    description = `Imported internally by ${srcImporters.length} file(s), but not reached by cluster master/worker`;
  } else if (testImporters.length > 0) {
    status = "TEST_ONLY";
    description = `Directly tested by ${testImporters.length} test suite(s), but unreferenced in runtime`;
  } else {
    status = "DEAD_CODE";
    description = "Zero runtime or test importers — candidate for pruning or deprecation";
  }

  const parts = file.split(path.sep);
  const subsystem = parts.length > 2 ? parts[1] : "root";

  fileRegistry.push({
    file,
    subsystem,
    status,
    description,
    srcImportersCount: srcImporters.length,
    testImportersCount: testImporters.length,
    srcImporters,
    testImporters,
  });
}

const subsystems = {};
for (const item of fileRegistry) {
  if (!subsystems[item.subsystem]) subsystems[item.subsystem] = [];
  subsystems[item.subsystem].push(item);
}

const deadFiles = fileRegistry.filter((f) => f.status === "DEAD_CODE");
const isolatedFiles = fileRegistry.filter((f) => f.status === "ISOLATED_MODULE");

// -----------------------------------------------------------------------------
// 4. Behavioral Verification — actually run the real suites, don't grep for strings
// -----------------------------------------------------------------------------
const BEHAVIORAL_SUITES = ["tests/datapath-regression.mjs", "tests/production-gates.mjs"];

function runSuite(relPath) {
  const fullPath = path.join(REPO_ROOT, relPath);
  const result = spawnSync(process.execPath, [fullPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const summaryMatch = output.match(/([\d,]+)\s*\/\s*([\d,]+)\s*(?:PASSED|passed|Passed)/);
  return {
    suite: relPath,
    passed: result.status === 0,
    exitCode: result.status,
    summary: summaryMatch ? `${summaryMatch[1]}/${summaryMatch[2]} passed` : result.status === 0 ? "exit 0" : "exit non-zero",
    tailOutput: output.trim().split("\n").slice(-8).join("\n"),
  };
}

const behavioralResults = BEHAVIORAL_SUITES.map(runSuite);
const behavioralFailures = behavioralResults.filter((r) => !r.passed);

// -----------------------------------------------------------------------------
// 5. Output Handler (JSON vs Terminal)
// -----------------------------------------------------------------------------
const isJsonMode = process.argv.includes("--json");

if (isJsonMode) {
  const jsonReport = {
    timestamp: new Date().toISOString(),
    totalSourceFiles: allSrcFiles.length,
    classificationSummary: {
      CONNECTED: fileRegistry.filter((f) => f.status === "CONNECTED").length,
      CONTRACT_OR_TYPE: fileRegistry.filter((f) => f.status === "CONTRACT_OR_TYPE").length,
      BARREL_EXPORT: fileRegistry.filter((f) => f.status === "BARREL_EXPORT").length,
      ISOLATED_MODULE: isolatedFiles.length,
      TEST_ONLY: fileRegistry.filter((f) => f.status === "TEST_ONLY").length,
      DEAD_CODE: deadFiles.length,
    },
    subsystems: Object.keys(subsystems).map((sub) => ({
      name: sub,
      totalFiles: subsystems[sub].length,
      files: subsystems[sub].map((f) => ({
        path: f.file,
        status: f.status,
        srcImporters: f.srcImportersCount,
        testImporters: f.testImportersCount,
      })),
    })),
    behavioralVerification: behavioralResults,
    deadFiles: deadFiles.map((f) => f.file),
    isolatedFiles: isolatedFiles.map((f) => f.file),
  };
  console.log(JSON.stringify(jsonReport, null, 2));
  process.exit(deadFiles.length === 0 && behavioralFailures.length === 0 ? 0 : 1);
}

// Terminal Output
console.log("\n" + BOLD("═".repeat(84)));
console.log(BOLD("  🔬  CODEBASE CONNECTIVITY & BEHAVIORAL INVARIANT AUDIT"));
console.log(BOLD(`  Total Source Inventory: ${C(allSrcFiles.length)} TypeScript files`));
console.log(BOLD("═".repeat(84)));

console.log(`\n${BOLD("1. INVENTORY & CLASSIFICATION SUMMARY")}`);
const connectedCount = fileRegistry.filter((f) => f.status === "CONNECTED").length;
const typeCount = fileRegistry.filter((f) => f.status === "CONTRACT_OR_TYPE").length;
const barrelCount = fileRegistry.filter((f) => f.status === "BARREL_EXPORT").length;

console.log(`   ${G("● CONNECTED")} (Active runtime pipeline):             ${G(connectedCount)} files`);
console.log(`   ${C("◆ CONTRACT / TYPE")} (Zero-overhead TS types):       ${C(typeCount)} files`);
console.log(`   ${M("▲ BARREL EXPORT")} (Public library entrypoints):      ${M(barrelCount)} files`);
console.log(`   ${Y("■ ISOLATED MODULE")} (In-tree but bypasses cluster):  ${Y(isolatedFiles.length)} files`);
console.log(`   ${R("✖ DEAD CODE")} (Zero runtime & zero test importers):  ${R(deadFiles.length)} files`);

console.log(`\n${BOLD("2. SUBSYSTEM-BY-SUBSYSTEM CODEBASE AUDIT")}`);
for (const [sub, files] of Object.entries(subsystems).sort((a, b) => a[0].localeCompare(b[0]))) {
  const connected = files.filter((f) => f.status === "CONNECTED").length;
  const dead = files.filter((f) => f.status === "DEAD_CODE").length;
  const isolated = files.filter((f) => f.status === "ISOLATED_MODULE").length;
  console.log(`\n  📂 ${BOLD(sub.toUpperCase())} (${C(files.length)} files) — Connected: ${G(connected)} | Isolated: ${Y(isolated)} | Dead: ${R(dead)}`);

  for (const f of files) {
    let tag = G("[CONNECTED]      ");
    if (f.status === "DEAD_CODE") tag = R("[DEAD CODE]      ");
    else if (f.status === "ISOLATED_MODULE") tag = Y("[ISOLATED]       ");
    else if (f.status === "CONTRACT_OR_TYPE") tag = C("[TYPE / CONTRACT]");
    else if (f.status === "BARREL_EXPORT") tag = M("[BARREL INDEX]   ");
    else if (f.status === "TEST_ONLY") tag = Y("[TEST ONLY]      ");

    console.log(`     ${tag} ${f.file.padEnd(52)} (src: ${f.srcImportersCount}, tests: ${f.testImportersCount})`);
  }
}

console.log(`\n${BOLD("3. DEAD CODE & CLEANUP ROSTER")}`);
if (deadFiles.length === 0) {
  console.log(`   ${G("✅ Zero dead files detected.")}`);
} else {
  console.log(`   Found ${R(deadFiles.length)} completely unreferenced source files that can be pruned:`);
  for (const d of deadFiles) console.log(`     ${R("✖")} ${d.file}`);
}

console.log(`\n${BOLD("4. ISOLATED MODULES (STANDALONE SUB-PACKAGES)")}`);
if (isolatedFiles.length === 0) {
  console.log(`   ${G("✅ Zero isolated modules.")}`);
} else {
  console.log(`   Found ${Y(isolatedFiles.length)} modules imported internally in their package but bypassed by master/worker:`);
  for (const iso of isolatedFiles) {
    console.log(`     ${Y("↳")} ${iso.file} (imported by: ${iso.srcImporters.join(", ")})`);
  }
}

console.log(`\n${BOLD("5. BEHAVIORAL VERIFICATION (real suite runs, not string matching)")}`);
for (const r of behavioralResults) {
  const tag = r.passed ? G("✅ PASS") : R("❌ FAIL");
  console.log(`   ${tag}  ${r.suite}  (${r.summary}, exit=${r.exitCode})`);
  if (!r.passed) {
    console.log(R(`     last output:\n${r.tailOutput.split("\n").map((l) => `       ${l}`).join("\n")}`));
  }
}

console.log("\n" + BOLD("═".repeat(84)));
const overallPass = deadFiles.length === 0 && behavioralFailures.length === 0;
console.log(
  overallPass
    ? G("  ✅ AUDIT PASSED — 0 dead files, all behavioral suites green.")
    : R(`  ❌ AUDIT FAILED — ${deadFiles.length} dead file(s), ${behavioralFailures.length} behavioral suite(s) failing.`)
);
console.log(BOLD("═".repeat(84)) + "\n");

process.exit(overallPass ? 0 : 1);
