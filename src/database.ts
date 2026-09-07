import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  ActionRow,
  ActionType,
  ActivePhase,
  Currency,
  GameRow,
  GameSettings,
  NominationRow,
  Phase,
  PlayerRow,
  Role,
  ShopItem,
  UserProfile,
  UserStats,
  VoteRow,
  Winner
} from "./types.js";

export interface TelegramUserData {
  id: string;
  username?: string;
  firstName: string;
}

export class GameDatabase {
  readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly defaultSettings: GameSettings,
    ssl = false,
    pool?: Pool
  ) {
    const config: PoolConfig = {
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: ssl ? { rejectUnauthorized: false } : undefined
    };
    this.pool = pool ?? new Pool(config);
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id TEXT PRIMARY KEY,
        settings JSONB NOT NULL,
        updated_at DOUBLE PRECISION NOT NULL
      );

      CREATE TABLE IF NOT EXISTS games (
        id SERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL DEFAULT '',
        host_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('lobby','running','finished','cancelled')),
        phase TEXT NOT NULL CHECK (phase IN ('lobby','night','day','nomination','vote','last_word','paused','finished')),
        day INTEGER NOT NULL DEFAULT 0,
        phase_ends_at DOUBLE PRECISION,
        paused_phase TEXT CHECK (paused_phase IS NULL OR paused_phase IN ('night','day','nomination','vote','last_word')),
        paused_remaining_ms DOUBLE PRECISION,
        pending_elimination_id TEXT,
        lobby_message_id INTEGER,
        winner TEXT CHECK (winner IS NULL OR winner IN ('town','mafia','maniac')),
        settings JSONB NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        started_at DOUBLE PRECISION,
        updated_at DOUBLE PRECISION NOT NULL
      );

      ALTER TABLE games ADD COLUMN IF NOT EXISTS started_at DOUBLE PRECISION;

      CREATE UNIQUE INDEX IF NOT EXISTS games_one_active_per_chat
      ON games(chat_id) WHERE status IN ('lobby','running');

      CREATE TABLE IF NOT EXISTS game_players (
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        username TEXT,
        first_name TEXT NOT NULL,
        role TEXT CHECK (role IS NULL OR role IN ('citizen','mafia','don','commissar','doctor','maniac','bum','kamikaze')),
        alive INTEGER NOT NULL DEFAULT 1,
        afk_strikes INTEGER NOT NULL DEFAULT 0,
        joined_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (game_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS actions (
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        day INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('mafia_kill','don_check','commissar_check','commissar_shoot','doctor_heal','maniac_kill','bum_visit')),
        target_id TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (game_id, day, actor_id, type)
      );

      CREATE TABLE IF NOT EXISTS votes (
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        day INTEGER NOT NULL,
        voter_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (game_id, day, voter_id)
      );

      CREATE TABLE IF NOT EXISTS nominations (
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        day INTEGER NOT NULL,
        nominator_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (game_id, day, nominator_id)
      );

      CREATE TABLE IF NOT EXISTS game_messages (
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at DOUBLE PRECISION NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_log_chat_created ON audit_log(chat_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS user_stats (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        town_wins INTEGER NOT NULL DEFAULT 0,
        mafia_wins INTEGER NOT NULL DEFAULT 0,
        maniac_wins INTEGER NOT NULL DEFAULT 0,
        updated_at DOUBLE PRECISION NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_economy (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT NOT NULL,
        money INTEGER NOT NULL DEFAULT 1000,
        gems INTEGER NOT NULL DEFAULT 0,
        protection INTEGER NOT NULL DEFAULT 0,
        documents INTEGER NOT NULL DEFAULT 0,
        active_role INTEGER NOT NULL DEFAULT 0,
        updated_at DOUBLE PRECISION NOT NULL
      );
    `);
  }

  async ping(): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async createGame(chatId: string, chatTitle: string, host: TelegramUserData): Promise<GameRow> {
    return this.transaction(async (client) => {
      const settings = await this.getChatSettings(chatId, client);
      const now = Date.now();
      const result = await client.query(`
        INSERT INTO games (chat_id, chat_title, host_id, status, phase, day, settings, created_at, updated_at)
        VALUES ($1, $2, $3, 'lobby', 'lobby', 0, $4::jsonb, $5, $5)
        RETURNING *
      `, [chatId, chatTitle, host.id, JSON.stringify(settings), now]);
      const game = normalizeGame(result.rows[0]);
      await this.addPlayer(game.id, host, client);
      return game;
    });
  }

  async getGame(id: number, client: Queryable = this.pool): Promise<GameRow | undefined> {
    const result = await client.query("SELECT * FROM games WHERE id = $1", [id]);
    return result.rows[0] ? normalizeGame(result.rows[0]) : undefined;
  }

  async getActiveGameByChat(chatId: string): Promise<GameRow | undefined> {
    const result = await this.pool.query(`
      SELECT * FROM games WHERE chat_id = $1 AND status IN ('lobby','running') ORDER BY id DESC LIMIT 1
    `, [chatId]);
    return result.rows[0] ? normalizeGame(result.rows[0]) : undefined;
  }

  async getLobby(id: number): Promise<GameRow | undefined> {
    const result = await this.pool.query("SELECT * FROM games WHERE id = $1 AND status = 'lobby'", [id]);
    return result.rows[0] ? normalizeGame(result.rows[0]) : undefined;
  }

  async getRunningGames(): Promise<GameRow[]> {
    const result = await this.pool.query("SELECT * FROM games WHERE status = 'running'");
    return result.rows.map(normalizeGame);
  }

  async getRunningGamesForPlayer(userId: string): Promise<GameRow[]> {
    const result = await this.pool.query(`
      SELECT g.* FROM games g
      JOIN game_players gp ON gp.game_id = g.id
      WHERE g.status = 'running' AND gp.user_id = $1 AND gp.alive = 1
      ORDER BY g.id DESC
    `, [userId]);
    return result.rows.map(normalizeGame);
  }

  async joinLobby(gameId: number, user: TelegramUserData): Promise<"joined" | "existing" | "full" | "closed"> {
    return this.transaction(async (client) => {
      const gameResult = await client.query("SELECT status, settings FROM games WHERE id = $1 FOR UPDATE", [gameId]);
      const row = gameResult.rows[0];
      if (!row || row.status !== "lobby") return "closed";
      const existing = await client.query("SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2", [gameId, user.id]);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM game_players WHERE game_id = $1", [gameId]);
      const settings = normalizeSettings(row.settings, this.defaultSettings);
      if (!existing.rowCount && Number(count.rows[0]?.count ?? 0) >= settings.maxPlayers) return "full";
      await this.addPlayer(gameId, user, client);
      return existing.rowCount ? "existing" : "joined";
    });
  }

  async addPlayer(gameId: number, user: TelegramUserData, client: Queryable = this.pool): Promise<void> {
    await client.query(`
      INSERT INTO game_players (game_id, user_id, username, first_name, joined_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(game_id, user_id) DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name
    `, [gameId, user.id, user.username ?? null, user.firstName, Date.now()]);
    await this.touchUser(user, client);
  }

  async removePlayerFromLobby(gameId: number, userId: string): Promise<"removed" | "missing" | "closed"> {
    return this.transaction(async (client) => {
      const game = await client.query("SELECT status FROM games WHERE id = $1 FOR UPDATE", [gameId]);
      if (!game.rows[0] || game.rows[0].status !== "lobby") return "closed";
      const result = await client.query("DELETE FROM game_players WHERE game_id = $1 AND user_id = $2", [gameId, userId]);
      return result.rowCount ? "removed" : "missing";
    });
  }

  async getPlayers(gameId: number, aliveOnly = false, client: Queryable = this.pool): Promise<PlayerRow[]> {
    const result = await client.query(
      `SELECT * FROM game_players WHERE game_id = $1 ${aliveOnly ? "AND alive = 1" : ""} ORDER BY joined_at, user_id`,
      [gameId]
    );
    return result.rows as PlayerRow[];
  }

  async getPlayer(gameId: number, userId: string): Promise<PlayerRow | undefined> {
    const result = await this.pool.query("SELECT * FROM game_players WHERE game_id = $1 AND user_id = $2", [gameId, userId]);
    return result.rows[0] as PlayerRow | undefined;
  }

  async setLobbyMessage(gameId: number, messageId: number): Promise<void> {
    await this.pool.query("UPDATE games SET lobby_message_id = $1, updated_at = $2 WHERE id = $3", [messageId, Date.now(), gameId]);
  }

  async assignRoles(gameId: number, assignments: Map<string, Role>): Promise<void> {
    await this.transaction(async (client) => {
      for (const [userId, role] of assignments) {
        await client.query("UPDATE game_players SET role = $1, alive = 1, afk_strikes = 0 WHERE game_id = $2 AND user_id = $3", [role, gameId, userId]);
      }
    });
  }

  async setPhase(gameId: number, phase: Phase, day: number, endsAt: number | null): Promise<void> {
    await this.pool.query(`
      UPDATE games SET status = CASE WHEN $1 = 'finished' THEN 'finished' ELSE 'running' END,
        phase = $1, day = $2, phase_ends_at = $3, paused_phase = NULL,
        paused_remaining_ms = NULL, updated_at = $4 WHERE id = $5
    `, [phase, day, endsAt, Date.now(), gameId]);
  }

  async startGame(gameId: number, firstNightEndsAt: number): Promise<boolean> {
    const now = Date.now();
    const result = await this.pool.query(`
      UPDATE games SET status = 'running', phase = 'night', day = 1,
        phase_ends_at = $1, started_at = $2, updated_at = $2 WHERE id = $3 AND status = 'lobby'
    `, [firstNightEndsAt, now, gameId]);
    return (result.rowCount ?? 0) > 0;
  }

  async pauseGame(gameId: number, pausedPhase: ActivePhase, remainingMs: number): Promise<void> {
    await this.pool.query(`
      UPDATE games SET phase = 'paused', phase_ends_at = NULL, paused_phase = $1,
        paused_remaining_ms = $2, updated_at = $3 WHERE id = $4 AND status = 'running'
    `, [pausedPhase, remainingMs, Date.now(), gameId]);
  }

  async resumeGame(gameId: number): Promise<GameRow | undefined> {
    return this.transaction(async (client) => {
      const game = await this.getGame(gameId, client);
      if (!game || game.phase !== "paused" || !game.paused_phase) return undefined;
      const endsAt = Date.now() + Math.max(1_000, game.paused_remaining_ms ?? 1_000);
      await client.query(`
        UPDATE games SET phase = $1, phase_ends_at = $2, paused_phase = NULL,
          paused_remaining_ms = NULL, updated_at = $3 WHERE id = $4
      `, [game.paused_phase, endsAt, Date.now(), game.id]);
      return this.getGame(game.id, client);
    });
  }

  async extendPhase(gameId: number, milliseconds: number): Promise<GameRow | undefined> {
    await this.pool.query(`
      UPDATE games SET phase_ends_at = GREATEST(COALESCE(phase_ends_at, $1), $1) + $2,
        updated_at = $1 WHERE id = $3 AND status = 'running' AND phase <> 'paused'
    `, [Date.now(), milliseconds, gameId]);
    return this.getGame(gameId);
  }

  async setPendingElimination(gameId: number, userId: string | null): Promise<void> {
    await this.pool.query("UPDATE games SET pending_elimination_id = $1, updated_at = $2 WHERE id = $3", [userId, Date.now(), gameId]);
  }

  async transferHost(gameId: number, userId: string): Promise<void> {
    await this.pool.query("UPDATE games SET host_id = $1, updated_at = $2 WHERE id = $3", [userId, Date.now(), gameId]);
  }

  async cancelGame(gameId: number): Promise<void> {
    await this.pool.query(`
      UPDATE games SET status = 'cancelled', phase = 'finished', phase_ends_at = NULL,
        pending_elimination_id = NULL, updated_at = $1 WHERE id = $2
    `, [Date.now(), gameId]);
  }

  async recordAction(gameId: number, day: number, actorId: string, type: ActionType, targetId: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO actions (game_id, day, actor_id, type, target_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(game_id, day, actor_id, type) DO UPDATE SET
        target_id = EXCLUDED.target_id,
        created_at = EXCLUDED.created_at
    `, [gameId, day, actorId, type, targetId, Date.now()]);
  }

  async tryRecordCommissionerAction(gameId: number, day: number, actorId: string, type: "commissar_check" | "commissar_shoot", targetId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query("SELECT user_id FROM game_players WHERE game_id = $1 AND user_id = $2 FOR UPDATE", [gameId, actorId]);
      const existing = await client.query(`
        SELECT 1 FROM actions WHERE game_id = $1 AND day = $2 AND actor_id = $3
          AND type IN ('commissar_check','commissar_shoot') LIMIT 1
      `, [gameId, day, actorId]);
      if (existing.rowCount) return false;
      await client.query(`
        INSERT INTO actions (game_id, day, actor_id, type, target_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [gameId, day, actorId, type, targetId, Date.now()]);
      return true;
    });
  }

  async getActions(gameId: number, day: number, type?: ActionType): Promise<ActionRow[]> {
    const result = type
      ? await this.pool.query("SELECT * FROM actions WHERE game_id = $1 AND day = $2 AND type = $3", [gameId, day, type])
      : await this.pool.query("SELECT * FROM actions WHERE game_id = $1 AND day = $2", [gameId, day]);
    return result.rows as ActionRow[];
  }

  async getPreviousTarget(gameId: number, actorId: string, type: ActionType, beforeDay: number): Promise<string | undefined> {
    const result = await this.pool.query(`
      SELECT target_id FROM actions WHERE game_id = $1 AND actor_id = $2 AND type = $3 AND day < $4
      ORDER BY day DESC LIMIT 1
    `, [gameId, actorId, type, beforeDay]);
    return result.rows[0]?.target_id as string | undefined;
  }

  async killPlayers(gameId: number, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.pool.query("UPDATE game_players SET alive = 0 WHERE game_id = $1 AND user_id = ANY($2::text[])", [gameId, userIds]);
  }

  async setAfkStrikes(gameId: number, userId: string, strikes: number): Promise<void> {
    await this.pool.query("UPDATE game_players SET afk_strikes = $1 WHERE game_id = $2 AND user_id = $3", [strikes, gameId, userId]);
  }

  async recordNomination(gameId: number, day: number, nominatorId: string, targetId: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO nominations (game_id, day, nominator_id, target_id, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(game_id, day, nominator_id) DO UPDATE SET target_id = EXCLUDED.target_id, created_at = EXCLUDED.created_at
    `, [gameId, day, nominatorId, targetId, Date.now()]);
  }

  async getNominations(gameId: number, day: number): Promise<NominationRow[]> {
    const result = await this.pool.query("SELECT * FROM nominations WHERE game_id = $1 AND day = $2", [gameId, day]);
    return result.rows as NominationRow[];
  }

  async recordVote(gameId: number, day: number, voterId: string, targetId: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO votes (game_id, day, voter_id, target_id, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(game_id, day, voter_id) DO UPDATE SET target_id = EXCLUDED.target_id, created_at = EXCLUDED.created_at
    `, [gameId, day, voterId, targetId, Date.now()]);
  }

  async getVotes(gameId: number, day: number): Promise<VoteRow[]> {
    const result = await this.pool.query("SELECT * FROM votes WHERE game_id = $1 AND day = $2", [gameId, day]);
    return result.rows as VoteRow[];
  }

  async finishGame(gameId: number, winner: Winner): Promise<void> {
    await this.transaction(async (client) => {
      const game = await this.getGame(gameId, client);
      if (!game || game.status === "finished") return;
      const players = await this.getPlayers(gameId, false, client);
      await client.query(`
        UPDATE games SET status = 'finished', phase = 'finished', winner = $1,
          phase_ends_at = NULL, pending_elimination_id = NULL, updated_at = $2 WHERE id = $3
      `, [winner, Date.now(), gameId]);

      for (const player of players) {
        const won = player.role === "maniac"
          ? winner === "maniac"
          : player.role === "mafia" || player.role === "don"
            ? winner === "mafia"
            : winner === "town";
        await client.query(`
          UPDATE user_stats SET games = games + 1, wins = wins + $1,
            town_wins = town_wins + $2, mafia_wins = mafia_wins + $3,
            maniac_wins = maniac_wins + $4, updated_at = $5 WHERE user_id = $6
        `, [
          won ? 1 : 0,
          won && winner === "town" ? 1 : 0,
          won && winner === "mafia" ? 1 : 0,
          won && winner === "maniac" ? 1 : 0,
          Date.now(),
          player.user_id
        ]);
      }
    });
  }

  async getStats(userId: string): Promise<UserStats | undefined> {
    const result = await this.pool.query(`
      SELECT games, wins, town_wins, mafia_wins, maniac_wins FROM user_stats WHERE user_id = $1
    `, [userId]);
    return result.rows[0] as UserStats | undefined;
  }

  async getLeaderboard(limit = 10): Promise<Array<UserStats & { user_id: string; username: string | null; first_name: string }>> {
    const result = await this.pool.query(`
      SELECT user_id, username, first_name, games, wins, town_wins, mafia_wins, maniac_wins
      FROM user_stats WHERE games > 0
      ORDER BY wins DESC, (wins::float / games) DESC, games DESC LIMIT $1
    `, [limit]);
    return result.rows;
  }

  async getProfile(user: TelegramUserData): Promise<UserProfile> {
    const result = await this.pool.query(`
      INSERT INTO user_economy (user_id, username, first_name, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(user_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
      RETURNING user_id, money, gems, protection, documents, active_role
    `, [user.id, user.username ?? null, user.firstName, Date.now()]);
    return normalizeProfile(result.rows[0]);
  }

  async buyShopItem(user: TelegramUserData, item: ShopItem, price: number, currency: Currency): Promise<{ ok: boolean; profile: UserProfile }> {
    const balanceColumn = currency === "gems" ? "gems" : "money";
    return this.transaction(async (client) => {
      await client.query(`
        INSERT INTO user_economy (user_id, username, first_name, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(user_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
      `, [user.id, user.username ?? null, user.firstName, Date.now()]);

      const current = await client.query(
        "SELECT user_id, money, gems, protection, documents, active_role FROM user_economy WHERE user_id = $1 FOR UPDATE",
        [user.id]
      );
      const profile = normalizeProfile(current.rows[0]);
      if (profile[balanceColumn] < price) return { ok: false, profile };

      const result = await client.query(`
        UPDATE user_economy SET ${balanceColumn} = ${balanceColumn} - $1, ${item} = ${item} + 1, updated_at = $2
        WHERE user_id = $3
        RETURNING user_id, money, gems, protection, documents, active_role
      `, [price, Date.now(), user.id]);
      return { ok: true, profile: normalizeProfile(result.rows[0]) };
    });
  }

  async getChatSettings(chatId: string, client: Queryable = this.pool): Promise<GameSettings> {
    const result = await client.query("SELECT settings FROM chat_settings WHERE chat_id = $1", [chatId]);
    if (result.rows[0]?.settings) return normalizeSettings(result.rows[0].settings, this.defaultSettings);
    await client.query(`
      INSERT INTO chat_settings (chat_id, settings, updated_at) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT(chat_id) DO NOTHING
    `, [chatId, JSON.stringify(this.defaultSettings), Date.now()]);
    return structuredClone(this.defaultSettings);
  }

  async updateChatSettings(chatId: string, settings: GameSettings): Promise<void> {
    await this.transaction(async (client) => {
      const now = Date.now();
      const json = JSON.stringify(settings);
      await client.query(`
        INSERT INTO chat_settings (chat_id, settings, updated_at) VALUES ($1, $2::jsonb, $3)
        ON CONFLICT(chat_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at
      `, [chatId, json, now]);
      await client.query(`
        UPDATE games SET settings = $1::jsonb, updated_at = $2 WHERE chat_id = $3 AND status = 'lobby'
      `, [json, now, chatId]);
    });
  }

  async recordGameMessage(gameId: number, chatId: string, messageId: number): Promise<void> {
    await this.pool.query(`
      INSERT INTO game_messages (game_id, chat_id, message_id, created_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT(chat_id, message_id) DO NOTHING
    `, [gameId, chatId, messageId, Date.now()]);
  }

  async takeGameMessages(gameId: number): Promise<number[]> {
    return this.transaction(async (client) => {
      const result = await client.query("SELECT message_id FROM game_messages WHERE game_id = $1 ORDER BY created_at", [gameId]);
      await client.query("DELETE FROM game_messages WHERE game_id = $1", [gameId]);
      return result.rows.map((row) => Number(row.message_id));
    });
  }

  async recordAudit(chatId: string, gameId: number | null, actorId: string, action: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(`
      INSERT INTO audit_log (chat_id, game_id, actor_id, action, details, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [chatId, gameId, actorId, action, JSON.stringify(details), Date.now()]);
  }

  async getAuditLog(chatId: string, limit = 15): Promise<Array<{ actor_id: string; action: string; details: Record<string, unknown>; created_at: number }>> {
    const result = await this.pool.query(`
      SELECT actor_id, action, details, created_at FROM audit_log
      WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2
    `, [chatId, limit]);
    return result.rows.map((row) => ({ ...row, created_at: Number(row.created_at) }));
  }

  async deleteUserData(userId: string): Promise<boolean> {
    const active = await this.pool.query(`
      SELECT 1 FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.user_id = $1 AND g.status IN ('lobby','running') LIMIT 1
    `, [userId]);
    if (active.rowCount) return false;

    const anonymousId = `deleted:${randomUUID()}`;
    await this.transaction(async (client) => {
      await client.query("UPDATE actions SET actor_id = $1 WHERE actor_id = $2", [anonymousId, userId]);
      await client.query("UPDATE actions SET target_id = $1 WHERE target_id = $2", [anonymousId, userId]);
      await client.query("UPDATE votes SET voter_id = $1 WHERE voter_id = $2", [anonymousId, userId]);
      await client.query("UPDATE votes SET target_id = $1 WHERE target_id = $2", [anonymousId, userId]);
      await client.query("UPDATE nominations SET nominator_id = $1 WHERE nominator_id = $2", [anonymousId, userId]);
      await client.query("UPDATE nominations SET target_id = $1 WHERE target_id = $2", [anonymousId, userId]);
      await client.query(`
        UPDATE game_players SET user_id = $1, username = NULL, first_name = 'Удалённый пользователь'
        WHERE user_id = $2
      `, [anonymousId, userId]);
      await client.query("UPDATE games SET host_id = $1 WHERE host_id = $2 AND status NOT IN ('lobby','running')", [anonymousId, userId]);
      await client.query("UPDATE audit_log SET actor_id = $1 WHERE actor_id = $2", [anonymousId, userId]);
      await client.query("DELETE FROM user_stats WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM user_economy WHERE user_id = $1", [userId]);
    });
    return true;
  }

  private async touchUser(user: TelegramUserData, client: Queryable): Promise<void> {
    await client.query(`
      INSERT INTO user_stats (user_id, username, first_name, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT(user_id) DO UPDATE SET username = EXCLUDED.username,
        first_name = EXCLUDED.first_name, updated_at = EXCLUDED.updated_at
    `, [user.id, user.username ?? null, user.firstName, Date.now()]);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

function normalizeGame(row: Record<string, unknown>): GameRow {
  return {
    ...row,
    id: Number(row.id),
    day: Number(row.day),
    phase_ends_at: row.phase_ends_at == null ? null : Number(row.phase_ends_at),
    paused_remaining_ms: row.paused_remaining_ms == null ? null : Number(row.paused_remaining_ms),
    lobby_message_id: row.lobby_message_id == null ? null : Number(row.lobby_message_id),
    created_at: Number(row.created_at),
    started_at: row.started_at == null ? null : Number(row.started_at),
    updated_at: Number(row.updated_at),
    settings: normalizeSettings(row.settings, undefined)
  } as GameRow;
}

function normalizeProfile(row: Record<string, unknown>): UserProfile {
  return {
    user_id: String(row.user_id),
    money: Number(row.money),
    gems: Number(row.gems),
    protection: Number(row.protection),
    documents: Number(row.documents),
    active_role: Number(row.active_role)
  };
}

function normalizeSettings(value: unknown, fallback?: GameSettings): GameSettings {
  const parsed = typeof value === "string" ? JSON.parse(value) as GameSettings : value as GameSettings;
  if (!fallback) return parsed;
  return {
    ...fallback,
    ...parsed,
    roles: { ...fallback.roles, ...(parsed?.roles ?? {}) }
  };
}
