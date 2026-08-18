import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeIndexService } from "../scripts/knowledge-index-service.mjs";

async function fingerprint(files) {
  return await Promise.all(files.map(async (file) => {
    const [content, info] = await Promise.all([readFile(file), stat(file)]);
    return { file, hash: createHash("sha256").update(content).digest("hex"), mtimeMs: info.mtimeMs };
  }));
}

test("indexes, searches, resolves, graphs and incrementally refreshes a read-only macOS knowledge root", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "jimu-index-test-"));
  const root = path.join(fixture, "knowledge-root");
  const support = path.join(fixture, "Library", "Application Support", "JiMu", "knowledge");
  const indexPath = path.join(support, "knowledge-index.json");
  const databasePath = path.join(support, "knowledge-search.sqlite");
  const outside = path.join(fixture, "outside.md");
  const directories = [
    "00-System", "01-Inbox", "02-Projects/fixture-project-001", "03-Knowledge",
    "07-对标博主库/横向对标",
    "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第一条",
    "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/assets",
    "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/analysis",
    "08-自媒体工厂/01-灵感与调研/01-灵感箱",
    "90-Archive", "98-Skills/fixture-skill-001/references", "98-Skills/toolbox", "99-Logs", "assets", ".hidden", "node_modules/package",
  ];
  await Promise.all(directories.map((directory) => mkdir(path.join(root, directory), { recursive: true })));
  const markdownFiles = [
    ["00-System/Hot-Index.md", "# Hot Index\n\n[长期卡](../03-Knowledge/01-长期卡.md)\n"],
    ["00-System/Memory-Index.md", "# Memory Index\n\n[[07-对标博主库/小红书/fixture-profile-001--fixture-account-001/README|Fixture profile]]\n"],
    ["01-Inbox/01-灵感.md", [
      "---", "tags: [灵感, AI]", "aliases: [混合查询夹具]", "---",
      "# 中文项目灵感", "## 下一步", "正文里才有的验证短语。MixedQuery Alpha。",
      "[正式知识卡](../03-Knowledge/01-%E9%95%BF%E6%9C%9F%E5%8D%A1.md#%E7%BB%93%E8%AE%BA)",
      "![本地图](../assets/chart.png)",
    ].join("\n")],
    ["02-Projects/README.md", "# Projects\n\n项目库入口。\n"],
    ["02-Projects/fixture-project-001/README.md", "# fixture-project-001\n\n项目介绍。\n"],
    ["02-Projects/fixture-project-001/01-方案.md", "# Fixture plan\n\n方案正文。\n"],
    ["02-Projects/fixture-project-002.md", "# fixture-project-002\n\n独立项目文档。\n"],
    ["03-Knowledge/01-长期卡.md", "# 长期卡\n\n## 结论\n\n可长期复用的内容。\n"],
    ["07-对标博主库/README.md", "# 对标博主库\n\n全库入口与边界。\n"],
    ["07-对标博主库/01-博主目录.md", "# 博主目录\n\n账号索引总表。\n"],
    ["07-对标博主库/横向对标/01-经验沉淀.md", "# 跨账号经验\n\n可迁移机制。\n"],
    ["07-对标博主库/小红书/fixture-profile-001--fixture-account-001/README.md", "# fixture-profile-001\n\n账号档案。\n"],
    ["07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第一条/01-笔记概览.md", "# 第一条\n\n真实笔记。\n"],
    ["07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/01-笔记概览.md", "# 第二条\n\n高互动笔记。\n"],
    ["07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/analysis/01-内容拆解.md", "# 第二条｜内容拆解\n\n## 结构时间线\n\n开场直接给结果。\n"],
    ["08-自媒体工厂/01-灵感与调研/01-灵感箱/01-工厂灵感.md", "---\njimuType: Inspiration\nstatus: captured\n---\n\n# 工厂灵感\n\n只存在于自媒体工厂的真实记录。\n"],
    ["90-Archive/01-旧资料.md", "# 旧资料\n\n需要明确标记。\n"],
    ["98-Skills/fixture-skill-001/SKILL.md", "---\nname: fixture-skill-001\ndescription: 用中文说明这个匿名 Fixture Skill 的用途和调用边界。\n---\n# Fixture Skill\n\n## 使用说明\n\n处理匿名测试任务。\n"],
    ["98-Skills/fixture-skill-001/references/guide.md", "# 使用指南\n\n只有子文档包含的检索词：树状目录。\n"],
    ["98-Skills/toolbox/SKILL.md", "---\nname: toolbox\ndescription: A reusable toolbox for local workflows.\n---\n# Toolbox\n\nReusable local tools.\n"],
    ["99-Logs/01-日志.md", "# 日志\n\n执行记录。\n"],
  ];
  await Promise.all([
    ...markdownFiles.map(([name, content]) => writeFile(path.join(root, name), content)),
    writeFile(path.join(root, "assets/chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    writeFile(path.join(root, ".hidden/ignored.md"), "# 不应索引\n"),
    writeFile(path.join(root, "node_modules/package/ignored.md"), "# 不应索引\n"),
    writeFile(path.join(root, "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/record.json"), JSON.stringify({
      schema_version: "2.0",
      platform: "xiaohongshu",
      note_id: "note-002",
      title: "第二条",
      type: "video",
      content: { published_at: "2026-05-02T00:00:00.000Z", published_at_local: "2026-05-02 08:00:00 +08:00" },
      metrics: { snapshot_at: "2026-08-13T04:00:00.000Z", like_count: 724, collect_count: 1515, comment_count: 11, share_count: 4 },
      media: {
        cover: { remote_url: "http://example.com/cover.jpg", local_path: null },
        video: { local_path: "assets/source.mp4", duration_seconds: 120 },
      },
    })),
    writeFile(path.join(root, "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/assets/source.mp4"), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])),
    writeFile(path.join(root, "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/assets/cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    writeFile(outside, "# 越界文件\n"),
  ]);
  await symlink(outside, path.join(root, "03-Knowledge/02-越界链接.md"));

  const trackedFiles = markdownFiles.map(([name]) => path.join(root, name));
  const beforeReadOnly = await fingerprint(trackedFiles);
  const service = new KnowledgeIndexService({ root, indexPath, databasePath });
  let cachedService;
  t.after(async () => {
    service.close();
    cachedService?.close();
    await rm(fixture, { recursive: true, force: true });
  });

  const snapshot = await service.initialize();
  assert.equal(snapshot.platform, "macOS");
  assert.equal(snapshot.stats.markdownDocuments, 21);
  assert.equal(snapshot.stats.inspirations, 1);
  assert.equal(snapshot.stats.knowledgeCards, 1);
  assert.equal(snapshot.stats.benchmarkProfiles, 1);
  assert.equal(snapshot.stats.skillDirectories, 2);
  assert.equal(snapshot.stats.archiveDocuments, 1);
  assert.equal(snapshot.stats.logDocuments, 1);
  assert.equal(snapshot.stats.internalLinks, 3);
  assert.equal(snapshot.documents.some((document) => document.title === "不应索引"), false);
  assert.equal(snapshot.documents.some((document) => document.title === "越界文件"), false);
  const factoryRecord = snapshot.documents.find((document) => document.sourcePath === "08-自媒体工厂/01-灵感与调研/01-灵感箱/01-工厂灵感.md");
  assert.equal(factoryRecord.category, "factory");
  assert.equal(factoryRecord.type, "Inspiration");
  assert.equal(factoryRecord.stage, "inspiration");
  assert.equal(snapshot.archiveCardIds.includes(factoryRecord.stableId), false);
  assert.equal(service.search({ query: "自媒体工厂的真实记录" }).hits[0].document.stableId, factoryRecord.stableId);

  const inspiration = snapshot.documents.find((document) => document.sourcePath === "01-Inbox/01-灵感.md");
  assert.deepEqual(inspiration.tags, ["灵感", "AI"]);
  assert.deepEqual(inspiration.aliases, ["混合查询夹具"]);
  assert.ok(inspiration.headings.includes("下一步"));
  assert.ok(inspiration.content.includes("正文里才有的验证短语"));
  assert.equal(inspiration.relatedIds.length, 1);

  const profile = snapshot.documents.find((document) => document.type === "BenchmarkAccount");
  assert.equal(profile.title, "fixture-profile-001");
  assert.equal(profile.benchmarkSection, "directory");
  assert.equal(snapshot.documents.find((document) => document.sourcePath === "07-对标博主库/01-博主目录.md").benchmarkSection, "directory");
  assert.equal(snapshot.documents.find((document) => document.sourcePath === "07-对标博主库/README.md").benchmarkSection, "standards");
  assert.equal(snapshot.documents.find((document) => document.sourcePath === "07-对标博主库/横向对标/01-经验沉淀.md").benchmarkSection, "insights");
  assert.equal(snapshot.documents.find((document) => document.sourcePath === "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/README.md").benchmarkSection, undefined);
  assert.deepEqual(profile.metrics, [
    { value: "2", label: "视频" },
    { value: "1", label: "精拆" },
  ]);
  assert.deepEqual(profile.benchmark.stats, {
    notes: 2,
    videos: 2,
    images: 0,
    localMedia: 1,
    analyzed: 1,
    tagged: 0,
    totalLikes: 724,
    totalCollects: 1515,
    totalComments: 11,
    totalShares: 4,
    medianEngagement: 2250,
  });
  const noteTwo = profile.benchmark.notes[0];
  assert.equal(noteTwo.title, "第二条");
  assert.equal(noteTwo.analysis, "analyzed");
  assert.ok(noteTwo.analysisStableId);
  assert.equal(noteTwo.cover.kind, "local");
  assert.ok(noteTwo.cover.assetUrl.startsWith("jimu-asset://local/"));
  assert.equal(noteTwo.video.kind, "local");
  assert.equal(noteTwo.video.durationSeconds, 120);
  assert.ok(profile.benchmark.documents.some((document) => document.title === "fixture-profile-001"));
  assert.equal(service.listCards({ category: "benchmarks" }).filter((item) => item.type === "BenchmarkAccount").length, 1);
  const mp4 = await service.resolveLink({
    fromPath: "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/01-笔记概览.md",
    href: "assets/source.mp4",
  });
  assert.equal(mp4.kind, "localAsset");
  assert.equal(
    await service.resolveAssetToken(mp4.assetUrl.split("/").at(-1)),
    await realpath(path.join(root, "07-对标博主库/小红书/fixture-profile-001--fixture-account-001/notes/第二条/assets/source.mp4")),
  );
  const projectDirectories = snapshot.documents.filter((document) => document.type === "ProjectDirectory");
  assert.equal(projectDirectories.length, 2);
  assert.equal(snapshot.stats.projects, 2);
  const fixtureProject = projectDirectories.find((document) => document.title === "fixture-project-001");
  assert.equal(fixtureProject.project.stats.documents, 2);
  assert.equal(fixtureProject.project.directoryTree.children.length, 2);
  const fileProject = projectDirectories.find((document) => document.title === "fixture-project-002");
  assert.equal(fileProject.project.stats.documents, 1);
  assert.equal(fileProject.project.directoryTree, null);
  const projectCards = snapshot.archiveCardIds
    .map((id) => snapshot.documents.find((document) => document.stableId === id))
    .filter((document) => document?.category === "projects");
  assert.equal(projectCards.length, 3);
  assert.ok(projectCards.some((document) => document.type === "ProjectDirectory" && document.title === "fixture-project-001"));
  assert.ok(projectCards.some((document) => document.type === "ProjectDirectory" && document.title === "fixture-project-002"));
  assert.ok(projectCards.some((document) => document.sourcePath === "02-Projects/README.md"));
  const innerProjectDoc = snapshot.documents.find((document) => document.sourcePath === "02-Projects/fixture-project-001/01-方案.md");
  assert.equal(snapshot.archiveCardIds.includes(innerProjectDoc.stableId), false);

  const skillCards = service.listCards({ category: "skills" });
  assert.equal(skillCards.length, 2);
  assert.ok(skillCards.every((document) => document.type === "SkillDirectory"));
  const fixtureSkill = skillCards.find((document) => document.title === "fixture-skill-001");
  assert.match(fixtureSkill.excerpt, /中文说明/);
  assert.equal(fixtureSkill.directoryTree.name, "fixture-skill-001");
  assert.ok(fixtureSkill.directoryTree.children.some((node) => node.kind === "directory" && node.name === "references"));
  assert.ok(fixtureSkill.directoryTree.children.some((node) => node.kind === "document" && node.name === "SKILL"));
  const fixtureRead = await service.readDocument({ stableId: fixtureSkill.stableId });
  assert.match(fixtureRead.markdown, /Skill 简介/);
  assert.equal(service.search({ query: "树状目录" }).hits[0].document.sourcePath, "98-Skills/fixture-skill-001/references/guide.md");

  const titleSearch = service.search({ query: "长期卡" });
  assert.equal(titleSearch.hits[0].document.sourcePath, "03-Knowledge/01-长期卡.md");
  assert.equal(titleSearch.hits[0].field, "title");
  assert.equal(service.search({ query: "正文里才有的验证短语" }).hits[0].document.sourcePath, inspiration.sourcePath);
  assert.equal(service.search({ query: "MixedQuery 中文" }).hits[0].document.sourcePath, inspiration.sourcePath);
  assert.equal(service.search({ query: "混合查询夹具" }).hits[0].field, "tag");
  assert.equal(service.search({ query: "正式知识卡" }).hits[0].field, "link");
  assert.equal(service.search({ query: "旧资料" }).hits.some((hit) => hit.document.archiveMarked), false);
  assert.equal(service.search({ query: "旧资料", includeArchive: true }).hits[0].document.archiveMarked, true);
  assert.equal(service.search({ query: "执行记录" }).hits.some((hit) => hit.document.logMarked), false);
  assert.equal(service.search({ query: "执行记录", includeLogs: true }).hits[0].document.logMarked, true);
  assert.equal(service.search({ query: "", category: "knowledge" }).total, 1);
  assert.equal(service.search({ query: "", tag: "灵感" }).total, 1);

  const read = await service.readDocument({ sourcePath: inspiration.sourcePath });
  assert.ok(read.markdown.includes("# 中文项目灵感"));
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "../03-Knowledge/01-%E9%95%BF%E6%9C%9F%E5%8D%A1.md#%E7%BB%93%E8%AE%BA" })).kind, "anchor");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "jimu-wiki:03-Knowledge%2F01-%E9%95%BF%E6%9C%9F%E5%8D%A1" })).kind, "document");
  const asset = await service.resolveLink({ fromPath: inspiration.sourcePath, href: "../assets/chart.png" });
  assert.equal(asset.kind, "localAsset");
  assert.equal(await service.resolveAssetToken(asset.assetUrl.split("/").at(-1)), await realpath(path.join(root, "assets/chart.png")));
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "https://example.com" })).kind, "external");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "javascript:alert(1)" })).kind, "blocked");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "../../../outside.md" })).kind, "blocked");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: path.join(fixture, "absolute-outside.png") })).reason, "absolute-path-outside-root");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "/03-Knowledge/01-长期卡.md" })).kind, "document");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "../missing.md" })).kind, "missing");
  assert.equal((await service.resolveLink({ fromPath: inspiration.sourcePath, href: "../03-Knowledge/01-长期卡.md#不存在" })).reason, "anchor-not-found");
  await assert.rejects(() => service.safeExistingPath("/etc/passwd"), /escapes/);
  await assert.rejects(() => service.safeExistingPath("03-Knowledge/02-越界链接.md"), /Symbolic links|outside/);

  const graph = service.getGraph();
  assert.ok(graph.nodes.some((node) => node.sourcePath === "03-Knowledge/01-长期卡.md" && node.selectionSource === "hot"));
  assert.ok(graph.nodes.some((node) => node.type === "BenchmarkAccount" && node.selectionSource === "benchmark"));
  assert.ok(graph.edges.every((edge) => edge.type === "belongs_to" || edge.type === "links_to"));
  assert.equal(graph.edges.some((edge) => edge.type === "links_to" && edge.source === profile.stableId), false);
  const linkedOnly = service.getGraph({ hideIsolated: true });
  assert.ok(linkedOnly.nodes.length < graph.nodes.length);
  const keyGraph = service.getGraph({ focus: "key", maxDocuments: 8 });
  const keyDocuments = keyGraph.nodes.filter((node) => node.type !== "Category" && node.type !== "Group");
  assert.ok(keyDocuments.length <= 8);
  assert.ok(keyDocuments.every((node) => node.selectionSource !== "linked"));
  assert.equal(keyGraph.stats.selectedDocuments, keyDocuments.length);
  assert.equal(keyGraph.stats.nodes, keyGraph.nodes.length);
  assert.equal(keyGraph.stats.links, keyGraph.edges.filter((edge) => edge.type === "links_to").length);
  assert.ok(keyGraph.edges.every((edge) => keyGraph.nodes.some((node) => node.stableId === edge.source) && keyGraph.nodes.some((node) => node.stableId === edge.target)));

  const persisted = JSON.parse(await readFile(indexPath, "utf8"));
  assert.equal(persisted.stats.markdownDocuments, 21);
  assert.equal(path.dirname(indexPath), support);
  assert.equal(path.dirname(databasePath), support);
  assert.deepEqual(await fingerprint(trackedFiles), beforeReadOnly);

  const stableId = inspiration.stableId;
  const renamedFrom = path.join(root, "01-Inbox/01-灵感.md");
  const renamedTo = path.join(root, "01-Inbox/02-灵感续篇.md");
  await rename(renamedFrom, renamedTo);
  await writeFile(renamedTo, "# 中文项目灵感续篇\n\n增量刷新后的正文。\n");
  await service.refreshRelative("01-Inbox/01-灵感.md");
  await service.refreshRelative("01-Inbox/02-灵感续篇.md");
  assert.equal(service.documentBySourcePath("01-Inbox/01-灵感.md"), null);
  const refreshed = service.documentBySourcePath("01-Inbox/02-灵感续篇.md");
  assert.notEqual(refreshed.stableId, stableId);
  assert.ok(refreshed.content.includes("增量刷新后的正文"));
  const beforeTraversal = service.snapshot.stats.markdownDocuments;
  await service.refreshRelative("../outside.md");
  assert.equal(service.snapshot.stats.markdownDocuments, beforeTraversal);

  service.close();
  await writeFile(renamedTo, "# 后台校准后的标题\n\n磁盘上的更新正文。\n");
  cachedService = new KnowledgeIndexService({ root, indexPath, databasePath });
  const cached = await cachedService.initialize({ backgroundCalibration: true });
  assert.equal(cached.documents.some((document) => document.title === "中文项目灵感续篇"), true);
  await cachedService.whenIdle();
  assert.equal(cachedService.snapshot.documents.some((document) => document.title === "后台校准后的标题"), true);
});
