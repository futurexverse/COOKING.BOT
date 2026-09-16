import { processApproval, getPendingProposals } from "./approval.js";
import { appendToVariable, isRailwayPersistAvailable } from "./railway-persist.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const GROUP_IDS_FILE = join(ROOT_DIR, "data", "group_ids.json");
const USER_IDS_FILE = join(ROOT_DIR, "data", "user_ids.json");

let lastUpdateId = 0;
let polling = false;

const pendingActions = new Map<string, { type: "buy" | "sell"; tokenAddress: string; chain?: string }>();
const pendingSettings = new Map<string, string>();

let wlCounter = 0;
const pendingWatchlist = new Map<number, { address: string; chain: string; symbol: string; name: string }>();

function makeWlCb(address: string, chain: string, symbol: string, name: string): string {
  const id = wlCounter++;
  pendingWatchlist.set(id, { address, chain, symbol, name });
  if (pendingWatchlist.size > 200) {
    const oldest = pendingWatchlist.keys().next().value!;
    pendingWatchlist.delete(oldest);
  }
  return `wl:${id}`;
}

function getBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function getChatIds(): string[] {
  return (process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getApi(): string {
  return `https://api.telegram.org/bot${getBotToken()}`;
}

function loadGroupIds(): string[] {
  try {
    if (existsSync(GROUP_IDS_FILE)) {
      return JSON.parse(readFileSync(GROUP_IDS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveGroupIds(ids: string[]): void {
  const dir = dirname(GROUP_IDS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GROUP_IDS_FILE, JSON.stringify(ids, null, 2));
}

function loadUserIds(): string[] {
  try {
    if (existsSync(USER_IDS_FILE)) {
      return JSON.parse(readFileSync(USER_IDS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveUserIds(ids: string[]): void {
  const dir = dirname(USER_IDS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(USER_IDS_FILE, JSON.stringify(ids, null, 2));
}

export function addUserId(id: string): void {
  const ids = loadUserIds();
  if (!ids.includes(id)) {
    ids.push(id);
    saveUserIds(ids);
    console.log(`[Telegram] Registered user: ${id}`);

    if (isRailwayPersistAvailable()) {
      appendToVariable("REGISTERED_USER_IDS", id).catch(() => {});
    }
  }
}

function addGroupId(id: string): void {
  const ids = loadGroupIds();
  if (!ids.includes(id)) {
    ids.push(id);
    saveGroupIds(ids);
    console.log(`[Telegram] Added group/channel: ${id}`);
  }
}

function removeGroupId(id: string): void {
  const ids = loadGroupIds().filter((i) => i !== id);
  saveGroupIds(ids);
  console.log(`[Telegram] Removed group/channel: ${id}`);
}

export function getAllChatIds(): string[] {
  const envIds = getChatIds();
  const groupIds = loadGroupIds();
  const userIds = loadUserIds();

  const persistedIds = (process.env.REGISTERED_USER_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const combined = new Set([...envIds, ...groupIds, ...userIds, ...persistedIds]);
  return Array.from(combined);
}

async function sendMessage(
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  try {
    let resp = await fetch(`${getApi()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    const result = (await resp.json()) as { ok: boolean; description?: string; error_code?: number };
    if (!result.ok) {
      console.error(`[Telegram] sendMessage error to ${chatId}:`, result.description);
      if (result.description?.includes("parse")) {
        resp = await fetch(`${getApi()}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            ...extra,
          }),
        });
      }
    }
  } catch (err) {
    console.error("[Telegram] Send failed:", err);
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await fetch(`${getApi()}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    console.error("[Telegram] Answer callback failed:", err);
  }
}

async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  inlineKeyboard?: unknown[][]
): Promise<void> {
  try {
    await fetch(`${getApi()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        inline_keyboard: inlineKeyboard || [],
      }),
    });
  } catch (err) {
    console.error("[Telegram] Edit markup failed:", err);
  }
}

async function getBotInfo(): Promise<{ id: number; username: string } | null> {
  try {
    const resp = await fetch(`${getApi()}/getMe`);
    const data = (await resp.json()) as { ok: boolean; result: { id: number; username: string } };
    if (data.ok) return data.result;
  } catch {}
  return null;
}

async function handleGreet(): Promise<string> {
  let walletAddress = "Loading...";
  let walletBalance = "0.0000";
  try {
    const { getWalletAddress, getBalance } = await import("../wallet/wallet.js");
    walletAddress = getWalletAddress();
    const bal = await getBalance();
    walletBalance = parseFloat(bal.eth).toFixed(4);
  } catch {}

  return [
    `<b>Hey! Welcome to COOKING.</b>`,
    ``,
    `I'm your autonomous token sniper for Robinhood Chain + Solana. I scan trending tokens across both chains, score them with AI, propose launches via PONS, trade on Uniswap V3 and Jupiter, and guard your positions — all on autopilot.`,
    ``,
    `<b>Dashboard:</b> https://cookingbot-production-bcf3.up.railway.app`,
    ``,
    `<b>💰 WALLET — Deposit ETH Here:</b>`,
    `<code>${walletAddress}</code>`,
    `<b>Balance:</b> ${walletBalance} ETH`,
    `<a href="https://robinhoodchain.blockscout.com/address/${walletAddress}">View on Blockscout</a>`,
    ``,
    `<b>🧠 NARRATIVE INTELLIGENCE:</b>`,
    `AI scans Robinhood Chain + Solana every 30 min for trending tokens ($10K-$500K MC)`,
    `Groups tokens by narrative (AI, memes, DeFi, etc.) with scores`,
    `Alerts you with Buy/Sell/Watch buttons for each token`,
    ``,
    `<b>⚡ AUTO SNIPE:</b>`,
    `Set your own custom parameters (MC, volume, liquidity, holders, etc.)`,
    `Get instant alerts when tokens match — no waiting for scheduled scans`,
    `Use /autosnipe to configure and toggle ON/OFF`,
    ``,
    `<b>🚀 LP MIGRATION SNIPER:</b>`,
    `Detects every Pump.fun token that migrates to Raydium`,
    `Early entry before the crowd — alerts you instantly with Buy buttons`,
    ``,
    `<b>🔍 TOKEN LOOKUP:</b>`,
    `Paste any contract address in this chat — bot auto-detects chain and shows all token info`,
    ``,
    `<b>📊 HOW TRADING WORKS:</b>`,
    `<b>Buy:</b> Tap the Buy button on any alert, or use /buy &lt;token&gt; &lt;eth&gt;`,
    `<b>Sell:</b> Use /sell &lt;token&gt; [pct], or tap the sell button on guardian alerts`,
    `<b>Execution:</b> Robinhood Chain trades run on Uniswap V3. Solana trades run on Jupiter`,
    `<b>Approval:</b> Every trade requires your confirmation — nothing happens without your tap`,
    ``,
    `<b>🛡️ GUARDIAN / STOP-LOSS:</b>`,
    `After you buy a token, guardian monitors it 24/7:`,
    `<b>Stop-loss:</b> Price drops -30% → sell button sent to you → you confirm`,
    `<b>Take-profit:</b> Price pumps +100% → sell button sent to you → you confirm`,
    `<b>Trailing stop:</b> Price peaks then drops -15% from peak → sell button sent → you confirm`,
    `<b>Emergency:</b> Price crashes -50% or more → auto-sells instantly (no confirmation needed)`,
    `<i>Only emergency sells execute without your approval.</i>`,
    ``,
    `<b>📋 COMMANDS:</b>`,
    `/autosnipe - Auto Snipe settings & toggle`,
    `/narrative - AI narrative detection`,
    `/buy - Buy a token`,
    `/sell - Sell a token`,
    `/trades - View trade history`,
    `/bal - Check wallet balance`,
    `/positions - Guardian positions`,
    `/watchlist - Your watchlist`,
    `/proposals - View pending launches`,
    `/status - System status`,
    `/help - All commands`,
    ``,
    `<i>Just paste any contract address here to look up a token.</i>`,
  ].join("\n");
}

const QA: Record<string, string> = {
  group_welcome: `<b>COOKING Bot added to this group!</b>\n\nI'll post token launch proposals, auto-snipe alerts, and market alerts here.\n\n<b>Commands you can use:</b>\n/status - System status\n/proposals - View pending launches\n/autosnipe - Auto Snipe settings\n/help - All commands`,

  what: `<b>What is COOKING?</b>\n\nCOOKING is an autonomous token sniper for Robinhood Chain + Solana. It scans Dexscreener, Birdeye, PumpFun, and Raydium for trending tokens, scores them with AI narrative detection, proposes launches via PONS, trades via Uniswap V3 and Jupiter, and monitors positions 24/7 for rugs and price moves.\n\n<b>Features:</b>\n• Narrative Intelligence — AI groups tokens by trending themes with scores\n• Auto Snipe — Custom parameters, instant alerts when tokens match\n• LP Migration Sniper — Catches every Pump.fun → Raydium migration\n• Token Lookup — Paste any CA to see full token info\n• Watchlist — Track tokens you're interested in\n• Guardian — 24/7 position monitoring with stop-loss/take-profit`,

  how: `<b>How does COOKING work?</b>\n\n1. <b>Scan</b> - Fetches trending tokens from Dexscreener, Birdeye, PumpFun, and Raydium across Robinhood Chain + Solana\n2. <b>Score</b> - 6-factor weighted algorithm rates volume, liquidity, momentum, holders, safety + AI narrative boost\n3. <b>Launch</b> - AI proposes a launch when confidence hits 75%+. You approve, it deploys via PONS with locked liquidity\n4. <b>Trade</b> - Buy any token on Robinhood Chain via Uniswap V3 or Solana via Jupiter. All trades require your confirmation\n5. <b>Auto Snipe</b> - Set custom parameters (MC, volume, liquidity, holders). Get instant alerts when tokens match\n6. <b>LP Migration Sniper</b> - Detects every Pump.fun token that migrates to Raydium. Early entry before the crowd\n7. <b>Narrative Intelligence</b> - AI groups trending tokens by narrative with scores and Buy/Sell/Watch buttons\n8. <b>Guard</b> - Monitors your positions 24/7 for rugs, price crashes, stop-loss and take-profit triggers`,

  score: `<b>How COOKING Scores Tokens</b>\n\nCOOKING uses a 6-factor weighted algorithm plus AI narrative detection.\n\n<b>The 6 Factors:</b>\n1. Volume Spike (25%)\n2. Liquidity Depth (20%)\n3. 24-Hour Momentum (20%)\n4. 1-Hour Momentum (15%)\n5. Holder Growth (10%)\n6. Safety Score (10%)\n\n<b>Narrative Boost:</b> AI adds up to +15% for hot themes.\n\n<b>Score Ranges:</b>\n- 70%+ = Actionable\n- 45-69% = Watchlist\n- Below 45% = Noise`,

  launch: `<b>Token Launching</b>\n\nWhen a token scores 70%+ and conditions are right:\n- AI evaluates market heat, confidence, and narrative alignment\n- Must hit 75%+ confidence to propose\n- You approve via Telegram buttons\n- Deploys via PONS (~0.01 ETH)\n- Liquidity is auto-locked — rug-proof from day one\n- Bot asks if you want to buy + start guardian monitoring`,

  guardian: `<b>Guardian System</b>\n\nPost-launch monitoring on Robinhood Chain:\n- Rug detection (contract owner, mint authority, supply concentration)\n- Price alerts (20%+ surges or dumps)\n- Holder milestones (100, 500, 1K, 5K, 10K)\n- Stop-loss (-30%) and take-profit (+100%)\n- Emergency auto-sell on >50% drop\n- All sells require your confirmation\n- Telegram alerts in real-time`,

  narrative: `<b>AI Narrative Detection</b>\n\nCOOKING uses AI to identify trending themes across all chains.\n\n- Scans trending tokens from Dexscreener\n- AI analyzes token clusters to identify hot narratives\n- Detects meme trends, sector rotations, and hype cycles\n\nTokens matching hot narratives get a score boost (up to +15%).`,

  cost: `<b>Costs</b>\n\n- PONS launch: ~0.01 ETH (gas only)\n- Trading: gas only (Uniswap V3 swap)\n- Guardian monitoring: free\n- Narrative detection: free\n- No platform fees — you only pay Robinhood Chain gas costs\n- Sub-cent transaction fees`,

  wallet: `<b>Wallet</b>\n\nCOOKING auto-generates a wallet on first start.\n\nTo fund it:\n1. Go to the dashboard → Wallet section\n2. Copy the wallet address\n3. Send ETH on Robinhood Chain to that address\n\nThe wallet is saved in data/wallet.json and persists across redeploys.`,

  approve: `<b>Approving a Launch</b>\n\nWhen a new proposal comes in:\n- Tap the Approve or Reject button\n- Or send /approve &lt;decision_id&gt;\n- Approval window: 5 minutes`,

  heat: `<b>Market Heat</b>\n\nA gauge of overall market activity on Robinhood Chain:\n- Number of candidate tokens found on Uniswap\n- Top scores among candidates\n- Scale: Cold (0-20%) -> Cool -> Warm -> Hot (70%+)\n\nHigher heat = more opportunity`,

  chain: `<b>Robinhood Chain</b>\n\n- Ethereum L2 built on Arbitrum\n- ~100ms block times, sub-cent gas fees\n- Uniswap V2/V3/V4 for trading\n- PONS for token launches with locked LP\n- Blockscout for analytics and safety\n- Chain ID 4663`,

  snipe: `<b>Auto Snipe</b>\n\nSet your custom parameters and get instant alerts when tokens match.\n\nUse /snipe to configure:\n- Market cap range ($10K-$500K default)\n- Min volume (5m)\n- Min liquidity\n- Min holders\n- Min buy pressure\n- Min momentum (5m)\n- Chains (Robinhood + Solana)\n\nTokens matching your settings are alerted instantly — no waiting for scheduled scans.\n\n<b>LP Migration Sniper</b> also runs automatically, catching every Pump.fun → Raydium migration.`,

  trading: `<b>How Trading Works</b>\n\n<b>Buying:</b>\n1. Receive a snipe or proposal alert with buy buttons\n2. Tap the ETH amount you want to spend (0.001 / 0.005 / 0.01)\n3. Confirm the trade\n4. Trade executes on Uniswap V3 on Robinhood Chain\n5. Tokens land in your COOKING wallet\n\nOr use: /buy &lt;token_address&gt; &lt;eth_amount&gt;\n\n<b>Selling:</b>\n1. Use /sell &lt;token_address&gt; [percentage]\n2. Or tap the sell button when guardian sends an alert\n3. Confirm the trade\n4. ETH returns to your COOKING wallet\n\n<b>Guardian sells (automatic alerts):</b>\n- Stop-loss (-30%): sell button sent → you confirm\n- Take-profit (+100%): sell button sent → you confirm\n- Trailing stop (-15% from peak): sell button sent → you confirm\n- Emergency (-50%+ drop): auto-sells instantly, no confirmation\n\n<b>All trades require your approval</b> — nothing executes without your tap (except emergency).`,

  help: `<b>COOKING Commands</b>\n\n<b>Info:</b>\n/start - Welcome message\n/status - System status\n/config - Current thresholds\n/help - This message\n\n<b>Launches:</b>\n/proposals - View pending launches\n/approve ID - Approve a launch\n/reject ID - Reject a launch\n\n<b>Trading:</b>\n/buy TOKEN ETH - Buy a token\n/sell TOKEN PCT - Sell a token\n/trades - View trade history\n/bal - Check wallet balance\n/bal TOKEN - Check token balance\n/positions - Guardian positions\n\n<b>Discovery:</b>\n/autosnipe - Auto Snipe settings & toggle\n/narrative - AI narrative detection\n/heat - Market heat explained\n\n<b>Info:</b>\n/scoring - How scoring works\n/launch - How launching works\n/guardian - What guardian monitors\n/costs - Launch costs\n/wallet - Wallet & funding info\n/chain - Robinhood Chain info`,
};

async function getUserEmailFromChat(chatId: number): Promise<string | null> {
  const { getUserByChatId } = await import("../auth/users.js");
  const user = getUserByChatId(chatId);
  return user?.email || null;
}

async function matchQuestion(text: string, chatId?: number): Promise<string | null> {
  const lower = text.toLowerCase().trim();

  if (lower === "/start" || lower === "/help") return await handleGreet();
  if (lower === "/status") return handleStatus();
  if (lower === "/proposals") return handleProposals();
  if (lower === "/scoring") return QA.score;
  if (lower === "/launch") return QA.launch;
  if (lower === "/guardian") return QA.guardian;
  if (lower === "/narrative") return QA.narrative;
  if (lower === "/config") return handleConfig();
  if (lower === "/costs" || lower === "/cost") return QA.cost;
  if (lower === "/wallet") return await handleWallet();
  if (lower === "/heat") return QA.heat;
  if (lower === "/snipe" || lower === "/autosnipe") return chatId ? await handleAutoSnipe(chatId) : "Available in private chat only.";
  if (lower === "/bal") return await handleBalance(null);
  if (lower === "/positions") return await handlePositions();
  if (lower === "/trades") return await handleTrades();

  if (lower === "/watchlist") return chatId ? await handleWatchlist(chatId) : "Available in private chat only.";
  if (lower.startsWith("/unwatch")) {
    const address = lower.replace("/unwatch", "").trim();
    return chatId ? await handleUnwatch(chatId, address) : "Available in private chat only.";
  }

  if (lower.startsWith("/buy ")) {
    const args = lower.replace("/buy ", "").trim().split(/\s+/);
    const token = args[0];
    const eth = args[1];
    if (!token || !eth) return `Usage: /buy &lt;token_address&gt; &lt;eth_amount&gt;\nExample: /buy 0x99A90B... 0.001`;
    return await handleBuyCommand(token, eth);
  }

  if (lower.startsWith("/sell ")) {
    const args = lower.replace("/sell ", "").trim().split(/\s+/);
    const token = args[0];
    const pct = args[1] || "100";
    if (!token) return `Usage: /sell &lt;token_address&gt; [percentage]\nExample: /sell 0x99A90B... 100`;
    return await handleSellCommand(token, pct);
  }

  if (lower.startsWith("/bal ")) {
    const token = lower.replace("/bal ", "").trim();
    return await handleBalance(token || null);
  }

  if (lower.startsWith("/approve ")) {
    const id = lower.replace("/approve ", "").trim();
    return await handleApproveCommand(id);
  }
  if (lower.startsWith("/reject ")) {
    const id = lower.replace("/reject ", "").trim();
    return await handleRejectCommand(id);
  }

  if (lower === "hi" || lower === "hey" || lower === "hello" || lower === "yo" || lower === "sup" || lower === "reetings")
    return await handleGreet();

  if (lower.includes("score") || lower.includes("scoring") || lower.includes("algorithm") || lower.includes("factor") || lower.includes("weighted") || lower.includes("rating") || lower.includes("decide") || lower.includes("determine") || lower.includes("how does it decide"))
    return QA.score;

  if (lower.includes("narrative") || lower.includes("theme") || lower.includes("trend") || lower.includes("gemini") || lower.includes("ai detect") || lower.includes("what's trending"))
    return QA.narrative;

  if (lower.includes("guard") || lower.includes("monitor") || lower.includes("rug") || lower.includes("scam") || lower.includes("protect") || lower.includes("stop loss") || lower.includes("take profit") || lower.includes("alert"))
    return QA.guardian;

  if (lower.includes("snipe") || lower.includes("opportunity") || lower.includes("sniping"))
    return QA.snipe;

  if (lower.includes("cost") || lower.includes("fee") || lower.includes("pay") || lower.includes("price") || lower.includes("how much") || lower.includes("expensive") || lower.includes("cheap") || lower.includes("eth"))
    return QA.cost;

  if (lower.includes("wallet") || lower.includes("address") || lower.includes("fund") || lower.includes("balance") || lower.includes("private key"))
    return QA.wallet;

  if (lower.includes("launch") || lower.includes("deploy") || lower.includes("create") || lower.includes("pump") || lower.includes("raydium"))
    return QA.launch;

  if (lower.includes("trade") || lower.includes("swap") || lower.includes("buy") || lower.includes("sell") || lower.includes("token"))
    return QA.trading;

  if (lower.includes("heat") || lower.includes("market") || lower.includes("trend") || lower.includes("bull") || lower.includes("bear") || lower.includes("hot") || lower.includes("cold"))
    return QA.heat;

  if (lower.includes("approv") || lower.includes("reject") || lower.includes("confirm") || lower.includes("permission") || lower.includes("sign"))
    return QA.approve;

  if (lower.includes("chain") || lower.includes("solana") || lower.includes("network") || lower.includes("blockchain") || lower.includes("support") || lower.includes("compatible"))
    return QA.chain;

  if (lower.includes("how") || lower.includes("work") || lower.includes("does") || lower.includes("operate") || lower.includes("function"))
    return QA.how;

  if (lower.includes("what") || lower.includes("about") || lower.includes("explain") || lower.includes("tell me") || lower.includes("describe"))
    return QA.what;

  if (lower.includes("who") || lower.includes("built") || lower.includes("made") || lower.includes("developer") || lower.includes("author"))
    return QA.what;

  return null;
}

async function handleAutoSnipe(chatId: number): Promise<string> {
  const { getAutoSnipeSettings } = await import("../market/autosnipe.js");
  const settings = getAutoSnipeSettings(chatId);

  const status = settings.enabled ? "ON" : "OFF";
  const statusEmoji = settings.enabled ? "🟢" : "🔴";
  const chains = settings.chains.join(", ");

  return [
    `${statusEmoji} <b>AUTO SNIPE</b>`,
    ``,
    `Status: <b>${status}</b>`,
    ``,
    `<b>Current Settings:</b>`,
    `MC: $${settings.minMarketCap.toLocaleString()} - $${settings.maxMarketCap.toLocaleString()}`,
    `Volume (5m): $${settings.minVolume5m.toLocaleString()}+`,
    `Liquidity: $${settings.minLiquidity.toLocaleString()}+`,
    `Holders: ${settings.minHolders}+`,
    `Buy Pressure: ${settings.minBuyPressure}%+`,
    `Momentum (5m): ${settings.minPriceChange5m}%+`,
    `Chains: ${chains}`,
    `Max Alerts: ${settings.maxAlertsPerCycle}/cycle`,
    ``,
    `<i>Tokens matching your parameters are alerted instantly.</i>`,
  ].join("\n");
}

function handleAutoSnipeKeyboard(chatId: number): { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
  const settings = getAutoSnipeSettingsSync(chatId);
  const toggleText = settings.enabled ? "Turn OFF" : "Turn ON";

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: toggleText, callback_data: "as_toggle" },
          { text: "Edit Settings", callback_data: "as_edit" },
        ],
      ],
    },
  };
}

function getAutoSnipeSettingsSync(chatId: number): { enabled: boolean; [key: string]: unknown } {
  const SETTINGS_FILE = join(ROOT_DIR, "data", "autosnipe.json");
  try {
    if (existsSync(SETTINGS_FILE)) {
      const all = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
      return all[String(chatId)] || { enabled: false };
    }
  } catch {}
  return { enabled: false };
}

function handleAutoSnipeEditKeyboard(): { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "MC Range", callback_data: "as_mc" }, { text: "Volume (5m)", callback_data: "as_vol" }],
        [{ text: "Liquidity", callback_data: "as_liq" }, { text: "Holders", callback_data: "as_holders" }],
        [{ text: "Buy Pressure", callback_data: "as_bp" }, { text: "Momentum", callback_data: "as_mom" }],
        [{ text: "Chains", callback_data: "as_chains" }, { text: "Max Alerts", callback_data: "as_max" }],
        [{ text: "Reset Defaults", callback_data: "as_reset" }],
        [{ text: "Done", callback_data: "as_done" }],
      ],
    },
  };
}

function handleStatus(): string {
  const proposals = getPendingProposals();
  const pending = proposals.filter((p) => p.status === "pending").length;
  const approved = proposals.filter((p) => p.status === "approved").length;
  const rejected = proposals.filter((p) => p.status === "rejected").length;
  const groups = loadGroupIds().length;

  return [
    `<b>COOKING System Status</b>`,
    ``,
    `Proposals: ${pending} pending | ${approved} approved | ${rejected} rejected`,
    `Bot: Online`,
    `Guardian: Active`,
    `Snipe Scanner: Every 20 min`,
    `Groups/Channels: ${groups}`,
    ``,
    `Send /proposals to see pending launches.`,
  ].join("\n");
}

function handleProposals(): string {
  const proposals = getPendingProposals();
  const pending = proposals.filter((p) => p.status === "pending");

  if (pending.length === 0) {
    return `No pending proposals.\n\nNew proposals will appear here with Approve/Reject buttons when the engine finds a strong signal.`;
  }

  const lines = [`<b>Pending Launch Proposals</b> (${pending.length})`, ``];
  for (const p of pending) {
    const prop = p.proposal as Record<string, unknown>;
    const signal = (prop.signal || {}) as Record<string, unknown>;
    const conf = ((prop.confidence as number) || 0) * 100;
    const symbol = (prop.symbol as string) || (signal.symbol as string) || "?";
    const platform = (prop.platform as string) || "pons";
    const cost = (prop.estimated_cost_eth as number) || 0.01;
    lines.push(
      `<b>$${symbol}</b> - ${conf.toFixed(0)}% confidence`,
      `Platform: ${platform} | Cost: ${cost} ETH`,
      `ID: <code>${p.decision_id}</code>`,
      ``
    );
  }
  lines.push(`Send /approve <id> or tap the buttons on the message.`);
  return lines.join("\n");
}

async function handleWallet(): Promise<string> {
  try {
    const { getWalletAddress, getBalance } = await import("../wallet/wallet.js");
    const address = getWalletAddress();
    const { eth } = await getBalance();
    const shortAddr = address.slice(0, 6) + '...' + address.slice(-4);
    return [
      `<b>Wallet</b>`,
      ``,
      `<b>Address:</b> <code>${address}</code>`,
      `<b>Balance:</b> ${parseFloat(eth).toFixed(4)} ETH`,
      ``,
      `<b>To fund:</b>`,
      `1. Copy the address above`,
      `2. Send ETH on Robinhood Chain to it`,
      `3. The bot uses it for launches and trading`,
      ``,
      `<a href="https://robinhoodchain.blockscout.com/address/${address}">View on Blockscout</a>`,
      `Dashboard: https://cookingbot-production-bcf3.up.railway.app`,
    ].join("\n");
  } catch (err) {
    return QA.wallet;
  }
}

async function handleBalance(tokenAddress: string | null): Promise<string> {
  try {
    const { getWalletAddress, getBalance } = await import("../wallet/wallet.js");
    const address = getWalletAddress();
    const { eth } = await getBalance();

    if (!tokenAddress) {
      return [
        `<b>Wallet Balance</b>`,
        ``,
        `<b>ETH:</b> ${parseFloat(eth).toFixed(6)} ETH`,
        `<b>Address:</b> <code>${address}</code>`,
      ].join("\n");
    }

    const { getTokenBalance } = await import("../trading/sell.js");
    const token = await getTokenBalance(tokenAddress);
    return [
      `<b>Token Balance</b>`,
      ``,
      `<b>${token.symbol}:</b> ${parseFloat(token.balance).toFixed(4)}`,
      `<b>Decimals:</b> ${token.decimals}`,
      `<b>Contract:</b> <code>${tokenAddress}</code>`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error checking balance: ${msg}`;
  }
}

async function handleTrades(): Promise<string> {
  try {
    const { getTradeHistory } = await import("../launch/launcher.js");
    const trades = getTradeHistory().slice(-10).reverse();

    if (trades.length === 0) {
      return `No trades yet.\n\nUse /buy to start trading.`;
    }

    const lines = [`<b>Recent Trades</b> (${trades.length})`, ``];
    for (const t of trades) {
      const emoji = t.type === "buy" ? "🟢" : "🔴";
      const symbol = t.tokenSymbol || t.tokenAddress.slice(0, 8);
      const amount = t.type === "buy" ? t.ethSpent : t.ethReceived;
      const time = new Date(t.timestamp).toLocaleString();
      lines.push(
        `${emoji} <b>${t.type.toUpperCase()}</b> ${symbol}`,
        `Amount: ${amount || "?"} ETH | ${t.status}`,
        `${time}`,
        ``
      );
    }
    return lines.join("\n");
  } catch (err) {
    return `Error loading trades.`;
  }
}

async function handlePositions(): Promise<string> {
  try {
    const { getAllPositions } = await import("../guardian/liquidity.js");
    const positions = getAllPositions();

    if (positions.length === 0) {
      return `No guardian positions.\n\nBuy a token and start monitoring to see positions here.`;
    }

    const lines = [`<b>Guardian Positions</b> (${positions.length})`, ``];
    for (const p of positions) {
      const pnl = ((0 - p.entry_price) / p.entry_price * 100).toFixed(1);
      const time = new Date(p.entry_timestamp).toLocaleString();
      lines.push(
        `<b>$${p.symbol}</b>`,
        `Entry: ${p.entry_price} ETH | SL: ${p.stop_loss_pct}% | TP: ${p.take_profit_pct}%`,
        `Since: ${time}`,
        ``
      );
    }
    return lines.join("\n");
  } catch (err) {
    return `Error loading positions.`;
  }
}

function handleConfig(): string {
  return [
    `<b>Current Thresholds</b>`,
    ``,
    `Execution Gate: 70%+`,
    `Watchlist Gate: 45%+`,
    `Launch Confidence: 75%+`,
    `Strategy: cooking_v1`,
    `Chain: Robinhood (4663)`,
    `DEX: Uniswap V3`,
    `Launch: PONS`,
    `Guardian: Active`,
    `Snipe Scanner: Every 20 min`,
    `Snipe Min Score: 70%+`,
    `Snipe Min Liquidity: $10K+`,
  ].join("\n");
}

async function handleApproveCommand(id: string): Promise<string> {
  if (!id) return `Usage: /approve &lt;decision_id&gt;`;
  const result = await processApproval({ decision_id: id, approved: true });
  if (result.success) {
    return `✅ <b>Approved</b> - ${result.message}`;
  }
  return `❌ ${result.message}`;
}

async function handleRejectCommand(id: string): Promise<string> {
  if (!id) return `Usage: /reject &lt;decision_id&gt;`;
  const result = await processApproval({ decision_id: id, approved: false });
  if (result.success) {
    return `❌ <b>Rejected</b> - ${result.message}`;
  }
  return `⚠️ ${result.message}`;
}

async function handleBuyCommand(tokenAddress: string, ethAmount: string): Promise<string> {
  try {
    const { ethers } = await import("ethers");
    const { getWalletAddress, getBalance } = await import("../wallet/wallet.js");
    const { getERC20Contract } = await import("../trading/router.js");

    const address = getWalletAddress();
    const { wei: balance } = await getBalance();
    const amountIn = ethers.parseEther(ethAmount);

    if (balance < amountIn + ethers.parseEther("0.001")) {
      return `❌ Insufficient ETH balance.\n\nYou have ${ethers.formatEther(balance)} ETH, need ${ethers.formatEther(amountIn + ethers.parseEther("0.001"))} ETH (trade + gas).`;
    }

    const wallet = await import("../wallet/wallet.js").then(m => m.getWallet());
    const tokenContract = getERC20Contract(tokenAddress, wallet);
    const symbol = await tokenContract.symbol();
    const decimals = await tokenContract.decimals();

    return [
      `<b>Buy ${symbol}</b>`,
      ``,
      `Token: <code>${tokenAddress}</code>`,
      `Amount: <b>${ethAmount} ETH</b>`,
      `You'll receive tokens at market price`,
      ``,
      `Tap to confirm:`,
    ].join("\n");
  } catch (err) {
    return `❌ Invalid token address or error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleSellCommand(tokenAddress: string, percentage: string): Promise<string> {
  try {
    const { getTokenBalance } = await import("../trading/sell.js");
    const token = await getTokenBalance(tokenAddress);

    if (parseFloat(token.balance) === 0) {
      return `❌ No ${token.symbol} balance to sell.`;
    }

    return [
      `<b>Sell ${token.symbol}</b>`,
      ``,
      `Token: <code>${tokenAddress}</code>`,
      `Your balance: ${parseFloat(token.balance).toFixed(4)} ${token.symbol}`,
      `Selling: ${percentage}%`,
      ``,
      `Tap to confirm:`,
    ].join("\n");
  } catch (err) {
    return `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const QUESTION_BUTTONS: Array<Array<{ text: string; callback_data: string }>> = [
  [{ text: "What is COOKING?", callback_data: "q:what" }],
  [{ text: "How does it work?", callback_data: "q:how" }],
  [{ text: "How does scoring work?", callback_data: "q:score" }],
  [{ text: "AI Narrative Detection", callback_data: "q:narrative" }],
  [{ text: "How does launching work?", callback_data: "q:launch" }],
  [{ text: "What is the guardian?", callback_data: "q:guardian" }],
  [{ text: "What does it cost?", callback_data: "q:cost" }],
  [{ text: "Wallet & Funding", callback_data: "q:wallet" }],
  [{ text: "Auto Snipe", callback_data: "q:snipe" }],
  [{ text: "Market heat explained", callback_data: "q:heat" }],
  [{ text: "Robinhood Chain", callback_data: "q:chain" }],
  [{ text: "System status", callback_data: "q:status" }],
];

function isGroupChat(chatType: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

function isChannelChat(chatType: string): boolean {
  return chatType === "channel";
}

function isMentionedInText(text: string, botUsername: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(`@${botUsername.toLowerCase()}`);
}

async function handleWatchlist(chatId: number): Promise<string> {
  const email = await getUserEmailFromChat(chatId);
  if (!email) return `You need to sign up first. Visit the dashboard to create an account.`;

  const { getWatchlist } = await import("../watchlist/watchlist.js");
  const items = getWatchlist(email);

  if (items.length === 0) {
    return `Your watchlist is empty.\n\nSend a contract address to look up a token, then tap "Add to Watchlist".`;
  }

  const lines = [`<b>Your Watchlist (${items.length} tokens)</b>`, ``];
  for (const item of items) {
    const chainLabel = item.chain === "solana" ? "Solana" : "Robinhood";
    lines.push(`• <b>${item.symbol}</b> (${item.name}) — ${chainLabel}`);
    lines.push(`  <code>${item.address}</code>`);
    lines.push(`  <a href="https://dexscreener.com/${item.chain}/${item.address}">Dexscreener</a>`);
    lines.push(`  <code>/unwatch ${item.address}</code>`);
    lines.push(``);
  }
  return lines.join("\n");
}

async function handleUnwatch(chatId: number, address: string): Promise<string> {
  const email = await getUserEmailFromChat(chatId);
  if (!email) return `You need to sign up first. Visit the dashboard to create an account.`;

  if (!address) return `Usage: /unwatch &lt;token_address&gt;`;

  const { removeFromWatchlist } = await import("../watchlist/watchlist.js");
  const removed = removeFromWatchlist(email, address);

  if (removed) {
    return `<b>Removed from watchlist</b>\n<code>${address}</code>`;
  }
  return `<code>${address}</code> is not in your watchlist.`;
}

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  const chat = msg.chat as Record<string, unknown>;
  const chatId = chat.id as number;
  const chatType = (chat.type as string) || "private";
  const text = (msg.text as string) || "";
  const entities = (msg.entities || []) as Array<Record<string, unknown>>;

  const botInfo = await getBotInfo();
  const botUsername = botInfo?.username || "";

  const isCommand = entities.some((e) => e.type === "bot_command");
  const isMentioned = isMentionedInText(text, botUsername);

  console.log(`[Telegram] Message from ${chatId} (${chatType}): ${text}`);

  if (chatType === "private") {
    addUserId(String(chatId));
  }

  if (isGroupChat(chatType) || isChannelChat(chatType)) {
    if (!isCommand && !isMentioned) {
      return;
    }
  }

  const pendingSetting = pendingSettings.get(String(chatId));
  if (pendingSetting && !text.startsWith("/")) {
    pendingSettings.delete(String(chatId));

    const { getAutoSnipeSettings, setAutoSnipeSettings } = await import("../market/autosnipe.js");
    const settings = getAutoSnipeSettings(chatId);
    const parts = text.trim().split(/\s+/);

    if (pendingSetting === "autosnipe_mc") {
      if (parts.length < 2) {
        await sendMessage(chatId, `Invalid format. Send: <code>10000 500000</code>`);
        return;
      }
      const minMC = parseInt(parts[0]);
      const maxMC = parseInt(parts[1]);
      if (isNaN(minMC) || isNaN(maxMC) || minMC >= maxMC) {
        await sendMessage(chatId, `Invalid range. Min must be less than max.`);
        return;
      }
      settings.minMarketCap = minMC;
      settings.maxMarketCap = maxMC;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>MC range updated:</b> $${minMC.toLocaleString()} - $${maxMC.toLocaleString()}`);
    } else if (pendingSetting === "autosnipe_vol") {
      const val = parseInt(parts[0]);
      if (isNaN(val) || val < 0) {
        await sendMessage(chatId, `Invalid number.`);
        return;
      }
      settings.minVolume5m = val;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>Min volume (5m) updated:</b> $${val.toLocaleString()}`);
    } else if (pendingSetting === "autosnipe_liq") {
      const val = parseInt(parts[0]);
      if (isNaN(val) || val < 0) {
        await sendMessage(chatId, `Invalid number.`);
        return;
      }
      settings.minLiquidity = val;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>Min liquidity updated:</b> $${val.toLocaleString()}`);
    } else if (pendingSetting === "autosnipe_holders") {
      const val = parseInt(parts[0]);
      if (isNaN(val) || val < 0) {
        await sendMessage(chatId, `Invalid number.`);
        return;
      }
      settings.minHolders = val;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>Min holders updated:</b> ${val}`);
    } else if (pendingSetting === "autosnipe_bp") {
      const val = parseInt(parts[0]);
      if (isNaN(val) || val < 0 || val > 100) {
        await sendMessage(chatId, `Invalid percentage (0-100).`);
        return;
      }
      settings.minBuyPressure = val;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>Min buy pressure updated:</b> ${val}%`);
    } else if (pendingSetting === "autosnipe_mom") {
      const val = parseInt(parts[0]);
      if (isNaN(val)) {
        await sendMessage(chatId, `Invalid number.`);
        return;
      }
      settings.minPriceChange5m = val;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>Min momentum updated:</b> ${val}%`);
    } else if (pendingSetting === "autosnipe_max") {
      const val = parseInt(parts[0]);
      if (isNaN(val) || val < 1 || val > 10) {
        await sendMessage(chatId, `Invalid number (1-10).`);
        return;
      }
      settings.maxAlertsPerCycle = val;
      setAutoSnipeSettings(chatId, settings);
      await sendMessage(chatId, `<b>Max alerts per cycle updated:</b> ${val}`);
    }
    return;
  }

  const pending = pendingActions.get(String(chatId));
  if (pending && !text.startsWith("/")) {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
      await sendMessage(chatId, `Invalid amount. Send a number like <code>0.005</code> or <code>50</code>.`);
      return;
    }

    pendingActions.delete(String(chatId));

    if (pending.type === "buy") {
      const isSolana = pending.chain === "solana";
      const chainLabel = isSolana ? "SOL" : "ETH";
      const amountStr = isSolana ? `${amount} SOL` : `${amount} ETH`;
      await sendMessage(chatId, `<b>Buying ${amountStr} of token...</b>\n<code>${pending.tokenAddress}</code>\nChain: ${pending.chain || "robinhood"}`);

      try {
        let result: any;
        if (isSolana) {
          const { buyTokenSolana } = await import("../trading/solana-router.js");
          result = await buyTokenSolana(pending.tokenAddress, amount);
        } else {
          const { buyToken } = await import("../trading/buy.js");
          result = await buyToken(pending.tokenAddress, String(amount));
        }

        if (result.success) {
          const { addTrade } = await import("../launch/launcher.js");
          addTrade({
            txHash: result.txHash || "",
            type: "buy",
            tokenAddress: pending.tokenAddress,
            amountIn: String(amount),
            amountOut: result.amountOut || "0",
            ethSpent: isSolana ? undefined : String(amount),
            timestamp: Date.now(),
            status: "success",
          });
          const explorerUrl = isSolana
            ? `https://solscan.io/tx/${result.txHash}`
            : `https://robinhoodchain.blockscout.com/tx/${result.txHash}`;
          await sendMessage(chatId, [
            `<b>✅ Buy Successful</b>`,
            ``,
            `Token: <code>${pending.tokenAddress}</code>`,
            `Spent: ${amountStr}`,
            `Received: ${result.amountOut || "?"} tokens`,
            `Tx: <code>${result.txHash}</code>`,
            ``,
            `<a href="${explorerUrl}">View on Explorer</a>`,
          ].join("\n"), {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Start Guardian", callback_data: `confirm_monitor:${pending.tokenAddress}` }],
                [{ text: "Sell Now", callback_data: `confirm_sell:${pending.tokenAddress}:100` }],
              ],
            },
          });
        } else {
          await sendMessage(chatId, `❌ Buy failed: ${result.error}`);
        }
      } catch (err) {
        await sendMessage(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (pending.type === "sell") {
      const pct = Math.min(100, Math.max(1, Math.round(amount)));
      const isSolana = pending.chain === "solana";
      await sendMessage(chatId, `<b>Selling ${pct}% of token...</b>\n<code>${pending.tokenAddress}</code>\nChain: ${pending.chain || "robinhood"}`);

      try {
        let result: any;
        if (isSolana) {
          const { sellTokenSolana } = await import("../trading/solana-router.js");
          result = await sellTokenSolana(pending.tokenAddress, pct);
        } else {
          const { sellToken } = await import("../trading/sell.js");
          result = await sellToken(pending.tokenAddress, pct);
        }

        if (result.success) {
          const { addTrade } = await import("../launch/launcher.js");
          addTrade({
            txHash: result.txHash || "",
            type: "sell",
            tokenAddress: pending.tokenAddress,
            amountIn: result.amountIn || "0",
            amountOut: result.amountOut || "0",
            ethReceived: isSolana ? undefined : result.amountOut || "0",
            timestamp: Date.now(),
            status: "success",
          });
          const explorerUrl = isSolana
            ? `https://solscan.io/tx/${result.txHash}`
            : `https://robinhoodchain.blockscout.com/tx/${result.txHash}`;
          await sendMessage(chatId, [
            `<b>✅ Sell Successful</b>`,
            ``,
            `Token: <code>${pending.tokenAddress}</code>`,
            `Sold: ${pct}%`,
            `Received: ${result.amountOut || "?"}`,
            `Tx: <code>${result.txHash}</code>`,
            ``,
            `<a href="${explorerUrl}">View on Explorer</a>`,
          ].join("\n"));
        } else {
          await sendMessage(chatId, `❌ Sell failed: ${result.error}`);
        }
      } catch (err) {
        await sendMessage(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return;
  }

  // Token lookup: detect contract addresses
  const addressMatch = text.trim().match(/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (addressMatch && !isCommand) {
    const address = addressMatch[1];
    const isEvm = address.startsWith("0x");
    await sendMessage(chatId, `<b>Looking up token...</b>\n<code>${address}</code>`);

    try {
      let token: any = null;

      // Try Blockscout first for EVM tokens (fast, chain-specific)
      if (isEvm) {
        try {
          console.log(`[TokenLookup] Trying Blockscout for ${address}`);
          const resp = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${address}`, {
            signal: AbortSignal.timeout(5000),
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
              "Accept": "application/json",
            },
          });
          if (resp.ok) {
            const data = await resp.json() as { name: string; symbol: string; decimals: string; holders_count: number; total_supply: string; market_cap?: string; exchange_rate?: string };
            const price = parseFloat(data.exchange_rate || "0") || 0;
            const mc = parseFloat(data.market_cap || "0") || 0;
            token = {
              symbol: data.symbol?.toUpperCase() || "?",
              name: data.name || "Unknown",
              mint: address,
              chain: "robinhood",
              change_24h: 0,
              volume_24h: 0,
              liquidity: 0,
              holders: data.holders_count || 0,
              market_cap: mc,
              price,
              source: "blockscout" as const,
            };
            console.log(`[TokenLookup] Blockscout found: ${token.symbol} (${token.name})`);
          }
        } catch (e) {
          console.log(`[TokenLookup] Blockscout error: ${e}`);
        }
      }

      // Try Dexscreener if Blockscout didn't find it
      if (!token) {
        try {
          console.log(`[TokenLookup] Trying Dexscreener for ${address}`);
          const { lookupTokenByAddress } = await import("../market/sources/uniswap.js");
          token = await lookupTokenByAddress(address);
          if (token) {
            console.log(`[TokenLookup] Dexscreener found: ${token.symbol} on ${token.chain}`);
          }
        } catch (e) {
          console.log(`[TokenLookup] Dexscreener error: ${e}`);
        }
      }

      // Try Solscan for Solana tokens
      if (!token && !isEvm) {
        try {
          console.log(`[TokenLookup] Trying Solscan for ${address}`);
          const resp = await fetch(`https://public-api.solscan.io/token/meta?token=${address}`, { signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            const data = await resp.json() as { data: { name: string; symbol: string; decimals: number } };
            if (data.data) {
              token = {
                symbol: data.data.symbol?.toUpperCase() || "?",
                name: data.data.name || "Unknown",
                mint: address,
                chain: "solana",
                change_24h: 0,
                volume_24h: 0,
                liquidity: 0,
                holders: 0,
                market_cap: 0,
                price: 0,
                source: "dexscreener" as const,
              };
              console.log(`[TokenLookup] Solscan found: ${token.symbol}`);
            }
          }
        } catch (e) {
          console.log(`[TokenLookup] Solscan error: ${e}`);
        }
      }

      // Last resort: try Dexscreener for Solana
      if (!token && !isEvm) {
        try {
          console.log(`[TokenLookup] Trying Dexscreener for Solana ${address}`);
          const { lookupTokenByAddress } = await import("../market/sources/uniswap.js");
          token = await lookupTokenByAddress(address);
        } catch (e) {
          console.log(`[TokenLookup] Dexscreener Solana error: ${e}`);
        }
      }

      if (!token) {
        await sendMessage(chatId, `❌ Token not found: <code>${address}</code>\n\nThe token may not be indexed yet, or the address is invalid.`);
        return;
      }

      const chain = token.chain || "unknown";
      const isRobinhood = chain === "robinhood";
      const isSolana = chain === "solana";
      const chainLabel = isRobinhood ? "Robinhood Chain" : isSolana ? "Solana" : chain;

      const lines = [
        `<b>🔍 ${token.symbol} — ${token.name}</b>`,
        ``,
        `<b>Chain:</b> ${chainLabel}`,
        `<b>Price:</b> $${(token.price || 0) < 0.01 ? (token.price || 0).toPrecision(4) : (token.price || 0).toFixed(6)}`,
        `<b>MC:</b> $${(token.market_cap || 0).toLocaleString()}`,
        `<b>Liq:</b> $${(token.liquidity || 0).toLocaleString()}`,
        `<b>Vol (5m):</b> $${(token.volume_24h || 0).toLocaleString()}`,
        `<b>24h:</b> ${(token.change_24h || 0) > 0 ? "+" : ""}${(token.change_24h || 0).toFixed(1)}%`,
        ``,
        `<code>${token.mint}</code>`,
      ];

      const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
        [
          { text: `Buy ${token.symbol}`, callback_data: `custom_buy:${token.mint}:${chain}` },
          { text: `Sell ${token.symbol}`, callback_data: `custom_sell:${token.mint}:${chain}` },
        ],
        [
          { text: "Add to Watchlist", callback_data: makeWlCb(token.mint!, chain, token.symbol, token.name || token.symbol) },
        ],
        [
          { text: "Dexscreener", url: `https://dexscreener.com/${chain}/${token.mint}` },
        ],
      ];

      if (isRobinhood) {
        lines.push(``, `<a href="https://robinhoodchain.blockscout.com/address/${token.mint}">View on Blockscout</a>`);
        keyboard.push([{ text: "Blockscout", url: `https://robinhoodchain.blockscout.com/address/${token.mint}` }]);
      } else if (isSolana) {
        lines.push(``, `<a href="https://solscan.io/token/${token.mint}">View on Solscan</a>`);
        keyboard.push([{ text: "Solscan", url: `https://solscan.io/token/${token.mint}` }]);
      }

      await sendMessage(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await sendMessage(chatId, `❌ Error looking up token: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  try {
    const reply = await matchQuestion(text, chatId);
    if (reply) {
      const isGreeting = text.toLowerCase().trim() === "hi" || text.toLowerCase().trim() === "hey" || text.toLowerCase().trim() === "hello" || text.toLowerCase().trim() === "/start";
      if (isGreeting) {
        await sendMessage(chatId, reply, {
          reply_markup: { inline_keyboard: QUESTION_BUTTONS },
        });
      } else {
        await sendMessage(chatId, reply);
      }
      console.log(`[Telegram] Reply sent to ${chatId}`);
    } else {
      await sendMessage(
        chatId,
        `I don't understand that. Tap a button below or send /help.`,
        { reply_markup: { inline_keyboard: QUESTION_BUTTONS } }
      );
      console.log(`[Telegram] Fallback reply sent to ${chatId}`);
    }
  } catch (err) {
    console.error(`[Telegram] handleMessage error:`, err);
  }
}

async function handleCallbackQuery(cb: Record<string, unknown>): Promise<void> {
  const data = (cb.data as string) || "";
  const message = cb.message as Record<string, unknown> | undefined;
  const chatId = (message?.chat as Record<string, unknown>)?.id as number;
  const messageId = message?.message_id as number;

  console.log(`[Telegram] Callback: ${data}`);

  if (data.startsWith("q:")) {
    const topic = data.split(":")[1];
    const qaMap: Record<string, string> = {
      what: QA.what,
      how: QA.how,
      score: QA.score,
      narrative: QA.narrative,
      launch: QA.launch,
      guardian: QA.guardian,
      cost: QA.cost,
      wallet: QA.wallet,
      snipe: QA.snipe,
      heat: QA.heat,
      chain: QA.chain,
      status: handleStatus(),
    };
    const reply = qaMap[topic];
    if (reply) {
      await answerCallbackQuery(cb.id as string);
      await sendMessage(chatId!, reply);
    }
    return;
  }

  if (data.startsWith("approve:")) {
    const decisionId = data.split(":")[1];
    const result = await processApproval({ decision_id: decisionId, approved: true });
    await answerCallbackQuery(cb.id as string, result.success ? "Approved!" : result.message);
    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);

      if (result.success) {
        const { getProposalById } = await import("./approval.js");
        const entry = getProposalById(decisionId);
        const prop = entry?.proposal as Record<string, unknown> | undefined;
        const signal = prop?.signal as Record<string, unknown> | undefined;
        const symbol = (prop?.symbol as string) || (signal?.symbol as string) || "?";
        const mint = (signal?.mint as string) || "";
        const chain = (signal?.chain as string) || "robinhood";
        const name = (prop?.name as string) || (signal?.name as string) || symbol;
        const confidence = ((prop?.confidence as number) || 0) * 100;
        const platform = (prop?.platform as string) || "pons";

        const ponsUrl = `https://www.ponsfamily.com/launchpad`;
        const dexscreenerUrl = `https://dexscreener.com/${chain}/${mint}`;
        const dashboardUrl = `https://cookingbot-production-bcf3.up.railway.app/#deploy`;
        const explorerUrl = `https://robinhoodchain.blockscout.com/address/${mint}`;

        const approveText = [
          `<b>✅ Launch Approved — $${symbol}</b>`,
          ``,
          `Confidence: <b>${confidence.toFixed(0)}%</b>`,
          `Platform: ${platform}`,
          `Name: ${name}`,
          mint ? `Contract: <code>${mint}</code>` : ``,
          ``,
          `<b>Deploy this token:</b>`,
        ].filter(Boolean).join("\n");

        const deployKeyboard = [
          [
            { text: "Deploy via PONS", url: ponsUrl },
          ],
          [
            { text: "View on Dexscreener", url: dexscreenerUrl },
          ],
          [
            { text: "View on Blockscout", url: explorerUrl },
          ],
          [
            { text: "Open Dashboard Deploy", url: dashboardUrl },
          ],
        ];

        await sendMessage(chatId, approveText, {
          reply_markup: { inline_keyboard: deployKeyboard },
        });
      } else {
        await sendMessage(chatId, `<b>Launch Approved</b>\nID: <code>${decisionId}</code>\n${result.message}`);
      }
    }
  } else if (data.startsWith("reject:")) {
    const decisionId = data.split(":")[1];
    const result = await processApproval({ decision_id: decisionId, approved: false });
    await answerCallbackQuery(cb.id as string, result.success ? "Rejected!" : result.message);
    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);
      await sendMessage(chatId, `<b>Launch Rejected</b>\nID: <code>${decisionId}</code>\n${result.message}`);
    }
  } else if (data.startsWith("confirm_buy:")) {
    const parts = data.split(":");
    const tokenAddress = parts[1];
    const ethAmount = parts[2];
    await answerCallbackQuery(cb.id as string, "Executing buy...");

    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);

      try {
        const { buyToken } = await import("../trading/buy.js");
        const { addTrade } = await import("../launch/launcher.js");

        const result = await buyToken(tokenAddress, ethAmount);
        if (result.success) {
          addTrade({
            txHash: result.txHash || "",
            type: "buy",
            tokenAddress,
            amountIn: ethAmount,
            amountOut: result.amountOut || "0",
            ethSpent: ethAmount,
            timestamp: Date.now(),
            status: "success",
          });

          await sendMessage(chatId, [
            `<b>✅ Buy Successful</b>`,
            ``,
            `Token: <code>${tokenAddress}</code>`,
            `Spent: ${ethAmount} ETH`,
            `Received: ${result.amountOut || "?"} tokens`,
            `Tx: <code>${result.txHash}</code>`,
            ``,
            `<a href="https://robinhoodchain.blockscout.com/tx/${result.txHash}">View on Explorer</a>`,
          ].join("\n"), {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Start Guardian", callback_data: `confirm_monitor:${tokenAddress}` },
                ],
                [
                  { text: "Sell Now", callback_data: `confirm_sell:${tokenAddress}:100` },
                ],
              ],
            },
          });
        } else {
          await sendMessage(chatId, `❌ Buy failed: ${result.error}`);
        }
      } catch (err) {
        await sendMessage(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (data.startsWith("confirm_sell:")) {
    const parts = data.split(":");
    const tokenAddress = parts[1];
    const percentage = parseInt(parts[2] || "100");
    await answerCallbackQuery(cb.id as string, "Executing sell...");

    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);

      try {
        const { sellToken } = await import("../trading/sell.js");
        const { addTrade } = await import("../launch/launcher.js");

        const result = await sellToken(tokenAddress, percentage);
        if (result.success) {
          addTrade({
            txHash: result.txHash || "",
            type: "sell",
            tokenAddress,
            amountIn: result.amountIn || "0",
            amountOut: result.amountOut || "0",
            ethReceived: result.amountOut || "0",
            timestamp: Date.now(),
            status: "success",
          });

          await sendMessage(chatId, [
            `<b>✅ Sell Successful</b>`,
            ``,
            `Token: <code>${tokenAddress}</code>`,
            `Sold: ${percentage}%`,
            `Received: ${result.amountOut || "?"} ETH`,
            `Tx: <code>${result.txHash}</code>`,
            ``,
            `<a href="https://robinhoodchain.blockscout.com/tx/${result.txHash}">View on Explorer</a>`,
          ].join("\n"));
        } else {
          await sendMessage(chatId, `❌ Sell failed: ${result.error}`);
        }
      } catch (err) {
        await sendMessage(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (data.startsWith("confirm_monitor:")) {
    const tokenAddress = data.split(":")[1];
    await answerCallbackQuery(cb.id as string, "Starting guardian...");

    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);

      try {
        const { registerPosition } = await import("../guardian/liquidity.js");
        const { registerGuardian } = await import("../guardian/monitor.js");

        registerPosition(tokenAddress, tokenAddress.slice(0, 6), 0, 0);
        registerGuardian(tokenAddress, tokenAddress.slice(0, 6));

        await sendMessage(chatId, [
          `<b>✅ Guardian Active</b>`,
          ``,
          `Token: <code>${tokenAddress}</code>`,
          `Stop-loss: -30%`,
          `Take-profit: +100%`,
          `Emergency exit: -50% (auto-sell)`,
          ``,
          `You'll receive alerts when price moves.`,
        ].join("\n"));
      } catch (err) {
        await sendMessage(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (data.startsWith("quick_buy:")) {
    const parts = data.split(":");
    const tokenAddress = parts[1];
    const ethAmount = parts[2];

    await answerCallbackQuery(cb.id as string, `Buying ${ethAmount} ETH...`);

    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);

      try {
        const { buyToken } = await import("../trading/buy.js");
        const { addTrade } = await import("../launch/launcher.js");

        const result = await buyToken(tokenAddress, ethAmount);
        if (result.success) {
          addTrade({
            txHash: result.txHash || "",
            type: "buy",
            tokenAddress,
            amountIn: ethAmount,
            amountOut: result.amountOut || "0",
            ethSpent: ethAmount,
            timestamp: Date.now(),
            status: "success",
          });

          await sendMessage(chatId, [
            `<b>✅ Snipe Successful</b>`,
            ``,
            `Token: <code>${tokenAddress}</code>`,
            `Spent: ${ethAmount} ETH`,
            `Received: ${result.amountOut || "?"} tokens`,
            `Tx: <code>${result.txHash}</code>`,
            ``,
            `<a href="https://robinhoodchain.blockscout.com/tx/${result.txHash}">View on Explorer</a>`,
          ].join("\n"), {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Start Guardian", callback_data: `confirm_monitor:${tokenAddress}` },
                ],
                [
                  { text: "Sell Now", callback_data: `confirm_sell:${tokenAddress}:100` },
                ],
              ],
            },
          });
        } else {
          await sendMessage(chatId, `❌ Buy failed: ${result.error}`);
        }
      } catch (err) {
        await sendMessage(chatId, `❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (data.startsWith("custom_buy:")) {
    const parts = data.split(":");
    const tokenAddress = parts[1];
    const chain = parts[2] || "robinhood";
    pendingActions.set(String(chatId), { type: "buy", tokenAddress, chain });
    await answerCallbackQuery(cb.id as string, "Enter amount");
    if (chatId) {
      const unit = chain === "solana" ? "SOL" : "ETH";
      await sendMessage(chatId, [
        `<b>Enter ${unit} amount to buy:</b>`,
        ``,
        `Token: <code>${tokenAddress}</code>`,
        `Chain: ${chain}`,
        `Type a number like: <code>0.005</code>`,
        ``,
        `<i>Send the amount now. This expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data.startsWith("custom_sell:")) {
    const parts = data.split(":");
    const tokenAddress = parts[1];
    const chain = parts[2] || "robinhood";
    pendingActions.set(String(chatId), { type: "sell", tokenAddress, chain });
    await answerCallbackQuery(cb.id as string, "Enter percentage");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter percentage to sell:</b>`,
        ``,
        `Token: <code>${tokenAddress}</code>`,
        `Chain: ${chain}`,
        `Type a number like: <code>50</code> (for 50%) or <code>100</code> (sell all)`,
        ``,
        `<i>Send the percentage now. This expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data.startsWith("wl:")) {
    const id = parseInt(data.split(":")[1], 10);
    const wl = pendingWatchlist.get(id);
    if (!wl) {
      await answerCallbackQuery(cb.id as string, "Expired, try again");
      return;
    }
    pendingWatchlist.delete(id);

    const userEmail = await getUserEmailFromChat(chatId);
    if (!userEmail) {
      await sendMessage(chatId, `You need to sign up first to use the watchlist. Visit the dashboard to create an account.`);
      return;
    }

    const { addToWatchlist } = await import("../watchlist/watchlist.js");
    const added = addToWatchlist(userEmail, wl.address, wl.chain, wl.symbol, wl.name);

    await answerCallbackQuery(cb.id as string, added ? "Added to watchlist" : "Already watched");
    if (chatId) {
      if (added) {
        await sendMessage(chatId, `<b>✅ Added to Watchlist</b>\n\n$${wl.symbol} on ${wl.chain}\n<code>${wl.address}</code>`);
      } else {
        await sendMessage(chatId, `<b>$${wl.symbol}</b> is already in your watchlist.`);
      }
    }
  } else if (data === "as_toggle") {
    const { toggleAutoSnipe } = await import("../market/autosnipe.js");
    const enabled = toggleAutoSnipe(chatId!);
    await answerCallbackQuery(cb.id as string, enabled ? "Auto Snipe ON" : "Auto Snipe OFF");
    if (chatId) {
      const statusMsg = enabled
        ? `🟢 <b>Auto Snipe activated!</b>\n\nScanning for tokens matching your parameters every 30 seconds.`
        : `🔴 <b>Auto Snipe disabled.</b>`;
      await sendMessage(chatId, statusMsg);
    }
  } else if (data === "as_edit") {
    await answerCallbackQuery(cb.id as string, "Opening settings...");
    if (chatId) {
      await sendMessage(chatId, `<b>Edit Auto Snipe Settings:</b>`, handleAutoSnipeEditKeyboard());
    }
  } else if (data === "as_mc") {
    pendingSettings.set(String(chatId), "autosnipe_mc");
    await answerCallbackQuery(cb.id as string, "Enter MC range");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter min and max market cap:</b>`,
        ``,
        `Format: <code>10000 500000</code>`,
        `Current: $10,000 - $500,000`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_vol") {
    pendingSettings.set(String(chatId), "autosnipe_vol");
    await answerCallbackQuery(cb.id as string, "Enter min volume");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter minimum 5-minute volume (USD):</b>`,
        ``,
        `Example: <code>1500</code>`,
        `Current: $1,500`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_liq") {
    pendingSettings.set(String(chatId), "autosnipe_liq");
    await answerCallbackQuery(cb.id as string, "Enter min liquidity");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter minimum liquidity (USD):</b>`,
        ``,
        `Example: <code>5000</code>`,
        `Current: $5,000`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_holders") {
    pendingSettings.set(String(chatId), "autosnipe_holders");
    await answerCallbackQuery(cb.id as string, "Enter min holders");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter minimum number of holders:</b>`,
        ``,
        `Example: <code>20</code>`,
        `Current: 20`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_bp") {
    pendingSettings.set(String(chatId), "autosnipe_bp");
    await answerCallbackQuery(cb.id as string, "Enter min buy pressure");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter minimum buy pressure (%):</b>`,
        ``,
        `Example: <code>55</code>`,
        `Current: 55%`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_mom") {
    pendingSettings.set(String(chatId), "autosnipe_mom");
    await answerCallbackQuery(cb.id as string, "Enter min momentum");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter minimum 5m price change (%):</b>`,
        ``,
        `Example: <code>0</code> (positive momentum only)`,
        `Current: 0%`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_chains") {
    const { getAutoSnipeSettings, setAutoSnipeSettings } = await import("../market/autosnipe.js");
    const settings = getAutoSnipeSettings(chatId!);
    const hasRH = settings.chains.includes("robinhood");
    const hasSOL = settings.chains.includes("solana");
    await answerCallbackQuery(cb.id as string, "Toggled chain");
    if (chatId) {
      const newChains: string[] = [];
      if (!hasRH || hasSOL) newChains.push("robinhood");
      if (!hasSOL || hasRH) newChains.push("solana");
      if (newChains.length === 0) newChains.push("robinhood", "solana");
      settings.chains = newChains;
      setAutoSnipeSettings(chatId!, settings);
      await sendMessage(chatId, `<b>Chains updated:</b> ${newChains.join(", ")}`);
    }
  } else if (data === "as_max") {
    pendingSettings.set(String(chatId), "autosnipe_max");
    await answerCallbackQuery(cb.id as string, "Enter max alerts");
    if (chatId) {
      await sendMessage(chatId, [
        `<b>Enter max alerts per scan cycle:</b>`,
        ``,
        `Example: <code>3</code>`,
        `Current: 3`,
        ``,
        `<i>Send now. Expires in 5 minutes.</i>`,
      ].join("\n"));
    }
  } else if (data === "as_reset") {
    const { setAutoSnipeSettings } = await import("../market/autosnipe.js");
    setAutoSnipeSettings(chatId!, {
      enabled: false,
      minMarketCap: 10000,
      maxMarketCap: 500000,
      minVolume5m: 1500,
      minLiquidity: 5000,
      minHolders: 20,
      minBuyPressure: 55,
      minPriceChange5m: 0,
      chains: ["robinhood", "solana"],
      maxAlertsPerCycle: 3,
    });
    await answerCallbackQuery(cb.id as string, "Settings reset");
    if (chatId) {
      await sendMessage(chatId, `<b>Settings reset to defaults.</b>\n\nMC: $10K-$500K | Vol: $1.5K+ | Liq: $5K+ | Holders: 20+ | BP: 55%+ | Momentum: 0%+`);
    }
  } else if (data === "as_done") {
    await answerCallbackQuery(cb.id as string, "Settings saved");
    if (chatId) {
      await sendMessage(chatId, `<b>✅ Auto Snipe settings saved.</b>\n\nUse /autosnipe to view your settings.`);
    }
  } else if (data === "skip_action") {
    await answerCallbackQuery(cb.id as string, "Skipped");
    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);
      await sendMessage(chatId, `Action skipped.`);
    }
  }
}

async function handleMyChatMember(update: Record<string, unknown>): Promise<void> {
  const myChatMember = update.my_chat_member as Record<string, unknown>;
  const chat = myChatMember.chat as Record<string, unknown>;
  const chatId = String(chat.id);
  const chatType = chat.type as string;
  const status = (myChatMember.new_chat_member as Record<string, unknown>)?.status as string;

  if (isGroupChat(chatType) || isChannelChat(chatType)) {
    if (status === "member" || status === "administrator") {
      addGroupId(chatId);
      await sendMessage(Number(chatId), QA.group_welcome);
    } else if (status === "left" || status === "kicked") {
      removeGroupId(chatId);
    }
  }
}

async function pollUpdates(): Promise<void> {
  if (polling || !getBotToken()) return;
  polling = true;

  try {
    const url = `${getApi()}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const resp = await fetch(url);
    const data = (await resp.json()) as {
      ok: boolean;
      result: Array<Record<string, unknown>>;
    };

    if (!data.ok || !data.result) {
      polling = false;
      return;
    }

    for (const update of data.result) {
      lastUpdateId = (update.update_id as number) || lastUpdateId;

      if (update.my_chat_member) {
        await handleMyChatMember(update);
      } else if (update.message) {
        await handleMessage(update.message as Record<string, unknown>);
      } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query as Record<string, unknown>);
      }
    }
  } catch (err) {
    console.error("[Telegram] Poll error:", err);
  } finally {
    polling = false;
  }
}

async function registerBotCommands(): Promise<void> {
  try {
    const resp = await fetch(`${getApi()}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start", description: "Welcome message & main menu" },
          { command: "help", description: "All commands" },
          { command: "status", description: "System status" },
          { command: "buy", description: "Buy a token" },
          { command: "sell", description: "Sell a token" },
          { command: "bal", description: "Check wallet balance" },
          { command: "trades", description: "View trade history" },
          { command: "positions", description: "Guardian positions" },
          { command: "autosnipe", description: "Auto Snipe settings & toggle" },
          { command: "narrative", description: "AI narrative detection" },
          { command: "watchlist", description: "View your watchlist" },
          { command: "wallet", description: "Wallet & funding info" },
          { command: "config", description: "Current thresholds" },
          { command: "costs", description: "Launch costs" },
        ],
      }),
    });
    const data = await resp.json() as { ok: boolean };
    console.log(`[Telegram] Bot menu commands registered: ${data.ok}`);
  } catch (err) {
    console.log(`[Telegram] Failed to register commands: ${err}`);
  }
}

export function startTelegramBot(): void {
  if (!getBotToken()) {
    console.log("[Telegram] No TELEGRAM_BOT_TOKEN set, bot disabled");
    return;
  }

  console.log(`[Telegram] Starting COOKING bot (chat IDs: ${getChatIds().join(", ")})`);
  console.log(`[Telegram] Group/Channel IDs: ${loadGroupIds().join(", ") || "none yet"}`);

  registerBotCommands();
  setInterval(pollUpdates, 3000);
  pollUpdates();
}

export async function sendProposalToTelegram(proposal: {
  decision_id: string;
  symbol: string;
  confidence: number;
  platform: string;
  estimated_cost_eth: number;
  reasoning: string;
  mint?: string;
  chain?: string;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const confPct = (proposal.confidence * 100).toFixed(0);
  const lines = [
    `🚀 <b>COOKING Proposal — $${proposal.symbol}</b>`,
    ``,
    `Confidence: <b>${confPct}%</b>`,
    `Platform: ${proposal.platform}`,
    `Cost: ${proposal.estimated_cost_eth} ETH`,
    ``,
  ];

  if (proposal.mint) {
    lines.push(
      `Contract: <code>${proposal.mint}</code>`,
      ``,
    );
  }

  lines.push(
    `<i>${proposal.reasoning}</i>`,
    ``,
  );

  if (proposal.mint) {
    const chain = proposal.chain || "robinhood";
    lines.push(
      `<a href="https://dexscreener.com/${chain}/${proposal.mint}">View on Dexscreener</a>`,
      `<a href="https://robinhoodchain.blockscout.com/address/${proposal.mint}">View on Blockscout</a>`,
      ``,
    );
  }

  lines.push(`ID: <code>${proposal.decision_id}</code>`);

  const text = lines.join("\n");

  const inlineKeyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: "Approve ✅", callback_data: `approve:${proposal.decision_id}` },
      { text: "Reject ❌", callback_data: `reject:${proposal.decision_id}` },
    ],
  ];

  if (proposal.mint) {
    const chain = proposal.chain || "robinhood";
    inlineKeyboard.push([
      { text: "View on Dexscreener", url: `https://dexscreener.com/${chain}/${proposal.mint}` },
      { text: "View on Blockscout", url: `https://robinhoodchain.blockscout.com/address/${proposal.mint}` },
    ]);
  }

  for (const chatId of allChatIds) {
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  console.log(`[Telegram] Proposal sent for $${proposal.symbol} to ${allChatIds.length} chats`);
}

export async function sendAlertToTelegram(text: string): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  for (const chatId of allChatIds) {
    await sendMessage(chatId, text);
  }
}

export async function sendNarrativeToTelegram(narrative: {
  trending_narratives: string[];
  theme_scores: Record<string, number>;
  tokens_per_narrative: Record<string, Array<{
    symbol: string;
    address: string;
    chain: string;
    market_cap: number;
    volume_24h: number;
    change_24h: number;
    dexscreener_url: string;
  }>>;
  reasoning: string;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const narratives = narrative.trending_narratives || [];
  const scores = narrative.theme_scores || {};
  const tokensPerNarrative = narrative.tokens_per_narrative || {};
  const reasoning = narrative.reasoning || "";

  const lines = [
    `<b>🧠 NARRATIVE INTELLIGENCE</b>`,
    ``,
    `<b>Opportunities ($10K-$10M)</b>`,
    ``,
  ];

  const inlineKeyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> = [];

  for (const n of narratives) {
    const score = scores[n] || 50;
    const bar = score >= 70 ? "🔥" : score >= 50 ? "🟡" : "⚪";
    lines.push(`${bar} <b>${n}</b> — ${score}/100`);

    const tokens = tokensPerNarrative[n] || [];
    if (tokens.length > 0) {
      for (const token of tokens.slice(0, 3)) {
        const mc = token.market_cap || 0;
        let mcStr = "N/A";
        if (mc >= 1000000) {
          mcStr = `$${(mc / 1000000).toFixed(1)}M`;
        } else if (mc >= 1000) {
          mcStr = `$${(mc / 1000).toFixed(0)}K`;
        } else if (mc > 0) {
          mcStr = `$${mc.toFixed(0)}`;
        }

        const vol = token.volume_24h || 0;
        let volStr = "N/A";
        if (vol >= 1000000) {
          volStr = `$${(vol / 1000000).toFixed(1)}M`;
        } else if (vol >= 1000) {
          volStr = `$${(vol / 1000).toFixed(0)}K`;
        } else if (vol > 0) {
          volStr = `$${vol.toFixed(0)}`;
        }

        const changeStr = token.change_24h > 0 ? `+${token.change_24h.toFixed(1)}%` : `${token.change_24h.toFixed(1)}%`;
        const chainStr = token.chain || "?";

        lines.push(`  <b>${token.symbol}</b> (<code>${token.address}</code>)`);
        lines.push(`  MC: ${mcStr} | Vol: ${volStr} | ${changeStr} | ${chainStr}`);
        lines.push(`  <a href="${token.dexscreener_url}">Dexscreener</a>`);
      }

      // Add trade buttons for top tokens
      const topTokens = tokens.slice(0, 2);
      for (const t of topTokens) {
        const chain = t.chain || "robinhood";
        inlineKeyboard.push([
          { text: `Buy $${t.symbol}`, callback_data: `custom_buy:${t.address}:${chain}` },
          { text: `Sell $${t.symbol}`, callback_data: `custom_sell:${t.address}:${chain}` },
        ]);
        inlineKeyboard.push([
          { text: `Watch $${t.symbol}`, callback_data: makeWlCb(t.address, chain, t.symbol, t.symbol) },
        ]);
      }
    } else {
      lines.push(`  <i>No tokens identified</i>`);
    }

    lines.push(``);
  }

  if (reasoning) {
    lines.push(`<i>${reasoning}</i>`);
  }

  // Add refresh button
  inlineKeyboard.push([
    { text: "Refresh Narratives", callback_data: "q:narrative" },
  ]);

  const text = lines.join("\n");

  for (const chatId of allChatIds) {
    await sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: inlineKeyboard },
      disable_web_page_preview: true,
    });
  }

  console.log(`[Telegram] Narrative analysis sent to ${allChatIds.length} chats`);
}

export async function sendSnipeAlertToTelegram(token: {
  symbol: string;
  address: string;
  score: number;
  volume_24h: number;
  liquidity: number;
  holders: number;
  price?: number;
  change_24h?: number;
  chain?: string;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const chain = token.chain || "robinhood";
  const chainLabel = chain === "solana" ? "Solana" : "Robinhood";
  const changeStr = token.change_24h ? `${token.change_24h > 0 ? "+" : ""}${token.change_24h.toFixed(1)}%` : "?";
  const priceStr = token.price ? `$${token.price.toFixed(6)}` : "?";

  const lines = [
    `🎯 <b>SNIPING OPPORTUNITY</b>`,
    ``,
    `<b>${token.symbol}</b> (${chainLabel})`,
    `<code>${token.address}</code>`,
    `Score: <b>${token.score.toFixed(0)}%</b> | 24h: ${changeStr}`,
    `Price: ${priceStr}`,
    `Volume (5m): $${(token.volume_24h || 0).toLocaleString()}`,
    `Liquidity: $${(token.liquidity || 0).toLocaleString()}`,
    `Holders: ${(token.holders || 0).toLocaleString()}`,
    ``,
    `<a href="https://dexscreener.com/${chain}/${token.address}">Dexscreener</a>`,
  ];

  if (chain === "robinhood") {
    lines.push(`<a href="https://robinhoodchain.blockscout.com/address/${token.address}">Blockscout</a>`);
  } else if (chain === "solana") {
    lines.push(`<a href="https://solscan.io/token/${token.address}">Solscan</a>`);
  }

  const text = lines.join("\n");

  const inlineKeyboard = [
    [
      { text: "Buy", callback_data: `custom_buy:${token.address}:${chain}` },
      { text: "Sell", callback_data: `custom_sell:${token.address}:${chain}` },
    ],
    [
      { text: "Add to Watchlist", callback_data: makeWlCb(token.address, chain, token.symbol, token.symbol) },
    ],
    [
      { text: "Dexscreener", url: `https://dexscreener.com/${chain}/${token.address}` },
    ],
    [
      { text: "Ignore", callback_data: `skip_action` },
    ],
  ];

  for (const chatId of allChatIds) {
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  console.log(`[Telegram] Snipe alert sent for $${token.symbol} (${chain}) to ${allChatIds.length} chats`);
}

export async function sendGuardianAlertToTelegram(alert: {
  type: string;
  symbol: string;
  message: string;
  severity: string;
  tokenAddress?: string;
  currentPrice?: number;
  pnlPct?: number;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const emoji = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟡" : "🟢";
  const lines = [
    `${emoji} <b>GUARDIAN ALERT — $${alert.symbol}</b>`,
    ``,
    alert.message,
  ];

  if (alert.tokenAddress) {
    lines.push(
      ``,
      `Contract: <code>${alert.tokenAddress}</code>`,
      `<a href="https://dexscreener.com/robinhood/${alert.tokenAddress}">View on Dexscreener</a>`,
      `<a href="https://robinhoodchain.blockscout.com/address/${alert.tokenAddress}">View on Blockscout</a>`,
    );
  }

  if (alert.tokenAddress && (alert.type === "stop_loss" || alert.type === "take_profit" || alert.type === "trailing_stop")) {
    lines.push(``, `<b>Sell all for ETH?</b>`);
  }

  const text = lines.join("\n");

  const inlineKeyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  if (alert.tokenAddress && (alert.type === "stop_loss" || alert.type === "take_profit" || alert.type === "trailing_stop")) {
    inlineKeyboard.push([
      { text: "Confirm Sell", callback_data: `confirm_sell:${alert.tokenAddress}:100` },
      { text: "Hold", callback_data: `skip_action` },
    ]);
  } else if (alert.tokenAddress) {
    inlineKeyboard.push([
      { text: "View on Dexscreener", url: `https://dexscreener.com/robinhood/${alert.tokenAddress}` },
    ]);
  }

  for (const chatId of allChatIds) {
    if (inlineKeyboard.length > 0) {
      await sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
    } else {
      await sendMessage(chatId, text);
    }
  }

  console.log(`[Telegram] Guardian alert sent for $${alert.symbol} to ${allChatIds.length} chats`);
}

export async function sendLaunchBuyConfirmation(data: {
  symbol: string;
  tokenAddress: string;
  txHash: string;
  ethAmount: number;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const text = [
    `🚀 <b>$${data.symbol} Deployed via PONS!</b>`,
    ``,
    `Contract: <code>${data.tokenAddress}</code>`,
    `Tx: <code>${data.txHash}</code>`,
    ``,
    `<b>Buy ${data.ethAmount} ETH of $${data.symbol}?</b>`,
    `You'll receive tokens at market price`,
    ``,
    `<a href="https://dexscreener.com/robinhood/${data.tokenAddress}">View on Dexscreener</a>`,
    `<a href="https://robinhoodchain.blockscout.com/address/${data.tokenAddress}">View on Blockscout</a>`,
  ].join("\n");

  const inlineKeyboard = [
    [
      { text: `Buy ${data.ethAmount} ETH`, callback_data: `confirm_buy:${data.tokenAddress}:${data.ethAmount}` },
      { text: "Skip", callback_data: `skip_action` },
    ],
  ];

  for (const chatId of allChatIds) {
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  console.log(`[Telegram] Launch buy confirmation sent for $${data.symbol} to ${allChatIds.length} chats`);
}

export async function sendAutoSnipeAlertToTelegram(data: {
  chatId: string;
  symbol: string;
  address: string;
  chain: string;
  market_cap: number;
  volume_5m: number;
  liquidity: number;
  holders: number;
  price: number;
  change_5m: number;
  change_24h: number;
  buy_pressure: number;
  dexscreener_url: string;
}): Promise<void> {
  if (!getBotToken()) return;

  const chainLabel = data.chain === "solana" ? "Solana" : "Robinhood";
  const mcStr = data.market_cap >= 1000000 ? `$${(data.market_cap / 1000000).toFixed(1)}M` : data.market_cap >= 1000 ? `$${(data.market_cap / 1000).toFixed(0)}K` : `$${data.market_cap.toFixed(0)}`;
  const volStr = data.volume_5m >= 1000 ? `$${(data.volume_5m / 1000).toFixed(1)}K` : `$${data.volume_5m.toFixed(0)}`;
  const liqStr = data.liquidity >= 1000 ? `$${(data.liquidity / 1000).toFixed(1)}K` : `$${data.liquidity.toFixed(0)}`;
  const change5mStr = data.change_5m > 0 ? `+${data.change_5m.toFixed(1)}%` : `${data.change_5m.toFixed(1)}%`;
  const change24hStr = data.change_24h > 0 ? `+${data.change_24h.toFixed(1)}%` : `${data.change_24h.toFixed(1)}%`;

  const lines = [
    `⚡ <b>AUTO SNIPE MATCH</b>`,
    ``,
    `<b>${data.symbol}</b> (${chainLabel})`,
    `<code>${data.address}</code>`,
    ``,
    `MC: ${mcStr} | Liq: ${liqStr}`,
    `Vol (5m): ${volStr} | Holders: ${data.holders}`,
    `24h: ${change24hStr} | 5m: ${change5mStr}`,
    `Buy Pressure: ${data.buy_pressure}%`,
    ``,
    `<a href="${data.dexscreener_url}">Dexscreener</a>`,
  ];

  if (data.chain === "robinhood") {
    lines.push(`<a href="https://robinhoodchain.blockscout.com/address/${data.address}">Blockscout</a>`);
  } else if (data.chain === "solana") {
    lines.push(`<a href="https://solscan.io/token/${data.address}">Solscan</a>`);
  }

  const text = lines.join("\n");

  const inlineKeyboard = [
    [
      { text: "Buy", callback_data: `custom_buy:${data.address}:${data.chain}` },
      { text: "Sell", callback_data: `custom_sell:${data.address}:${data.chain}` },
    ],
    [
      { text: "Add to Watchlist", callback_data: makeWlCb(data.address, data.chain, data.symbol, data.symbol) },
    ],
    [
      { text: "Dexscreener", url: data.dexscreener_url },
    ],
  ];

  await sendMessage(data.chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
  console.log(`[AutoSnipe] Alert sent for $${data.symbol} (${data.chain}) to ${data.chatId}`);
}

export async function sendMigrationAlertToTelegram(data: {
  symbol: string;
  address: string;
  market_cap: number;
  volume_24h: number;
  liquidity: number;
  holders: number;
  price: number;
  change_24h: number;
  dexscreener_url: string;
  source: string;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const mcStr = data.market_cap >= 1000000 ? `$${(data.market_cap / 1000000).toFixed(1)}M` : data.market_cap >= 1000 ? `$${(data.market_cap / 1000).toFixed(0)}K` : `$${data.market_cap.toFixed(0)}`;
  const volStr = data.volume_24h >= 1000 ? `$${(data.volume_24h / 1000).toFixed(1)}K` : `$${data.volume_24h.toFixed(0)}`;
  const liqStr = data.liquidity >= 1000 ? `$${(data.liquidity / 1000).toFixed(1)}K` : `$${data.liquidity.toFixed(0)}`;

  const lines = [
    `🚀 <b>LP MIGRATION DETECTED</b>`,
    ``,
    `<b>$${data.symbol}</b> just migrated to Raydium!`,
    `<code>${data.address}</code>`,
    ``,
    `MC: ${mcStr} | Liq: ${liqStr}`,
    `Vol: ${volStr} | Holders: ${data.holders}`,
    `Source: ${data.source}`,
    ``,
    `<a href="${data.dexscreener_url}">Dexscreener</a>`,
    `<a href="https://solscan.io/token/${data.address}">Solscan</a>`,
  ];

  const text = lines.join("\n");

  const inlineKeyboard = [
    [
      { text: "Buy", callback_data: `custom_buy:${data.address}:solana` },
      { text: "Sell", callback_data: `custom_sell:${data.address}:solana` },
    ],
    [
      { text: "Add to Watchlist", callback_data: makeWlCb(data.address, "solana", data.symbol, data.symbol) },
    ],
    [
      { text: "Dexscreener", url: data.dexscreener_url },
      { text: "Raydium", url: `https://raydium.io/swap?inputCurrency=sol&outputCurrency=${data.address}` },
    ],
  ];

  for (const chatId of allChatIds) {
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  console.log(`[MigrationSniper] Alert sent for $${data.symbol} to ${allChatIds.length} chats`);
}
