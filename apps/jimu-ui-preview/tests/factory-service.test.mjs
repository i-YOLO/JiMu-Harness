import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FactoryService } from "../scripts/factory-service.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jimu-factory-"));
  const service = new FactoryService({ root });
  await service.initialize();
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, service };
}

test("factory initialization is read-only and returns an empty snapshot", async (t) => {
  const { root, service } = await fixture(t);
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.counts.ideas, 0);
  assert.equal(snapshot.counts.assets, 0);
  assert.equal(snapshot.pipeline.length, 10);
  assert.equal(snapshot.pipeline.find((stage) => stage.id === "video")?.planned, true);
  await assert.rejects(access(path.join(root, "08-自媒体工厂")), /ENOENT/);
});

test("inspiration promotion keeps the human gate and refuses duplicate topics", async (t) => {
  const { root, service } = await fixture(t);
  const idea = await service.createInspiration({
    title: "验证一个内容机制",
    body: "这是一条需要继续验证的个人观察，不直接视为正式选题。",
    sourceType: "personal",
  });
  assert.equal(idea.type, "Inspiration");
  const topic = await service.promoteTopic({ stableId: idea.stableId });
  assert.equal(topic.type, "TopicCandidate");
  assert.equal(topic.referencePath, idea.sourcePath);
  await assert.rejects(() => service.promoteTopic({ stableId: idea.stableId }), /已经进入选题候选/);
  assert.match(await readFile(path.join(root, topic.sourcePath), "utf8"), /目标受众/);
});

test("content revisions are append-only and require a revision before approval", async (t) => {
  const { root, service } = await fixture(t);
  const record = await service.saveContentRevision({ title: "版本化文案", body: "第一版文案正文。" });
  const first = await service.readContent({ stableId: record.stableId });
  assert.equal(first.text, "第一版文案正文。");
  const updated = await service.saveContentRevision({ stableId: record.stableId, title: "版本化文案", body: "第二版人工修改。" });
  assert.notEqual(updated.latestRevision, record.latestRevision);
  assert.equal((await service.readContent({ stableId: record.stableId })).text, "第二版人工修改。");
  const approved = await service.approveScript({ stableId: record.stableId });
  assert.equal(approved.status, "script-approved");
  const linked = await service.linkAgentSession({ stableId: record.stableId, workspaceId: "workspace-01", sessionId: "session-01" });
  assert.equal(linked.agentSessionId, "session-01");
  assert.equal((await stat(path.join(root, path.dirname(updated.latestRevision), "01-文案修订.md"))).isFile(), true);
  assert.equal((await stat(path.join(root, path.dirname(updated.latestRevision), "02-文案修订.md"))).isFile(), true);
});

test("manual and CSV metrics produce real timestamped snapshots", async (t) => {
  const { service } = await fixture(t);
  const publication = await service.savePublication({ title: "已发布内容", platform: "测试平台", publishedAt: "2026-08-15T09:00" });
  await service.addMetricSnapshot({ publicationId: publication.stableId, capturedAt: "2026-08-15T10:00", views: 100, likes: 10, favorites: 5, comments: 2, shares: 1, follows: 3 });
  const imported = await service.importMetricsCsv({
    publicationId: publication.stableId,
    csv: "日期,播放,点赞,收藏,评论,分享,涨粉\n2026-08-15T11:00,150,18,8,4,2,6",
  });
  assert.equal(imported.imported, 1);
  const analytics = service.getSnapshot().analytics[0];
  assert.equal(analytics.snapshots, 2);
  assert.equal(analytics.latest.metrics.views, 150);
  assert.equal(analytics.delta.views, 50);
});

test("asset listing uses real files and never follows an escaping symlink", async (t) => {
  const { root, service } = await fixture(t);
  const imagePath = path.join(root, "08-自媒体工厂/03-素材库/01-图片与配图/approved-test.png");
  await mkdir(path.dirname(imagePath), { recursive: true });
  await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await service.refresh();
  const result = service.listAssets({ status: "approved", kind: "image" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].status, "approved");
  assert.match(result.items[0].assetUrl, /^jimu-asset:\/\/local\//);
  await assert.rejects(() => service.safeFactoryFile("../AGENTS.md"), /只允许访问自媒体工厂目录/);
});

test("asset tree hides legacy illustrations and presents B-roll and motion folders through production-facing groups", async (t) => {
  const { root, service } = await fixture(t);
  const assetRoot = path.join(root, "08-自媒体工厂/03-素材库");
  const paths = {
    hidden: path.join(assetRoot, "01-图片与配图/知识库内容素材/旧文章配图/hidden.png"),
    overview: path.join(assetRoot, "02-B-roll/Jimu-B-roll-素材库/Jimu B-roll 素材库 V1/02-素材总览/overview.png"),
    basic: path.join(assetRoot, "02-B-roll/Jimu-B-roll-素材库/Jimu B-roll 素材库 V1/01-最终素材/01-无角色素材/01-基础试验/basic.png"),
    flow: path.join(assetRoot, "02-B-roll/Jimu-B-roll-素材库/Jimu B-roll 素材库 V1/01-最终素材/01-无角色素材/02-流程与状态/flow.png"),
    character: path.join(assetRoot, "02-B-roll/Jimu-B-roll-素材库/Jimu B-roll 素材库 V1/01-最终素材/02-Jimu角色/character.png"),
    motion: path.join(assetRoot, "04-文字与图形动效/Jimu-动效库/02-文字动效/01-Type-Writer/typewriter.mp4"),
  };
  for (const file of Object.values(paths)) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from("fixture"));
  }
  await service.refresh();

  const snapshot = service.getSnapshot();
  assert.equal(snapshot.counts.assets, 4);
  assert.equal(service.listAssets({ query: "hidden" }).total, 0);
  assert.equal(service.listAssets({ query: "overview" }).total, 0);
  const imageGroup = snapshot.assets.tree.children.find((node) => node.name === "01-图片与配图");
  assert.equal(imageGroup.totalAssets, 0);
  assert.equal(imageGroup.children.length, 0);

  const broll = snapshot.assets.tree.children.find((node) => node.name === "02-B-roll");
  assert.deepEqual(broll.children.map((node) => node.name), ["01-无角色素材", "02-有角色素材"]);
  const noCharacter = broll.children[0];
  assert.equal(noCharacter.aggregate, false);
  assert.deepEqual(noCharacter.children.map((node) => node.name), ["01-通用基础元素", "02-流程与状态"]);
  assert.equal(service.listAssets({ directory: noCharacter.sourcePath, recursive: true }).total, 2);
  const motion = service.listAssets({ kind: "motion" }).items[0];
  assert.equal(motion.previewType, "video");
  const motionRoot = snapshot.assets.tree.children.find((node) => node.name === "04-文字与图形动效");
  const motionLibrary = motionRoot.children.find((node) => node.name === "Jimu-动效库");
  const textMotion = motionLibrary.children.find((node) => node.name === "02-文字动效");
  assert.equal(textMotion.viewMode, "motion-gallery");
  assert.equal(textMotion.children[0].name, "01-Type-Writer");
  assert.equal(textMotion.children[0].previewAsset.previewType, "video");
  assert.equal(textMotion.children[0].previewAsset.sourcePath, "08-自媒体工厂/03-素材库/04-文字与图形动效/Jimu-动效库/02-文字动效/01-Type-Writer/typewriter.mp4");
});
