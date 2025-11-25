#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
  console.log("Usage: node dedupeReports.js [--dry-run|--apply]");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.length === 0;
const apply = args.includes("--apply");
if (!dryRun && !apply) usage();

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

// Deduplicate: keep only the latest report per userId + processedImage
const key = (r) => `${r.userId}::${(r.processedImage||"").replace(/\\/g, "/")}`;
const map = new Map();
for (const r of reports) {
  const k = key(r);
  if (!map.has(k)) {
    map.set(k, r);
  } else {
    // keep the latest
    const existing = map.get(k);
    if (new Date(r.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      map.set(k, r);
    }
  }
}

const deduped = Array.from(map.values());
const removed = reports.length - deduped.length;

console.log(`Would remove ${removed} duplicate report(s). Final count: ${deduped.length}`);
if (dryRun) {
  console.log("Dry run complete. No files were modified.");
  process.exit(0);
}

// Backup and write
const backup = path.join(process.cwd(), "data", `reports.json.bak.dedupe.${Date.now()}`);
fs.copyFileSync(reportsFile, backup);
fs.writeFileSync(reportsFile, JSON.stringify(deduped, null, 2), "utf8");
console.log(`Backup created: ${backup}`);
console.log(`Deduplication complete. ${removed} report(s) removed.`);