import { processApproval, getPendingProposals } from "./approval.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const GROUP_IDS_FILE = join(ROOT_DIR, "data", "group_ids.json");

let lastUpdateId = 0;
let polling = false;

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

function getAllChatIds(): string[] {
  const envIds = getChatIds();
  const groupIds = loadGroupIds();
  const combined = new Set([...envIds, ...groupIds]);
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

const QA: Record<string, string> = {
  greet: `<b>Hey! Welcome to COOKING.</b>\n\nI'm your autonomous Robinhood Chain token sniper. I scan Uniswap pools, score tokens with AI, propose launches, and guard your positions after deployment — all on autopilot.\n\n<b>Dashboard:</b> https://cookingbot-production-bcf3.up.railway.app\n\n<b>Ask me anything:</b>\n\n/scoring - How the scoring algorithm works\n/launch - How token launching works\n/guardian - Post-launch monitoring\n/narrative - AI narrative detection\n/costs - What it costs\n/heat - Market heat explained\n/config - Current thresholds\n/proposals - View pending launches\n/status - System status\n/help - All commands\n\nJust type a question like "how does scoring work" or "what does the guardian do" and I'll answer it.`,

  group_welcome: `<b>COOKING Bot added to this group!</b>\n\nI'll post token launch proposals and market alerts here.\n\n<b>Commands you can use:</b>\n/status - System status\n/proposals - View pending launches\n/help - All commands\n\nYou'll receive proposals with Approve/Reject buttons when the engine finds a strong signal.`,

  what: `<b>What is COOKING?</b>\n\nCOOKING is an autonomous Robinhood Chain token sniper. It scans Uniswap pools, scores every token with a 6-factor algorithm + AI narrative detection, proposes launches when conditions are right, and monitors your positions 24/7 for rugs and price moves.`,

  how: `<b>How does COOKING work?</b>\n\n1. <b>Scan</b> - Fetches trending tokens from Uniswap pools and Blockscout analytics\n2. <b>Score</b> - 6-factor weighted algorithm rates volume, liquidity, momentum, holders, safety + AI narrative boost\n3. <b>Launch</b> - AI proposes a launch when confidence hits 75%+. You approve, it deploys via NOXA Fun with locked liquidity\n4. <b>Guard</b> - Monitors your token 24/7 for rugs, price crashes, stop-loss and take-profit triggers`,

  score: `<b>How COOKING Scores Tokens</b>\n\nCOOKING uses a 6-factor weighted algorithm plus AI narrative detection to rate every token on Robinhood Chain.\n\n<b>The 6 Factors:</b>\n\n1. Volume Spike (25% weight)\nMeasures volume-to-liquidity ratio. A sudden spike means traders are piling in.\n\n2. Liquidity Depth (20% weight)\nChecks if there's enough liquidity on Uniswap to actually trade. Minimum $10K required.\n\n3. 24-Hour Momentum (20% weight)\nPrice trend over the last 24 hours. Strong upward momentum scores high.\n\n4. 1-Hour Momentum (15% weight)\nShort-term action. Are buyers stepping in right now?\n\n5. Holder Growth (10% weight)\nNumber of unique holders and distribution. More holders = healthier token.\n\n6. Safety Score (10% weight)\nContract verification, owner renounced, top holder concentration.\n\n<b>Narrative Boost</b>\nGoogle Gemini AI analyzes trending themes on Robinhood Chain (AI agents, tokenized stocks, memes, DePIN). Tokens matching hot narratives get up to +15% score boost.\n\n<b>Score Ranges:</b>\n- 70%+ = Actionable (proposes a launch)\n- 45-69% = Watchlist (monitored)\n- Below 45% = Noise (ignored)`,

  launch: `<b>Token Launching</b>\n\nWhen a token scores 70%+ and conditions are right:\n- AI evaluates market heat, confidence, and narrative alignment\n- Must hit 75%+ confidence to propose\n- You approve via Telegram buttons\n- Deploys via NOXA Fun (~0.01 ETH)\n- Liquidity is auto-locked — rug-proof from day one`,

  guardian: `<b>Guardian System</b>\n\nPost-launch monitoring on Robinhood Chain:\n- Rug detection (contract owner, mint authority, supply concentration)\n- Price alerts (20%+ surges or dumps)\n- Holder milestones (100, 500, 1K, 5K, 10K)\n- Stop-loss (-30%) and take-profit (+100%)\n- Contract safety checks via Blockscout\n- Telegram alerts in real-time`,

  narrative: `<b>AI Narrative Detection</b>\n\nCOOKING uses Google Gemini AI to identify trending themes on Robinhood Chain:\n\n- Scans new token launches on NOXA Fun for common themes\n- Analyzes social data from LunarCrush for rising narratives\n- Detects meme trends, sector rotations, and hype cycles\n\nTokens matching hot narratives get a score boost (up to +15%), making them more likely to be proposed for launch.\n\nExamples: AI agents, tokenized stocks, political memes, DePIN, gaming tokens.\n\nNarratives refresh every 5 minutes automatically.`,

  cost: `<b>Costs</b>\n\n- NOXA Fun launch: ~0.01 ETH (gas only)\n- Guardian monitoring: free\n- Narrative detection: free (Google Gemini free tier)\n- No platform fees — you only pay Robinhood Chain gas costs\n- Sub-cent transaction fees`,

  approve: `<b>Approving a Launch</b>\n\nWhen a new proposal comes in:\n- Tap the Approve or Reject button\n- Or send /approve &lt;decision_id&gt;\n- Or use the API: POST /api/approve/&lt;id&gt;\n- Approval window: 5 minutes`,

  heat: `<b>Market Heat</b>\n\nA gauge of overall market activity on Robinhood Chain:\n- Number of candidate tokens found on Uniswap\n- Top scores among candidates\n- Scale: Cold (0-20%) -> Cool -> Warm -> Hot (70%+)\n\nHigher heat = more opportunity`,

  chain: `<b>Robinhood Chain</b>\n\n- Ethereum L2 built on Arbitrum\n- ~100ms block times, sub-cent gas fees\n- Uniswap V2/V3/V4 for trading\n- NOXA Fun for token launches with locked LP\n- Blockscout for analytics and safety\n- Chain ID 4663`,

  help: `<b>COOKING Commands</b>\n\n/start - Welcome message\n/status - System status\n/proposals - View pending launches\n/approve ID - Approve a launch\n/reject ID - Reject a launch\n/scoring - How scoring works\n/launch - How launching works\n/guardian - What guardian monitors\n/narrative - AI narrative detection\n/config - Current thresholds\n/costs - Launch costs\n/heat - Market heat explained\n/help - This message`,
};

async function matchQuestion(text: string): Promise<string | null> {
  const lower = text.toLowerCase().trim();

  if (lower === "/start" || lower === "/help") return QA.greet;
  if (lower === "/status") return handleStatus();
  if (lower === "/proposals") return handleProposals();
  if (lower === "/scoring") return QA.score;
  if (lower === "/launch") return QA.launch;
  if (lower === "/guardian") return QA.guardian;
  if (lower === "/narrative") return QA.narrative;
  if (lower === "/config") return handleConfig();
  if (lower === "/costs" || lower === "/cost") return QA.cost;
  if (lower === "/heat") return QA.heat;

  if (lower.startsWith("/approve ")) {
    const id = lower.replace("/approve ", "").trim();
    return await handleApproveCommand(id);
  }
  if (lower.startsWith("/reject ")) {
    const id = lower.replace("/reject ", "").trim();
    return await handleRejectCommand(id);
  }

  if (lower === "hi" || lower === "hey" || lower === "hello" || lower === "yo" || lower === "sup" || lower === "reetings")
    return QA.greet;

  if (lower.includes("score") || lower.includes("scoring") || lower.includes("algorithm") || lower.includes("factor") || lower.includes("weighted") || lower.includes("rating") || lower.includes("decide") || lower.includes("determine") || lower.includes("how does it decide"))
    return QA.score;

  if (lower.includes("narrative") || lower.includes("theme") || lower.includes("trend") || lower.includes("gemini") || lower.includes("ai detect") || lower.includes("what's trending"))
    return QA.narrative;

  if (lower.includes("guard") || lower.includes("monitor") || lower.includes("rug") || lower.includes("scam") || lower.includes("protect") || lower.includes("stop loss") || lower.includes("take profit") || lower.includes("alert"))
    return QA.guardian;

  if (lower.includes("cost") || lower.includes("fee") || lower.includes("pay") || lower.includes("price") || lower.includes("how much") || lower.includes("expensive") || lower.includes("cheap") || lower.includes("sol"))
    return QA.cost;

  if (lower.includes("launch") || lower.includes("deploy") || lower.includes("create") || lower.includes("buy") || lower.includes("swap") || lower.includes("token") || lower.includes("pump") || lower.includes("raydium"))
    return QA.launch;

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
    const platform = (prop.platform as string) || "pumpfun";
    const cost = (prop.estimated_cost_sol as number) || 0.01;
    lines.push(
      `<b>$${symbol}</b> - ${conf.toFixed(0)}% confidence`,
      `Platform: ${platform} | Cost: ${cost} SOL`,
      `ID: <code>${p.decision_id}</code>`,
      ``
    );
  }
  lines.push(`Send /approve <id> or tap the buttons on the message.`);
  return lines.join("\n");
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
    `DEX: Uniswap`,
    `Launch: NOXA Fun`,
    `Guardian: Active`,
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

const QUESTION_BUTTONS: Array<Array<{ text: string; callback_data: string }>> = [
  [{ text: "What is COOKING?", callback_data: "q:what" }],
  [{ text: "How does it work?", callback_data: "q:how" }],
  [{ text: "How does scoring work?", callback_data: "q:score" }],
  [{ text: "AI Narrative Detection", callback_data: "q:narrative" }],
  [{ text: "How does launching work?", callback_data: "q:launch" }],
  [{ text: "What is the guardian?", callback_data: "q:guardian" }],
  [{ text: "What does it cost?", callback_data: "q:cost" }],
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

  if (isGroupChat(chatType) || isChannelChat(chatType)) {
    if (!isCommand && !isMentioned) {
      return;
    }
  }

  try {
    const reply = await matchQuestion(text);
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
      await sendMessage(chatId, `<b>Launch Approved</b>\nID: <code>${decisionId}</code>\n${result.message}`);
    }
  } else if (data.startsWith("reject:")) {
    const decisionId = data.split(":")[1];
    const result = await processApproval({ decision_id: decisionId, approved: false });
    await answerCallbackQuery(cb.id as string, result.success ? "Rejected!" : result.message);
    if (chatId && messageId) {
      await editMessageReplyMarkup(chatId, messageId, []);
      await sendMessage(chatId, `<b>Launch Rejected</b>\nID: <code>${decisionId}</code>\n${result.message}`);
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

export function startTelegramBot(): void {
  if (!getBotToken()) {
    console.log("[Telegram] No TELEGRAM_BOT_TOKEN set, bot disabled");
    return;
  }

  console.log(`[Telegram] Starting COOKING bot (chat IDs: ${getChatIds().join(", ")})`);
  console.log(`[Telegram] Group/Channel IDs: ${loadGroupIds().join(", ") || "none yet"}`);

  setInterval(pollUpdates, 3000);
  pollUpdates();
}

export async function sendProposalToTelegram(proposal: {
  decision_id: string;
  symbol: string;
  confidence: number;
  platform: string;
  estimated_cost_sol: number;
  reasoning: string;
}): Promise<void> {
  if (!getBotToken()) return;

  const allChatIds = getAllChatIds();
  if (allChatIds.length === 0) return;

  const confPct = (proposal.confidence * 100).toFixed(0);
  const text = [
    `🚀 <b>COOKING Proposal — $${proposal.symbol}</b>`,
    ``,
    `Confidence: <b>${confPct}%</b>`,
    `Platform: ${proposal.platform}`,
    `Cost: ${proposal.estimated_cost_sol} SOL`,
    ``,
    `<i>${proposal.reasoning}</i>`,
    ``,
    `ID: <code>${proposal.decision_id}</code>`,
  ].join("\n");

  const inlineKeyboard = [
    [
      { text: "Approve ✅", callback_data: `approve:${proposal.decision_id}` },
      { text: "Reject ❌", callback_data: `reject:${proposal.decision_id}` },
    ],
  ];

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
