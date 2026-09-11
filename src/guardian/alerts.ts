export interface GuardianAlert {
  type: string;
  message: string;
  timestamp: number;
  severity: "info" | "warning" | "critical";
}

const alertCooldowns = new Map<string, number>();

function canAlert(alertKey: string): boolean {
  const cooldownMs = parseInt(
    process.env.GUARDIAN_ALERT_COOLDOWN_SECONDS || "300",
    10
  ) * 1000;

  const lastAlert = alertCooldowns.get(alertKey);
  if (lastAlert && Date.now() - lastAlert < cooldownMs) {
    return false;
  }

  alertCooldowns.set(alertKey, Date.now());
  return true;
}

export async function dispatchAlert(
  alert: GuardianAlert,
  symbol: string,
  mint: string
): Promise<void> {
  const alertKey = `${mint}:${alert.type}`;
  if (!canAlert(alertKey)) {
    console.log(`[Alert] Cooldown active for ${alertKey}, skipping`);
    return;
  }

  console.log(
    `[Alert] [${alert.severity.toUpperCase()}] $${symbol}: ${alert.message}`
  );

  if (
    process.env.GUARDIAN_TELEGRAM_ENABLED !== "false" &&
    process.env.TELEGRAM_BOT_TOKEN
  ) {
    await sendTelegramAlert(alert, symbol, mint);
  }
}

async function sendTelegramAlert(
  alert: GuardianAlert,
  symbol: string,
  mint: string
): Promise<void> {
  try {
    const { getAllChatIds } = await import("../social/telegram-bot.js");

    const allChatIds = getAllChatIds();
    if (allChatIds.length === 0) return;

    const emoji =
      alert.severity === "critical"
        ? "\u{1F6A8}"
        : alert.severity === "warning"
          ? "\u26A0\uFE0F"
          : "\u2139\uFE0F";

    const text = [
      `${emoji} <b>GUARDIAN ALERT — $${symbol}</b>`,
      "",
      alert.message,
      "",
      `Contract: <code>${mint}</code>`,
      `<a href="https://dexscreener.com/robinhood/${mint}">View on Dexscreener</a>`,
      `<a href="https://robinhoodchain.blockscout.com/address/${mint}">View on Blockscout</a>`,
    ].join("\n");

    for (const chatId of allChatIds) {
      await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        }
      );
    }

    console.log(`[Alert] Telegram sent to ${allChatIds.length} chats`);
  } catch (err) {
    console.error("[Alert] Telegram send failed:", err);
  }
}
