export const ROLES = {
  citizen: { title: "Мирный житель", emoji: "👨", side: "town" },
  mafia: { title: "Мафия", emoji: "🔪", side: "mafia" },
  don: { title: "Дон", emoji: "🤵", side: "mafia" },
  commissar: { title: "Комиссар", emoji: "👮", side: "town" },
  doctor: { title: "Доктор", emoji: "👨‍⚕️", side: "town" },
  maniac: { title: "Маньяк", emoji: "🪓", side: "neutral" },
  bum: { title: "Бомж", emoji: "🧔", side: "town" },
  kamikaze: { title: "Камикадзе", emoji: "💣", side: "town" },
  sergeant: { title: "Сержант", emoji: "🎖️", side: "town" },
  lawyer: { title: "Адвокат", emoji: "🎩", side: "mafia" },
  lucky: { title: "Счастливчик", emoji: "🍀", side: "town" },
  suicide: { title: "Самоубийца", emoji: "💀", side: "neutral" },
  mistress: { title: "Любовница", emoji: "💋", side: "neutral" }
} as const;

export type Role = keyof typeof ROLES;
export type Side = (typeof ROLES)[Role]["side"];
export type GameStatus = "lobby" | "running" | "finished" | "cancelled";
export type ActivePhase = "night" | "day" | "nomination" | "vote" | "last_word";
export type Phase = "lobby" | ActivePhase | "paused" | "finished";
export type ActionType =
  | "mafia_kill"
  | "don_check"
  | "commissar_check"
  | "commissar_shoot"
  | "doctor_heal"
  | "maniac_kill"
  | "bum_visit"
  | "lawyer_defend"
  | "mistress_visit";
export type Winner = "town" | "mafia" | "maniac" | "suicide" | "mistress";

export interface RoleSettings {
  don: boolean;
  commissar: boolean;
  doctor: boolean;
  maniac: boolean;
  bum: boolean;
  kamikaze: boolean;
  sergeant: boolean;
  lawyer: boolean;
  lucky: boolean;
  suicide: boolean;
  mistress: boolean;
}

export interface GameSettings {
  minPlayers: number;
  maxPlayers: number;
  nightSeconds: number;
  daySeconds: number;
  nominationSeconds: number;
  voteSeconds: number;
  lastWordSeconds: number;
  revealDeadRoles: boolean;
  doctorSelfHeal: boolean;
  commissionerCanShoot: boolean;
  allowSelfVote: boolean;
  allowSkipVote: boolean;
  nominationsEnabled: boolean;
  afkLimit: number;
  autoDeleteMessages: boolean;
  friendlyFire: boolean;
  roles: RoleSettings;
}

export interface GameRow {
  id: number;
  chat_id: string;
  chat_title: string;
  host_id: string;
  status: GameStatus;
  phase: Phase;
  day: number;
  phase_ends_at: number | null;
  paused_phase: ActivePhase | null;
  paused_remaining_ms: number | null;
  pending_elimination_id: string | null;
  lobby_message_id: number | null;
  winner: Winner | null;
  settings: GameSettings;
  created_at: number;
  started_at: number | null;
  updated_at: number;
}

export interface PlayerRow {
  game_id: number;
  user_id: string;
  username: string | null;
  first_name: string;
  role: Role | null;
  alive: number;
  afk_strikes: number;
  lucky_shield: number;
  joined_at: number;
}

export interface ActionRow {
  game_id: number;
  day: number;
  actor_id: string;
  type: ActionType;
  target_id: string;
  created_at: number;
}

export interface VoteRow {
  game_id: number;
  day: number;
  voter_id: string;
  target_id: string;
  created_at: number;
}

export interface NominationRow {
  game_id: number;
  day: number;
  nominator_id: string;
  target_id: string;
  created_at: number;
}

export interface UserStats {
  games: number;
  wins: number;
  town_wins: number;
  mafia_wins: number;
  maniac_wins: number;
}

export type Currency = "money" | "gems";

export const SHOP_ITEMS = {
  documents: {
    title: "📂 Документы",
    price: 150,
    currency: "money",
    description: "Фальшивые документы могут пригодиться когда твою роль кто-то захочет проверить"
  },
  protection: {
    title: "🛡 Защита",
    price: 100,
    currency: "money",
    description: "Один раз может спасти тебе жизнь"
  },
  active_role: {
    title: "🎭 Активная роль",
    price: 1,
    currency: "gems",
    description: "Даёт 99% шанс выпадения активной роли"
  }
} as const;

export type ShopItem = keyof typeof SHOP_ITEMS;

export interface UserProfile {
  user_id: string;
  money: number;
  gems: number;
  protection: number;
  documents: number;
  active_role: number;
}

export interface AppConfig {
  token: string;
  databaseUrl: string;
  databaseSsl: boolean;
  defaults: GameSettings;
  betweenPhasesSeconds: number;
  brandName: string;
  supportUsername: string;
  privacyContact: string;
  ownerTelegramId: string;
  healthPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
  assetsDirectory: string;
}
