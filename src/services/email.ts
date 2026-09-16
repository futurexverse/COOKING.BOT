let resendClient: any = null;

function getClient(): any {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  try {
    const { Resend } = require("resend");
    resendClient = new Resend(apiKey);
    return resendClient;
  } catch {
    return null;
  }
}

export async function sendDepositEmail(
  to: string,
  walletAddress: string,
  amountEth: number,
  newBalance: number
): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.log("[Email] Resend not configured, skipping deposit email");
    return false;
  }

  try {
    await client.emails.send({
      from: "COOKING Bot <onboarding@resend.dev>",
      to,
      subject: `Deposit Confirmed — ${amountEth.toFixed(4)} ETH credited`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #fafafa; padding: 30px; border-radius: 12px;">
          <h1 style="color: #F59E0B; font-size: 24px;">Deposit Confirmed</h1>
          <p style="color: #a3a3a3; font-size: 14px;">Your COOKING wallet has been credited.</p>
          <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <p style="margin: 8px 0;"><strong style="color: #F59E0B;">Amount:</strong> ${amountEth.toFixed(4)} ETH</p>
            <p style="margin: 8px 0;"><strong style="color: #F59E0B;">New Balance:</strong> ${newBalance.toFixed(4)} ETH</p>
            <p style="margin: 8px 0;"><strong style="color: #F59E0B;">Wallet:</strong> <code style="color: #a3a3a3; font-size: 12px;">${walletAddress}</code></p>
          </div>
          <p style="color: #737373; font-size: 12px;">You can now trade tokens on Robinhood Chain and Solana via the COOKING bot.</p>
          <a href="https://cookingbot-production-bcf3.up.railway.app" style="display: inline-block; background: #F59E0B; color: #000; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 10px;">Open Dashboard</a>
        </div>
      `,
    });
    console.log(`[Email] Deposit confirmation sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err);
    return false;
  }
}

export async function sendWelcomeEmail(
  to: string,
  walletAddress: string
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    await client.emails.send({
      from: "COOKING Bot <onboarding@resend.dev>",
      to,
      subject: "Welcome to COOKING — Your wallet is ready",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a0a; color: #fafafa; padding: 30px; border-radius: 12px;">
          <h1 style="color: #F59E0B; font-size: 24px;">Welcome to COOKING</h1>
          <p style="color: #a3a3a3; font-size: 14px;">Your autonomous token sniper is ready.</p>
          <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <p style="margin: 8px 0;"><strong style="color: #F59E0B;">Your Wallet:</strong></p>
            <code style="color: #a3a3a3; font-size: 12px; word-break: break-all;">${walletAddress}</code>
          </div>
          <p style="color: #737373; font-size: 12px;">Send ETH to this address on Robinhood Chain or Solana to start trading.</p>
        </div>
      `,
    });
    return true;
  } catch {
    return false;
  }
}
