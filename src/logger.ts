/**
 * Centralized logging for TPS Notifier.
 * Debug/warn output is opt-in. Errors are always emitted with bounded, sanitized metadata.
 */
const PLUGIN_PREFIX = "[TPS Notifier]";

let loggingEnabled = false;
const recentMessages = new Map<string, number>();
const DEDUP_WINDOW_MS = 3000;
const MAX_RECENT_MESSAGES = 300;
const MAX_KEY_PART_LENGTH = 500;

export function setLoggingEnabled(value: boolean): void {
  const next = !!value;
  const changed = next !== loggingEnabled;
  loggingEnabled = next;
  if (changed && next) {
    console.log(`${PLUGIN_PREFIX} [Logger] Debug logging enabled — ${new Date().toISOString()}`);
  }
  if (!next) recentMessages.clear();
}

export function isLoggingEnabled(): boolean {
  return loggingEnabled;
}

function shouldLog(level: string, message: string, params: any[]): boolean {
  const tail = params
    .map(p => {
      if (p instanceof Error) return p.message;
      if (typeof p === "string") return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    })
    .map(value => value.length > MAX_KEY_PART_LENGTH ? value.slice(0, MAX_KEY_PART_LENGTH) : value)
    .join("|");
  const key = `${level}:${message}:${tail}`;
  const now = Date.now();
  const last = recentMessages.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  while (recentMessages.size >= MAX_RECENT_MESSAGES) {
    const oldest = recentMessages.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recentMessages.delete(oldest);
  }
  recentMessages.set(key, now);
  return true;
}

function log(message?: any, ...rest: any[]): void {
  if (!loggingEnabled) return;
  const msg = typeof message === "string" ? message : String(message ?? "");
  if (!shouldLog("log", msg, rest)) return;
  console.log(`${PLUGIN_PREFIX} ${msg}`, ...rest);
}

function warn(message?: any, ...rest: any[]): void {
  if (!loggingEnabled) return;
  const msg = typeof message === "string" ? message : String(message ?? "");
  if (!shouldLog("warn", msg, rest)) return;
  console.warn(`${PLUGIN_PREFIX} ${msg}`, ...rest);
}

function error(message?: any, ...rest: any[]): void {
  // Always log errors regardless of toggle
  const msg = typeof message === "string" ? message : String(message ?? "");
  if (!shouldLog("error", msg, rest)) return;
  console.error(`${PLUGIN_PREFIX} ${msg}`, ...rest);
}

function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      ...(err.name === 'NotifierError' ? { message: err.message } : {}),
    };
  }
  return { type: typeof err };
}

export function flow(scope: string, event: string, data?: Record<string, unknown>): void {
  log(`[${scope}] ${event}`, data || {});
}

export function flowWarn(scope: string, event: string, data?: Record<string, unknown>): void {
  warn(`[${scope}] ${event}`, data || {});
}

export function flowError(scope: string, event: string, err: unknown, data?: Record<string, unknown>): void {
  error(`[${scope}] ${event}`, {
    ...(data || {}),
    error: errorSummary(err),
  });
}
