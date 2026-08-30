import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const DATA_DIR = process.env.ORACLE_DATA_DIR || "data";

interface DedupState {
  tweet_hashes: Record<string, number>;
  reply_ids: string[];
  anchor_history: string[];
  last_anchor_time: Record<string, number>;
}

function getStatePath(): string {
  return join(DATA_DIR, "dedupe_state.json");
}

function loadState(): DedupState {
  const path = getStatePath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      /* ignore */
    }
  }
  return {
    tweet_hashes: {},
    reply_ids: [],
    anchor_history: [],
    last_anchor_time: {},
  };
}

function saveState(state: DedupState): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

export function isTweetDuplicate(tweetText: string): boolean {
  const state = loadState();
  const hash = createHash("sha256").update(tweetText).digest("hex");
  const postedAt = state.tweet_hashes[hash];
  if (!postedAt) return false;

  const windowMs =
    parseInt(process.env.ORACLE_TWEET_DEDUPE_WINDOW_HOURS || "24", 10) *
    3600 *
    1000;
  return Date.now() - postedAt < windowMs;
}

export function markTweetPosted(tweetText: string): void {
  const state = loadState();
  const hash = createHash("sha256").update(tweetText).digest("hex");
  state.tweet_hashes[hash] = Date.now();

  const cutoff =
    Date.now() -
    parseInt(process.env.ORACLE_TWEET_DEDUPE_WINDOW_HOURS || "24", 10) *
      3600 *
      1000;
  for (const [h, ts] of Object.entries(state.tweet_hashes)) {
    if (ts < cutoff) delete state.tweet_hashes[h];
  }

  saveState(state);
}

export function isReplyDuplicate(tweetId: string): boolean {
  const state = loadState();
  return state.reply_ids.includes(tweetId);
}

export function markReplyPosted(tweetId: string): void {
  const state = loadState();
  if (!state.reply_ids.includes(tweetId)) {
    state.reply_ids.push(tweetId);
  }
  if (state.reply_ids.length > 1000) {
    state.reply_ids = state.reply_ids.slice(-500);
  }
  saveState(state);
}

export function isAnchorCoolingDown(symbol: string): boolean {
  const state = loadState();
  const lastPost = state.last_anchor_time[symbol];
  if (!lastPost) return false;

  const cooldownMs =
    parseInt(
      process.env.ORACLE_ANCHOR_COOLDOWN_MINUTES || "10",
      10
    ) * 60 * 1000;
  return Date.now() - lastPost < cooldownMs;
}

export function markAnchorPosted(symbol: string): void {
  const state = loadState();
  state.last_anchor_time[symbol] = Date.now();
  state.anchor_history.push(symbol);

  const diversityN = parseInt(
    process.env.ORACLE_DIVERSITY_LAST_N || "2",
    10
  );
  if (state.anchor_history.length > diversityN * 2) {
    state.anchor_history = state.anchor_history.slice(-diversityN * 2);
  }

  saveState(state);
}

export function isDiverseAnchor(symbol: string): boolean {
  const state = loadState();
  const diversityN = parseInt(
    process.env.ORACLE_DIVERSITY_LAST_N || "2",
    10
  );
  const recent = state.anchor_history.slice(-diversityN);
  return !recent.includes(symbol);
}

export function clearState(): void {
  saveState({
    tweet_hashes: {},
    reply_ids: [],
    anchor_history: [],
    last_anchor_time: {},
  });
}
