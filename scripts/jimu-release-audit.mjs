#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_TEMPLATE_DIRECTORIES } from "../apps/jimu-ui-preview/shared/knowledge-schema.mjs";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

const requestedRoot = option("--root");
if (!requestedRoot) throw new Error("Usage: node scripts/jimu-release-audit.mjs --root <mounted-app-or-resources> [--platform darwin|win32 --arch arm64|x64] [--denylist <file>]");

const root = await realpath(path.resolve(requestedRoot));
const denylistPath = option("--denylist");
const platform = option("--platform");
const architecture = option("--arch");
if ((platform && !architecture) || (!platform && architecture)) throw new Error("--platform and --arch must be supplied together");
if (platform && platform !== "darwin" && platform !== "win32") throw new Error(`Unsupported audit platform: ${platform}`);
if (architecture && architecture !== "arm64" && architecture !== "x64") throw new Error(`Unsupported audit architecture: ${architecture}`);
const privateTerms = denylistPath
  ? (await readFile(path.resolve(denylistPath), "utf8")).split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"))
  : [];

const forbiddenSegments = new Set(["artifacts", "examples", "screenshots", "test", "tests"]);
const forbiddenNames = new Set(["design-qa.md", "migrate-factory-assets.mjs"]);
const findings = new Map();

function flag(rule, file) {
  const files = findings.get(rule) ?? new Set();
  files.add(file);
  findings.set(rule, files);
}

async function listFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(absolute);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) flag("escaping-symlink", nextRelative);
      continue;
    }
    if (entry.isDirectory()) files.push(...await listFiles(absolute, nextRelative));
    else if (entry.isFile()) files.push(nextRelative);
  }
  return files;
}

const files = (await listFiles(root)).sort();
if (platform && architecture) {
  const expectedPrebuild = `${platform}-${architecture}`;
  const expectedSuffix = `app/node_modules/node-pty/prebuilds/${expectedPrebuild}/pty.node`;
  if (!files.some(file => file === expectedSuffix || file.endsWith(`/${expectedSuffix}`))) flag("node-pty-native", "<missing>");
  for (const file of files) {
    const marker = "/node_modules/node-pty/prebuilds/";
    const normalized = `/${file}`;
    const index = normalized.indexOf(marker);
    if (index === -1) continue;
    const packagedPlatform = normalized.slice(index + marker.length).split("/")[0];
    if (packagedPlatform !== expectedPrebuild) flag("wrong-platform-native", file);
  }
}
const knowledgeManifestSuffix = "jimu-knowledge-template/jimu-knowledge.json";
const knowledgeManifests = files.filter(file => file === knowledgeManifestSuffix || file.endsWith(`/${knowledgeManifestSuffix}`));
if (knowledgeManifests.length !== 1) {
  flag("knowledge-template-manifest", knowledgeManifests.length === 0 ? "<missing>" : "<multiple>");
} else {
  const templateRelative = path.posix.dirname(knowledgeManifests[0]);
  const templateRoot = path.join(root, ...templateRelative.split("/"));
  for (const directory of KNOWLEDGE_TEMPLATE_DIRECTORIES) {
    const relative = path.posix.join(templateRelative, directory);
    try {
      const info = await lstat(path.join(templateRoot, directory));
      if (!info.isDirectory() || info.isSymbolicLink()) flag("knowledge-template-directory", relative);
    } catch {
      flag("knowledge-template-directory", relative);
    }
  }
}
const privateRootPattern = new RegExp(["AI", "Second", "Brain", "Lite"].join("-"), "iu");
const everywhereRules = [
  ["private-user-path", new RegExp(["/", "Users", "/", "sh", "ike", "/"].join(""), "u")],
  ["private-source-root", privateRootPattern],
];
const ownedContentRules = [
  ["credential-material", /(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,})/u],
  ["temporary-signed-url", /[?&](?:xsec_token|sign|signature|x-amz-signature)=/iu],
];

for (const file of files) {
  const segments = file.toLocaleLowerCase("en-US").split("/");
  const packagedApplicationFile = file.includes("/Contents/Resources/app/") || file.startsWith("Contents/Resources/app/")
    || !file.includes("/Contents/");
  if (packagedApplicationFile && segments.some(segment => forbiddenSegments.has(segment))) flag("forbidden-release-path", file);
  if (forbiddenNames.has(path.basename(file).toLocaleLowerCase("en-US"))) flag("forbidden-release-file", file);

  const info = await lstat(path.join(root, file));
  if (info.size > 250 * 1024 * 1024) {
    flag("oversized-unscanned-file", file);
    continue;
  }
  const content = (await readFile(path.join(root, file))).toString("latin1");
  for (const [rule, pattern] of everywhereRules) if (pattern.test(content)) flag(rule, file);
  const ownedContent = /(?:^|\/)Contents\/Resources\/(?:app\/(?:dist|config)\/|jimu-knowledge(?:-template)?\/|shared\/|(?:LICENSE|THIRD_PARTY_NOTICES\.md|TRADEMARKS\.md)$)/u.test(file)
    || /^(?:dist|config|jimu-knowledge(?:-template)?|shared)(?:\/|$)/u.test(file);
  if (ownedContent) for (const [rule, pattern] of ownedContentRules) if (pattern.test(content)) flag(rule, file);
  const folded = content.toLocaleLowerCase("en-US");
  if (privateTerms.some(term => folded.includes(term.toLocaleLowerCase("en-US")))) flag("private-denylist", file);
}

console.log(`JiMu release audit: ${files.length} files, ${findings.size} failed rules.`);
for (const [rule, matched] of [...findings].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${rule}:`);
  for (const file of [...matched].sort()) console.log(`  ${file}`);
}
if (findings.size > 0) process.exitCode = 1;
