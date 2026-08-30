import Fastify from "fastify";
import { config } from "dotenv";
import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "url";
import {
  ScanRequestSchema,
  ApprovalRequestSchema,
} from "./schemas/index.js";
import { analyzeMarket } from "./market/analyzer.js";
import { startTelegramBot } from "./social/telegram-bot.js";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const app = Fastify({ logger: true });

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

app.get("/", async (_request, reply) => {
  const html = readFileSync(join(ROOT_DIR, "index.html"), "utf-8");
  return reply.type("text/html").send(html);
});

app.get("/health", async () => {
  return { status: "ok", service: "cooking", timestamp: Date.now() };
});

app.get("/assets/*", async (request, reply) => {
  const urlPath = request.url.split("?")[0].replace(/^\/assets\//, "");
  const filePath = join(ROOT_DIR, decodeURIComponent(urlPath));
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return reply.code(404).send({ error: "Not found" });
  }
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return reply.code(404).send({ error: "Unsupported file type" });
  const data = readFileSync(filePath);
  return reply.type(mime).send(data);
});

app.post("/api/scan", async (request, reply) => {
  const body = ScanRequestSchema.parse(request.body);
  const result = await analyzeMarket(body);
  return reply.code(200).send(result);
});

app.post("/api/launch/propose", async (request, reply) => {
  const { evaluateLaunchConditions } = await import(
    "./launch/criteria.js"
  );
  const body = request.body as Parameters<typeof evaluateLaunchConditions>[0];
  const proposal = await evaluateLaunchConditions(body);
  return reply.code(200).send(proposal);
});

app.post("/api/approve/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = ApprovalRequestSchema.parse({
    ...(request.body as Record<string, unknown>),
    decision_id: id,
  });
  const { processApproval } = await import("./social/approval.js");
  const result = await processApproval(body);
  return reply.code(200).send(result);
});

app.post("/api/launch/execute", async (request, reply) => {
  const { executeLaunch } = await import("./launch/launcher.js");
  const proposal = request.body as Parameters<typeof executeLaunch>[0];
  const result = await executeLaunch(proposal);
  return reply.code(200).send(result);
});

app.get("/api/launches", async () => {
  const { getActiveLaunches } = await import("./launch/launcher.js");
  return getActiveLaunches();
});

app.get("/api/guardian/:mint", async (request, reply) => {
  const { mint } = request.params as { mint: string };
  const { getGuardianStatus } = await import("./guardian/monitor.js");
  const status = await getGuardianStatus(mint);
  if (!status) return reply.code(404).send({ error: "Guardian not found" });
  return status;
});

app.get("/api/dashboard", async () => {
  const { getDashboardData } = await import("./market/analyzer.js");
  return getDashboardData();
});

app.get("/api/config", async () => {
  try {
    const configRaw = readFileSync(
      join(ROOT_DIR, "src/config/thresholds.json"),
      "utf-8"
    );
    return JSON.parse(configRaw);
  } catch {
    return { error: "Config not found" };
  }
});

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Cooking running on http://${HOST}:${PORT}`);
  startTelegramBot();

  const { analyzeMarket } = await import("./market/analyzer.js");
  const { ScanRequestSchema } = await import("./schemas/index.js");
  const emptyScan = ScanRequestSchema.parse({ solana_trending: [] });
  analyzeMarket(emptyScan).catch(() => {});
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
