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
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = (process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!botToken || chatIds.length === 0) return;

    const emoji =
      alert.severity === "critical"
        ? "\u{1F6A8}"
        : alert.severity === "warning"
          ? "\u26A0\uFE0F"
          : "\u2139\uFE0F";

    const text = [
      `${emoji} *COOKING Alert — $${symbol}*`,
      "",
      alert.message,
      "",
      `Mint: \`${mint}\``,
      `[View on Solscan](https://solscan.io/token/${mint})`,
    ].join("\n");

    for (const chatId of chatIds) {
      await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        }
      );
    }

    console.log(`[Alert] Telegram sent to ${chatIds.length} chat(s)`);
  } catch (err) {
    console.error("[Alert] Telegram send failed:", err);
  }
}
