import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FactoryService } from "./scripts/factory-service.mjs";
import { KnowledgeIndexService } from "./scripts/knowledge-index-service.mjs";

const ASSET_TYPES = new Map([
  [".avif", "image/avif"], [".gif", "image/gif"], [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"], [".png", "image/png"], [".svg", "image/svg+xml"], [".webp", "image/webp"],
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"],
  [".mov", "video/quicktime"], [".aac", "audio/aac"], [".flac", "audio/flac"],
  [".m4a", "audio/mp4"], [".mp3", "audio/mpeg"], [".ogg", "audio/ogg"], [".wav", "audio/wav"],
]);

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 6_291_456) throw new Error("JiMu request body is too large.");
  }
  return body ? JSON.parse(body) : {};
}

function jimuKnowledgeIndex() {
  const configuredRoot = process.env.JIMU_KNOWLEDGE_ROOT;
  const previewCacheRoot = path.join(os.tmpdir(), "jimu-ui-preview");
  const service = configuredRoot
    ? new KnowledgeIndexService({
        root: configuredRoot,
        indexPath: process.env.JIMU_INDEX_PATH ?? path.join(previewCacheRoot, "knowledge-index.json"),
        databasePath: process.env.JIMU_SEARCH_DATABASE_PATH ?? path.join(previewCacheRoot, "knowledge-search.sqlite"),
      })
    : null;
  const factory = configuredRoot ? new FactoryService({ root: configuredRoot }) : null;
  const eventClients = new Set();
  const factoryEventClients = new Set();
  let initializationError = null;
  let factoryInitializationError = null;
  const diagnosticKind = (error) => error instanceof Error && error.name ? error.name : "UnknownError";

  return {
    name: "jimu-knowledge-index",
    async configureServer(server) {
      try {
        if (!service) throw new Error("Knowledge root is not configured.");
        await service.initialize();
        service.startWatching();
      } catch (error) {
        initializationError = `Knowledge index initialization failed (${diagnosticKind(error)}).`;
        console.error("JiMu knowledge index initialization failed:", diagnosticKind(error));
      }
      try {
        if (!factory) throw new Error("Knowledge root is not configured.");
        await factory.initialize();
        factory.startWatching();
      } catch (error) {
        factoryInitializationError = `Self-media factory initialization failed (${diagnosticKind(error)}).`;
        console.error("JiMu self-media factory initialization failed:", diagnosticKind(error));
      }

      const unsubscribe = service?.subscribe((snapshot) => {
        const payload = `data: ${JSON.stringify({ indexedAt: snapshot.indexedAt, stats: snapshot.stats })}\n\n`;
        for (const response of eventClients) response.write(payload);
      }) ?? (() => {});
      const unsubscribeFactory = factory?.subscribe((snapshot) => {
        const payload = `data: ${JSON.stringify({ generatedAt: snapshot.generatedAt, counts: snapshot.counts })}\n\n`;
        for (const response of factoryEventClients) response.write(payload);
      }) ?? (() => {});

      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname === "/_jimu/knowledge-events") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          response.write(`data: ${JSON.stringify({ indexedAt: service?.snapshot?.indexedAt ?? null })}\n\n`);
          eventClients.add(response);
          request.on("close", () => eventClients.delete(response));
          return;
        }
        if (pathname === "/_jimu/factory-events") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          response.write(`data: ${JSON.stringify({ generatedAt: factory?.snapshot?.generatedAt ?? null })}\n\n`);
          factoryEventClients.add(response);
          request.on("close", () => factoryEventClients.delete(response));
          return;
        }
        if (pathname === "/_jimu/knowledge-index") {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          if (initializationError || !service?.snapshot) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: initializationError ?? "Knowledge index is unavailable." }));
            return;
          }
          response.end(JSON.stringify(service.getClientSnapshot()));
          return;
        }
        if (pathname === "/_jimu/factory-index") {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          if (factoryInitializationError || !factory?.snapshot) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: factoryInitializationError ?? "Self-media factory is unavailable." }));
            return;
          }
          response.end(JSON.stringify(factory.getSnapshot()));
          return;
        }
        if (pathname.startsWith("/_jimu/knowledge-asset/") && request.method === "GET") {
          const token = pathname.slice("/_jimu/knowledge-asset/".length);
          if (!service) {
            response.statusCode = 404;
            response.end("Knowledge root is not configured.");
            return;
          }
          void service.resolveAssetToken(token).then(async (absolutePath) => {
            response.setHeader("Content-Type", ASSET_TYPES.get(path.extname(absolutePath).toLocaleLowerCase()) ?? "application/octet-stream");
            response.setHeader("Cache-Control", "no-store");
            response.end(await readFile(absolutePath));
          }).catch((error) => {
            response.statusCode = 403;
            response.end(`Asset request failed (${diagnosticKind(error)}).`);
          });
          return;
        }
        const operations = new Map();
        if (service) {
          operations.set("/_jimu/knowledge-search", (payload) => service.search(payload));
          operations.set("/_jimu/knowledge-read", (payload) => service.readDocument(payload));
          operations.set("/_jimu/knowledge-resolve", (payload) => service.resolveLink(payload));
          operations.set("/_jimu/knowledge-graph", (payload) => service.getGraph(payload));
        }
        if (factory) {
          operations.set("/_jimu/factory-assets", (payload) => factory.listAssets(payload));
          operations.set("/_jimu/factory-create-inspiration", (payload) => factory.createInspiration(payload));
          operations.set("/_jimu/factory-promote-topic", (payload) => factory.promoteTopic(payload));
          operations.set("/_jimu/factory-save-content", (payload) => factory.saveContentRevision(payload));
          operations.set("/_jimu/factory-read-content", (payload) => factory.readContent(payload));
          operations.set("/_jimu/factory-approve-script", (payload) => factory.approveScript(payload));
          operations.set("/_jimu/factory-link-agent", (payload) => factory.linkAgentSession(payload));
          operations.set("/_jimu/factory-save-publication", (payload) => factory.savePublication(payload));
          operations.set("/_jimu/factory-add-metrics", (payload) => factory.addMetricSnapshot(payload));
          operations.set("/_jimu/factory-import-csv", (payload) => factory.importMetricsCsv(payload));
        }
        if (pathname === "/_jimu/project-files" && request.method === "POST") {
          void readJsonBody(request).then(() => {
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify({ files: [] }));
          }).catch((error) => {
            response.statusCode = 403;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: `Project request failed (${diagnosticKind(error)}).` }));
          });
          return;
        }
        const operation = operations.get(pathname);
        if (operation && request.method === "POST") {
          void readJsonBody(request).then(operation).then((payload) => {
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify(payload));
          }).catch((error) => {
            response.statusCode = 400;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: `JiMu request failed (${diagnosticKind(error)}).` }));
          });
          return;
        }
        next();
      });

      server.httpServer?.once("close", () => {
        unsubscribe();
        unsubscribeFactory();
        service?.close();
        factory?.close();
        for (const response of eventClients) response.end();
        for (const response of factoryEventClients) response.end();
        eventClients.clear();
        factoryEventClients.clear();
      });
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [jimuKnowledgeIndex(), react()],
});
