import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const USERS_FILE = join(ROOT_DIR, "data", "users.json");

const JWT_SECRET = process.env.JWT_SECRET || "cooking-secret-key-change-in-production";
const SALT_ROUNDS = 10;

interface UserTrade {
  txHash: string;
  type: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol?: string;
  amountIn: string;
  amountOut: string;
  ethSpent?: string;
  ethReceived?: string;
  timestamp: number;
  status: "success" | "failed";
}

interface User {
  email: string;
  passwordHash: string;
  depositedEth: number;
  tradeHistory: UserTrade[];
  chatId?: number;
  createdAt: number;
}

interface UsersDB {
  users: Record<string, User>;
}

let db: UsersDB = { users: {} };

function ensureDataDir(): void {
  const dir = dirname(USERS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadUsers(): void {
  try {
    if (existsSync(USERS_FILE)) {
      db = JSON.parse(readFileSync(USERS_FILE, "utf-8"));
    }
  } catch {}
}

function saveUsers(): void {
  ensureDataDir();
  writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}

loadUsers();

export async function signup(email: string, password: string): Promise<{ success: boolean; token?: string; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  if (db.users[normalizedEmail]) {
    return { success: false, error: "Email already registered" };
  }

  if (password.length < 6) {
    return { success: false, error: "Password must be at least 6 characters" };
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  db.users[normalizedEmail] = {
    email: normalizedEmail,
    passwordHash,
    depositedEth: 0,
    tradeHistory: [],
    createdAt: Date.now(),
  };

  saveUsers();

  const token = jwt.sign({ email: normalizedEmail }, JWT_SECRET, { expiresIn: "30d" });
  console.log(`[Auth] New user signed up: ${normalizedEmail}`);

  return { success: true, token };
}

export async function login(email: string, password: string): Promise<{ success: boolean; token?: string; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const user = db.users[normalizedEmail];

  if (!user) {
    return { success: false, error: "Invalid email or password" };
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return { success: false, error: "Invalid email or password" };
  }

  const token = jwt.sign({ email: normalizedEmail }, JWT_SECRET, { expiresIn: "30d" });
  console.log(`[Auth] User logged in: ${normalizedEmail}`);

  return { success: true, token };
}

export function verifyToken(token: string): { email: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string };
    return { email: decoded.email };
  } catch {
    return null;
  }
}

export function getUser(email: string): { email: string; depositedEth: number; tradeHistory: UserTrade[]; createdAt: number } | null {
  const user = db.users[email.toLowerCase().trim()];
  if (!user) return null;
  return {
    email: user.email,
    depositedEth: user.depositedEth,
    tradeHistory: user.tradeHistory,
    createdAt: user.createdAt,
  };
}

export function recordDeposit(email: string, amountEth: number): boolean {
  const user = db.users[email.toLowerCase().trim()];
  if (!user) return false;
  user.depositedEth += amountEth;
  saveUsers();
  console.log(`[Auth] Deposit recorded: ${email} deposited ${amountEth} ETH (total: ${user.depositedEth})`);
  return true;
}

export function addTradeToUser(email: string, trade: UserTrade): boolean {
  const user = db.users[email.toLowerCase().trim()];
  if (!user) return false;
  user.tradeHistory.push(trade);
  if (user.tradeHistory.length > 200) {
    user.tradeHistory = user.tradeHistory.slice(-200);
  }
  saveUsers();
  return true;
}

export function getUserTradeHistory(email: string): UserTrade[] {
  const user = db.users[email.toLowerCase().trim()];
  return user?.tradeHistory || [];
}

export function getUserDepositedEth(email: string): number {
  const user = db.users[email.toLowerCase().trim()];
  return user?.depositedEth || 0;
}

export function getAllUserEmails(): string[] {
  return Object.keys(db.users);
}

export function getUserByChatId(chatId: number): { email: string; depositedEth: number; tradeHistory: UserTrade[] } | null {
  for (const user of Object.values(db.users)) {
    if (user.chatId === chatId) {
      return { email: user.email, depositedEth: user.depositedEth, tradeHistory: user.tradeHistory };
    }
  }
  return null;
}

export function setUserChatId(email: string, chatId: number): boolean {
  const user = db.users[email.toLowerCase().trim()];
  if (!user) return false;
  user.chatId = chatId;
  saveUsers();
  console.log(`[Auth] Linked chatId ${chatId} to ${email}`);
  return true;
}

export function authenticateRequest(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  return decoded?.email || null;
}
