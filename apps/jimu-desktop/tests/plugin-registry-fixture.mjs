import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const FIXTURE_PLUGIN_NAME = "jimu-fixture-plugin";
const require = createRequire(import.meta.url);
const pnpmCli = path.join(path.dirname(require.resolve("pnpm")), "bin", "pnpm.mjs");

async function packFixture(root, packageDirectory) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmCli, "pack", "--pack-destination", root, "--silent"], {
      cwd: packageDirectory,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`pnpm pack failed with ${code}`)));
  });
}

/** Start a deterministic public-catalog and npm Registry fixture. */
export async function createPluginRegistryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jimu-plugin-registry-"));
  const packageDirectory = path.join(root, "fixture-plugin");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify({
    name: FIXTURE_PLUGIN_NAME,
    version: "1.0.0",
    license: "MIT",
    type: "module",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, null, 2)}\n`);
  await writeFile(path.join(packageDirectory, "cordis.patch.yml"), "[]\n");
  await packFixture(root, packageDirectory);

  const tarballName = `${FIXTURE_PLUGIN_NAME}-1.0.0.tgz`;
  const tarball = await readFile(path.join(root, tarballName));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  let baseUrl = "";
  const server = createServer((request, response) => {
    if (request.url === "/plugins.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ updated: "fixture", plugins: [{
        name: FIXTURE_PLUGIN_NAME,
        owner: "i-yolo",
        url: "https://github.com/i-YOLO/JiMu-Harness",
        category: "tools",
        npm: FIXTURE_PLUGIN_NAME,
        description: { zh: "用于 JiMu 插件安装验收的本地测试 Bundle。" },
        stars: 1,
        install: `dsh plugin --profile web add ${FIXTURE_PLUGIN_NAME}`,
      }] }));
      return;
    }
    if (request.url === `/${FIXTURE_PLUGIN_NAME}`) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        "dist-tags": { latest: "1.0.0" },
        time: { created: "2020-01-01T00:00:00.000Z", modified: "2020-01-01T00:00:00.000Z", "1.0.0": "2020-01-01T00:00:00.000Z" },
        versions: { "1.0.0": {
          name: FIXTURE_PLUGIN_NAME,
          version: "1.0.0",
          license: "MIT",
          type: "module",
          dsh: { bundle: { patch: "./cordis.patch.yml" } },
          dist: { integrity, tarball: `${baseUrl}/${FIXTURE_PLUGIN_NAME}/-/${tarballName}` },
        } },
      }));
      return;
    }
    if (request.url === `/${FIXTURE_PLUGIN_NAME}/-/${tarballName}`) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(tarball);
      return;
    }
    response.writeHead(503).end("fixture unavailable");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("plugin registry did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  let closed = false;
  return {
    catalogUrl: `${baseUrl}/plugins.json`,
    unavailableCatalogUrl: `${baseUrl}/unavailable.json`,
    registryUrl: baseUrl,
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
