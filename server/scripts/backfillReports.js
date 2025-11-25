#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname replacement for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function walk(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, results);
    } else if (e.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function isImageFile(p) {
  const ext = path.extname(p).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff", ".bmp"].includes(ext);
}

function rel(p) {
  return path.relative(process.cwd(), p).replace(/\\\\/g, "/");
}

function usage() {
  console.log("Usage: node backfillReports.js [--dry-run] [--apply]");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.length === 0;
const apply = args.includes("--apply");
if (!dryRun && !apply) {
  usage();
}

const reportsFile = path.join(process.cwd(), "data", "reports.json");
if (!fs.existsSync(reportsFile)) {
  console.error("data/reports.json not found. Run from project root.");
  process.exit(1);
}

const reportsRaw = fs.readFileSync(reportsFile, "utf8");
let reports = [];
try {
  reports = JSON.parse(reportsRaw);
} catch (err) {
  console.error("Failed to parse data/reports.json:", err.message);
  process.exit(1);
}

const uploadsDir = path.join(process.cwd(), "files");
const allFiles = fs.existsSync(uploadsDir) ? walk(uploadsDir).filter(isImageFile) : [];

function findBestMatch(pdfMtimeMs) {
  if (allFiles.length === 0) return null;
  const candidates = allFiles.map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }));

  // prefer candidates with mtime <= pdfMtime, choose closest to pdfMtime
  const le = candidates.filter((c) => c.mtime <= pdfMtimeMs).sort((a, b) => b.mtime - a.mtime);
  if (le.length > 0) return le[0].p;

  // otherwise fallback to the closest by absolute difference
  candidates.sort((a, b) => Math.abs(a.mtime - pdfMtimeMs) - Math.abs(b.mtime - pdfMtimeMs));
  return candidates[0].p;
}

const proposed = [];

for (const r of reports) {
  const needs = !r.processedImage || r.processedImage === null || r.processedImage === "";
  let existingPathOK = false;
  if (!needs) {
    const abs = path.join(process.cwd(), r.processedImage);
    if (fs.existsSync(abs)) existingPathOK = true;
  }

  if (!needs && existingPathOK) continue; // nothing to do

  // determine pdf mtime if possible
  let pdfPath = r.pdfPath || r.path || null;
  let pdfAbs = null;
  if (pdfPath) pdfAbs = path.join(process.cwd(), pdfPath);

  let pdfMtime = null;
  if (pdfAbs && fs.existsSync(pdfAbs)) {
    pdfMtime = fs.statSync(pdfAbs).mtimeMs;
  } else if (r.createdAt) {
    const t = Date.parse(r.createdAt);
    if (!isNaN(t)) pdfMtime = t;
  }
  if (!pdfMtime) pdfMtime = Date.now();

  const match = findBestMatch(pdfMtime);
  if (match) {
    const relative = rel(match);
    proposed.push({ id: r.id || r.reportId || r.pdfPath, before: r.processedImage || null, after: relative });
  } else {
    proposed.push({ id: r.id || r.reportId || r.pdfPath, before: r.processedImage || null, after: null });
  }
}

if (proposed.length === 0) {
  console.log("No reports need backfilling (all have valid processedImage fields).");
  process.exit(0);
}

console.log(`Proposed updates for ${proposed.length} report(s):`);
for (const p of proposed) {
  console.log(`- id=${p.id}  ->  ${p.before}  =>  ${p.after}`);
}

if (dryRun) {
  console.log("\nDry run complete. No files were modified. To apply these changes, re-run with --apply");
  process.exit(0);
}

// apply
const backup = path.join(process.cwd(), "data", `reports.json.bak.${Date.now()}`);
fs.copyFileSync(reportsFile, backup);
console.log(`Backup created: ${backup}`);

let changed = 0;
for (const p of proposed) {
  if (!p.after) continue;
  const idx = reports.findIndex((x) => (x.id && x.id === p.id) || (x.reportId && x.reportId === p.id) || (x.pdfPath && x.pdfPath === p.id));
  if (idx === -1) continue;
  if (!reports[idx].processedImage || reports[idx].processedImage !== p.after) {
    reports[idx].processedImage = p.after;
    changed++;
  }
}

fs.writeFileSync(reportsFile, JSON.stringify(reports, null, 2), "utf8");
console.log(`Applied changes. ${changed} report(s) updated.`);
console.log("Done.");
