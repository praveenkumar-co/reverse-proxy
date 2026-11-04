#!/usr/bin/env node
// Scans tests/ (excluding tests/simulations/) for `class X` definitions and
// checks whether X is exported from anything under src/. A test-defined class
// that is not a real src export is presumed to be standing in for the system
// under test (SUT) instead of exercising the real implementation.
//
// Exit 0: no test file defines a class that isn't a real src export.
// Exit 1: at least one does — list them and point at the offending file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(repoRoot, "tests");
const srcDir = path.join(repoRoot, "src");

function walk(dir, exclude = []) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (exclude.some((ex) => full === ex || full.startsWith(ex + path.sep))) continue;
    if (entry.isDirectory()) {
      out.push(...walk(full, exclude));
    } else if (/\.(mjs|js|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findClasses(source) {
  const classes = [];
  const re = /^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    classes.push({ name: m[1], line: source.slice(0, m.index).split("\n").length });
  }
  return classes;
}

const simulationsDir = path.join(testsDir, "simulations");
const testFiles = walk(testsDir, [simulationsDir]);
const srcFiles = walk(srcDir);

const srcExportedNames = new Set();
for (const file of srcFiles) {
  const source = fs.readFileSync(file, "utf8");
  const re = /^\s*export\s+(?:class|function|const|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    srcExportedNames.add(m[1]);
  }
  const braceRe = /^\s*export\s*\{([^}]+)\}/gm;
  while ((m = braceRe.exec(source)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) srcExportedNames.add(name);
    }
  }
}

const rows = [];
let violations = 0;

for (const file of testFiles) {
  const source = fs.readFileSync(file, "utf8");
  const classes = findClasses(source);
  for (const cls of classes) {
    const isRealExport = srcExportedNames.has(cls.name);
    if (!isRealExport) violations++;
    rows.push({
      file: path.relative(repoRoot, file),
      line: cls.line,
      class: cls.name,
      srcExport: isRealExport ? "yes" : "NO",
    });
  }
}

const header = ["file", "line", "class", "srcExport"];
const widths = header.map((h) =>
  Math.max(h.length, ...rows.map((r) => String(r[h === "class" ? "class" : h]).length), 0)
);

function printRow(cells) {
  console.log(cells.map((c, i) => String(c).padEnd(widths[i])).join("  "));
}

console.log(`Scanned ${testFiles.length} test files (excluding tests/simulations/).\n`);

if (rows.length === 0) {
  console.log("No test-defined classes found. PASS.");
  process.exit(0);
}

printRow(header);
printRow(widths.map((w) => "-".repeat(w)));
for (const r of rows) {
  printRow([r.file, r.line, r.class, r.srcExport]);
}

console.log("");
if (violations > 0) {
  console.error(
    `FAIL: ${violations} test-defined class(es) are not exported from src/ — they are standing in as the system under test instead of exercising real code.`
  );
  console.error("Move these to tests/simulations/ (conceptual/DDIA modeling only) or replace with the real src/ implementation.");
  process.exit(1);
} else {
  console.log(`PASS: all ${rows.length} test-defined class(es) correspond to real src/ exports.`);
  process.exit(0);
}
