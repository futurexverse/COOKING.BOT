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
import { authenticateRequest } from "./auth/users.js";

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

app.get("/trade", async (_request, reply) => {
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
  const { processApproval, getProposalById } = await import("./social/approval.js");
  const result = await processApproval(body);

  let proposalData: unknown = null;
  if (result.success) {
    const entry = getProposalById(id);
    if (entry) {
      proposalData = {
        decision_id: entry.decision_id,
        proposal: entry.proposal,
        status: entry.status,
        deploy_url: "https://www.ponsfamily.com/launchpad",
        dexscreener_url: `https://dexscreener.com/${((entry.proposal as Record<string, unknown>)?.signal ? ((entry.proposal as Record<string, unknown>).signal as Record<string, unknown>).chain : "") || "robinhood"}/${(entry.proposal as Record<string, unknown>)?.signal ? ((entry.proposal as Record<string, unknown>).signal as Record<string, unknown>).mint : ""}`,
      };
    }
  }

  return reply.code(200).send({ ...result, deploy: proposalData });
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

app.get("/api/narrative", async () => {
  const { getCurrentNarrative, refreshNarratives } = await import("./market/narrative.js");
  let narrative = getCurrentNarrative();
  if (!narrative) {
    narrative = await refreshNarratives();
  }
  return narrative;
});

app.get("/api/narrative/refresh", async (_request, reply) => {
  const { refreshNarratives } = await import("./market/narrative.js");
  const narrative = await refreshNarratives();
  return reply.code(200).send(narrative);
});

app.get("/api/wallet", async () => {
  const { getWalletAddress, getBalance } = await import("./wallet/wallet.js");
  const address = getWalletAddress();
  const balance = await getBalance();
  return { address, balance: balance.eth, balanceWei: balance.wei.toString() };
});

app.post("/api/auth/signup", async (request, reply) => {
  const { email, password } = request.body as { email?: string; password?: string };
  if (!email || !password) {
    return reply.code(400).send({ error: "Email and password required" });
  }
  const { signup } = await import("./auth/users.js");
  const result = await signup(email, password);
  if (!result.success) {
    return reply.code(400).send({ error: result.error });
  }
  return { token: result.token };
});

app.post("/api/auth/login", async (request, reply) => {
  const { email, password } = request.body as { email?: string; password?: string };
  if (!email || !password) {
    return reply.code(400).send({ error: "Email and password required" });
  }
  const { login } = await import("./auth/users.js");
  const result = await login(email, password);
  if (!result.success) {
    return reply.code(401).send({ error: result.error });
  }
  return { token: result.token };
});

app.get("/api/auth/me", async (request, reply) => {
  const email = authenticateRequest(request.headers.authorization);
  if (!email) {
    return reply.code(401).send({ error: "Not authenticated" });
  }
  const { getUser } = await import("./auth/users.js");
  const { getBalance: getEthBalance, getWalletAddress: getAddr } = await import("./wallet/wallet.js");
  const user = getUser(email);
  if (!user) {
    return reply.code(404).send({ error: "User not found" });
  }
  const walletAddress = getAddr();
  const walletBalance = await getEthBalance();
  return {
    email: user.email,
    depositedEth: user.depositedEth,
    tradeCount: user.tradeHistory.length,
    createdAt: user.createdAt,
    walletAddress,
    walletBalance: walletBalance.eth,
  };
});

app.post("/api/auth/deposit", async (request, reply) => {
  const email = authenticateRequest(request.headers.authorization);
  if (!email) {
    return reply.code(401).send({ error: "Not authenticated" });
  }
  const { amountEth } = request.body as { amountEth?: number };
  if (!amountEth || amountEth <= 0) {
    return reply.code(400).send({ error: "Positive amountEth required" });
  }
  const { recordDeposit, getUser } = await import("./auth/users.js");
  const ok = recordDeposit(email, amountEth);
  if (!ok) {
    return reply.code(404).send({ error: "User not found" });
  }
  const user = getUser(email);
  const { sendDepositEmail } = await import("./services/email.js");
  const { getWalletAddress } = await import("./wallet/wallet.js");
  sendDepositEmail(email, getWalletAddress(), amountEth, user?.depositedEth || 0).catch(() => {});
  return { success: true, depositedEth: user?.depositedEth || 0 };
});

app.get("/api/token/lookup/:address", async (request, reply) => {
  const { address } = request.params as { address: string };
  if (!address) return reply.code(400).send({ error: "Address required" });
  const { lookupTokenByAddress } = await import("./market/sources/uniswap.js");
  const token = await lookupTokenByAddress(address);
  if (!token) return reply.code(404).send({ error: "Token not found" });
  return token;
});

app.get("/api/watchlist", async (request, reply) => {
  const email = authenticateRequest(request.headers.authorization);
  if (!email) return reply.code(401).send({ error: "Not authenticated" });
  const { getWatchlist } = await import("./watchlist/watchlist.js");
  return getWatchlist(email);
});

app.post("/api/watchlist", async (request, reply) => {
  const email = authenticateRequest(request.headers.authorization);
  if (!email) return reply.code(401).send({ error: "Not authenticated" });
  const body = request.body as { address?: string; chain?: string; symbol?: string; name?: string };
  if (!body.address || !body.chain || !body.symbol) {
    return reply.code(400).send({ error: "address, chain, symbol required" });
  }
  const { addToWatchlist } = await import("./watchlist/watchlist.js");
  const added = addToWatchlist(email, body.address, body.chain, body.symbol, body.name || body.symbol);
  return { success: added, message: added ? "Added to watchlist" : "Already in watchlist" };
});

app.delete("/api/watchlist/:address", async (request, reply) => {
  const email = authenticateRequest(request.headers.authorization);
  if (!email) return reply.code(401).send({ error: "Not authenticated" });
  const { address } = request.params as { address: string };
  const { removeFromWatchlist } = await import("./watchlist/watchlist.js");
  const removed = removeFromWatchlist(email, address);
  return { success: removed };
});

app.get("/api/wallet/trades", async (request) => {
  const email = authenticateRequest(request.headers.authorization);
  if (email) {
    const { getUserTradeHistory } = await import("./auth/users.js");
    return getUserTradeHistory(email);
  }
  const { getTradeHistory } = await import("./launch/launcher.js");
  return getTradeHistory();
});

app.post("/api/wallet/buy", async (request, reply) => {
  const body = request.body as { tokenAddress?: string; ethAmount?: string };
  if (!body.tokenAddress || !body.ethAmount) {
    return reply.code(400).send({ error: "tokenAddress and ethAmount required" });
  }
  const { buyToken } = await import("./trading/buy.js");
  const result = await buyToken(body.tokenAddress, body.ethAmount);

  const email = authenticateRequest(request.headers.authorization);
  if (email && result.success) {
    const { addTradeToUser } = await import("./auth/users.js");
    addTradeToUser(email, {
      txHash: result.txHash || "",
      type: "buy",
      tokenAddress: body.tokenAddress,
      amountIn: body.ethAmount,
      amountOut: result.amountOut || "0",
      ethSpent: body.ethAmount,
      timestamp: Date.now(),
      status: "success",
    });
  }

  return result;
});

app.post("/api/wallet/sell", async (request, reply) => {
  const body = request.body as { tokenAddress?: string; percentage?: number };
  if (!body.tokenAddress) {
    return reply.code(400).send({ error: "tokenAddress required" });
  }
  const { sellToken } = await import("./trading/sell.js");
  const result = await sellToken(body.tokenAddress, body.percentage || 100);

  const email = authenticateRequest(request.headers.authorization);
  if (email && result.success) {
    const { addTradeToUser } = await import("./auth/users.js");
    addTradeToUser(email, {
      txHash: result.txHash || "",
      type: "sell",
      tokenAddress: body.tokenAddress,
      amountIn: result.amountIn || "0",
      amountOut: result.amountOut || "0",
      ethReceived: result.amountOut || "0",
      timestamp: Date.now(),
      status: "success",
    });
  }

  return result;
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

app.get("/api/deploy/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { getProposalById } = await import("./social/approval.js");
  const entry = getProposalById(id);
  if (!entry) return reply.code(404).send({ error: "Proposal not found" });

  const prop = entry.proposal as Record<string, unknown>;
  const signal = prop?.signal as Record<string, unknown> | undefined;
  const symbol = (prop?.symbol as string) || (signal?.symbol as string) || "?";
  const name = (prop?.name as string) || (signal?.name as string) || symbol;
  const mint = (signal?.mint as string) || "";
  const chain = (signal?.chain as string) || "robinhood";
  const confidence = ((prop?.confidence as number) || 0) * 100;
  const platform = (prop?.platform as string) || "pons";
  const reasoning = (prop?.reasoning as string) || "";
  const score = (signal?.score as number) || 0;
  const volume = (signal?.volume_24h as number) || 0;
  const liquidity = (signal?.liquidity as number) || 0;
  const holders = (signal?.holders as number) || 0;

  return {
    decision_id: entry.decision_id,
    status: entry.status,
    created_at: entry.created_at,
    symbol,
    name,
    mint,
    confidence,
    platform,
    reasoning,
    score,
    volume,
    liquidity,
    holders,
    pons_url: "https://www.ponsfamily.com/launchpad",
    dexscreener_url: mint ? `https://dexscreener.com/${chain}/${mint}` : "",
    explorer_url: mint ? `https://robinhoodchain.blockscout.com/address/${mint}` : "",
  };
});

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const SCAN_INTERVAL = parseInt(process.env.ORACLE_SCAN_INTERVAL_SECONDS || "300", 10) * 1000;

async function runScanAndPropose(): Promise<void> {
  try {
    const { analyzeMarket, getMarketHeat } = await import("./market/analyzer.js");
    const { ScanRequestSchema } = await import("./schemas/index.js");
    const { evaluateLaunchConditions } = await import("./launch/criteria.js");

    const emptyScan = ScanRequestSchema.parse({ solana_trending: [] });
    const result = await analyzeMarket(emptyScan);

    console.log(`[Server] Scan: ${result.candidates_scored} candidates | should_post=${result.should_post} | anchor=${result.anchor || "NONE"}`);

    if (result.should_post && result.signal) {
      const sig = result.signal;
      const heat = getMarketHeat();

      console.log(`[Server] Actionable signal: $${sig.symbol} score=${sig.score.toFixed(3)} vol=$${sig.volume_24h}`);

      try {
        const proposal = await evaluateLaunchConditions({
          signal: sig,
          market_heat: heat,
        });

        if (proposal.decision_id === "skip" || proposal.decision_id === "cooldown") {
          console.log(`[Server] Skipped $${proposal.symbol}: ${proposal.reasoning}`);
        } else {
          console.log(`[Server] Proposal: $${proposal.symbol} | confidence=${(proposal.confidence * 100).toFixed(0)}% | status=${proposal.status}`);

          if (proposal.status === "pending") {
            console.log(`[Server] Proposal sent to Telegram — awaiting approval (ID: ${proposal.decision_id})`);
          }
        }
      } catch (err) {
        console.error("[Server] Launch evaluation failed:", err);
      }
    }
  } catch (err) {
    console.error("[Server] Scan cycle error:", err);
  }
}

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Cooking running on http://${HOST}:${PORT}`);
  startTelegramBot();

  console.log(`[Server] Running initial scan...`);
  runScanAndPropose().catch(() => {});

  setInterval(runScanAndPropose, SCAN_INTERVAL);
  console.log(`[Server] Auto-scan every ${SCAN_INTERVAL / 1000}s`);

  // Snipe scanner: every 20 minutes
  const SNIPE_INTERVAL = parseInt(process.env.SNIPE_SCAN_INTERVAL_MS || "1200000");
  const { runSnipeScanAndAlert } = await import("./market/snipe-scanner.js");
  setTimeout(() => {
    runSnipeScanAndAlert().catch(() => {});
    setInterval(runSnipeScanAndAlert, SNIPE_INTERVAL);
    console.log(`[Server] Snipe scanner every ${SNIPE_INTERVAL / 1000}s`);
  }, 30000); // First scan after 30 seconds

} catch (err) {
  app.log.error(err);
  process.exit(1);
}
