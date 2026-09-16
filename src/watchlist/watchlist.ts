import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const WATCHLIST_FILE = join(ROOT_DIR, "data", "watchlist.json");

interface WatchlistEntry {
  address: string;
  chain: string;
  symbol: string;
  name: string;
  addedAt: number;
}

interface WatchlistDB {
  [email: string]: WatchlistEntry[];
}

let db: WatchlistDB = {};

function load(): void {
  try {
    if (existsSync(WATCHLIST_FILE)) {
      db = JSON.parse(readFileSync(WATCHLIST_FILE, "utf-8"));
    }
  } catch {}
}

function save(): void {
  const dir = dirname(WATCHLIST_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(WATCHLIST_FILE, JSON.stringify(db, null, 2));
}

load();

export function addToWatchlist(
  email: string,
  address: string,
  chain: string,
  symbol: string,
  name: string
): boolean {
  if (!db[email]) db[email] = [];

  const exists = db[email].some(
    (e) => e.address.toLowerCase() === address.toLowerCase()
  );
  if (exists) return false;

  db[email].push({ address, chain, symbol, name, addedAt: Date.now() });
  save();
  return true;
}

export function removeFromWatchlist(email: string, address: string): boolean {
  if (!db[email]) return false;
  const before = db[email].length;
  db[email] = db[email].filter(
    (e) => e.address.toLowerCase() !== address.toLowerCase()
  );
  save();
  return db[email].length < before;
}

export function getWatchlist(email: string): WatchlistEntry[] {
  return db[email] || [];
}

export function isWatched(email: string, address: string): boolean {
  if (!db[email]) return false;
  return db[email].some(
    (e) => e.address.toLowerCase() === address.toLowerCase()
  );
}
