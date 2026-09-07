import type { AppConfig } from "./types.js";

type Level = AppConfig["logLevel"];
const priorities: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly level: Level) {}

  debug(message: string, meta?: unknown): void { this.write("debug", message, meta); }
  info(message: string, meta?: unknown): void { this.write("info", message, meta); }
  warn(message: string, meta?: unknown): void { this.write("warn", message, meta); }
  error(message: string, meta?: unknown): void { this.write("error", message, meta); }

  private write(level: Level, message: string, meta?: unknown): void {
    if (priorities[level] < priorities[this.level]) return;
    const suffix = meta === undefined ? "" : ` ${formatMeta(meta)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

function formatMeta(meta: unknown): string {
  if (meta instanceof Error) return JSON.stringify({ name: meta.name, message: meta.message, stack: meta.stack });
  try { return JSON.stringify(meta); } catch { return String(meta); }
}
