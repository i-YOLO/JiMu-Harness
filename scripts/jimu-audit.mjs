#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const argumentsList = process.argv.slice(2);
const denylistIndex = argumentsList.indexOf("--denylist");
const denylistPath = denylistIndex >= 0 ? argumentsList[denylistIndex + 1] : "";
const baseIndex = argumentsList.indexOf("--base");
const requestedBase = baseIndex >= 0 ? argumentsList[baseIndex + 1] : "upstream/master";

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").map((item) => item.trim()).filter(Boolean);
}

// The public upstream may advance while a JiMu release is being prepared.
// Audit from the common ancestor so newer upstream-only work is not mislabeled
// as a JiMu change.
const base = git("merge-base", requestedBase, "HEAD")[0] ?? requestedBase;

function unique(values) {
  return [...new Set(values)].sort();
}

const excludedSegments = new Set([".git", "node_modules", "lib", "dist", "release", "artifacts", "build-cache", "coverage"]);
const allFiles = unique([...git("ls-files"), ...git("ls-files", "--others", "--exclude-standard")])
  .filter((file) => !file.split("/").some((segment) => excludedSegments.has(segment)));
const changedFiles = unique([
  ...git("diff", "--name-only", "--diff-filter=ACMR", base, "--"),
  ...git("ls-files", "--others", "--exclude-standard"),
]).filter((file) => allFiles.includes(file));

const approvedBinaryFiles = new Set([
  "apps/jimu-desktop/build/JiMu.icns",
  "apps/jimu-ui-preview/public/assets/jimu-app-icon.png",
  "apps/jimu-ui-preview/public/assets/jimu-icon.png",
  "apps/jimu-ui-preview/public/assets/jimu-paper-texture.png",
]);
const binaryExtensions = new Set([".7z", ".avi", ".bmp", ".dmg", ".gif", ".icns", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".pdf", ".png", ".sqlite", ".webm", ".zip"]);
const forbiddenPathSegments = new Set(["artifacts", "coverage", "dist", "release", "screenshots"]);

const findings = new Map();
function flag(rule, file) {
  const files = findings.get(rule) ?? new Set();
  files.add(file);
  findings.set(rule, files);
}

for (const file of changedFiles) {
  if (file.split("/").some((segment) => forbiddenPathSegments.has(segment))) flag("generated-or-qa-artifact", file);
  if (binaryExtensions.has(path.extname(file).toLowerCase()) && !approvedBinaryFiles.has(file)) flag("unapproved-binary", file);
}

const builtinRules = [
  ["absolute-user-path", /(?:\/Users\/[^/\s"']+\/|[A-Za-z]:\\Users\\)/],
  ["private-source-root", new RegExp(["AI", "Second", "Brain", "Lite"].join("-"), "i")],
  ["credential-material", /(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,})/],
  ["temporary-signed-url", /[?&](?:xsec_token|sign|signature|x-amz-signature)=/i],
];

const privateTerms = denylistPath
  ? (await readFile(path.resolve(root, denylistPath), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  : [];

for (const file of changedFiles) {
  if (binaryExtensions.has(path.extname(file).toLowerCase())) continue;
  let text;
  try {
    text = await readFile(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  for (const [rule, pattern] of builtinRules) if (pattern.test(text)) flag(rule, file);
  if (/^apps\/jimu-(?:desktop|ui-preview)\/(?:src|scripts|shared)\//.test(file)
    && /INITIAL_PROJECTS|PREVIEW_SKILLS|DOC_BY_ID|const\s+DOCUMENTS\b/.test(text)) flag("static-demo-fallback", file);
  if (privateTerms.some((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) flag("private-denylist", file);
}

// The full tree includes public upstream fixtures. An injected local denylist is
// nevertheless checked against every textual file and never printed.
if (privateTerms.length > 0) {
  for (const file of allFiles) {
    if (binaryExtensions.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      text = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    if (privateTerms.some((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) flag("full-tree-private-denylist", file);
  }
}

console.log(`JiMu audit: ${allFiles.length} worktree files, ${changedFiles.length} downstream files, ${findings.size} failed rules.`);
for (const [rule, files] of [...findings].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${rule}:`);
  for (const file of [...files].sort()) console.log(`  ${file}`);
}
if (findings.size > 0) process.exitCode = 1;
