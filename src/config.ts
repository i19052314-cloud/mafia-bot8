import "dotenv/config";
import type { AppConfig, GameSettings } from "./types.js";

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} должен быть целым числом от ${min} до ${max}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} должен быть true или false`);
}

export function defaultGameSettings(): GameSettings {
  const minPlayers = integer("MIN_PLAYERS", 5, 5, 20);
  return {
    minPlayers,
    maxPlayers: integer("MAX_PLAYERS", 30, minPlayers, 50),
    nightSeconds: integer("NIGHT_SECONDS", 45, 10, 3600),
    daySeconds: integer("DAY_SECONDS", 60, 10, 3600),
    nominationSeconds: integer("NOMINATION_SECONDS", 30, 10, 600),
    voteSeconds: integer("VOTE_SECONDS", 30, 10, 600),
    lastWordSeconds: integer("LAST_WORD_SECONDS", 15, 0, 300),
    revealDeadRoles: boolean("REVEAL_DEAD_ROLES", true),
    doctorSelfHeal: boolean("DOCTOR_SELF_HEAL", true),
    commissionerCanShoot: boolean("COMMISSIONER_CAN_SHOOT", false),
    allowSelfVote: boolean("ALLOW_SELF_VOTE", false),
    allowSkipVote: boolean("ALLOW_SKIP_VOTE", true),
    nominationsEnabled: boolean("NOMINATIONS_ENABLED", true),
    afkLimit: integer("AFK_LIMIT", 2, 0, 10),
    autoDeleteMessages: boolean("AUTO_DELETE_MESSAGES", false),
    roles: {
      don: boolean("ROLE_DON", true),
      commissar: boolean("ROLE_COMMISSAR", true),
      doctor: boolean("ROLE_DOCTOR", true),
      maniac: boolean("ROLE_MANIAC", true),
      bum: boolean("ROLE_BUM", true)
    }
  };
}

export function loadConfig(): AppConfig {
  const token = process.env.BOT_TOKEN?.trim() ?? "";
  if (!token || token.includes("replace_me")) {
    throw new Error("Не задан BOT_TOKEN. Скопируйте .env.example в .env и вставьте токен от @BotFather.");
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL должен быть адресом PostgreSQL вида postgresql://user:password@host:5432/database");
  }
  const logLevel = (process.env.LOG_LEVEL ?? "info") as AppConfig["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("LOG_LEVEL должен быть debug, info, warn или error");
  }

  return {
    token,
    databaseUrl,
    databaseSsl: boolean("DATABASE_SSL", false),
    defaults: defaultGameSettings(),
    betweenPhasesSeconds: integer("BETWEEN_PHASES_SECONDS", 7, 1, 60),
    brandName: process.env.BRAND_NAME?.trim() || "Mafia Noir",
    supportUsername: (process.env.SUPPORT_USERNAME?.trim() || "").replace(/^@/, ""),
    privacyContact: process.env.PRIVACY_CONTACT?.trim() || "укажите PRIVACY_CONTACT в .env",
    ownerTelegramId: process.env.OWNER_TELEGRAM_ID?.trim() || "",
    healthPort: integer("HEALTH_PORT", 0, 0, 65535),
    logLevel,
    assetsDirectory: process.env.ASSETS_DIR?.trim() || "./assets"
  };
}
