import { Markup, type Context, type Telegraf } from "telegraf";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { GameDatabase, TelegramUserData } from "./database.js";
import type { Logger } from "./logger.js";
import type { PhaseMedia } from "./media.js";
import { assignRoles, determineWinner, selectPluralityTarget } from "./rules.js";
import {
  alivePlayersText,
  escapeHtml,
  lobbyText,
  mention,
  playerName,
  profileText,
  roleDescription,
  roleLabel,
  settingsText,
  shopText,
  winnerText
} from "./text.js";
import {
  ROLES,
  SHOP_ITEMS,
  type ActionRow,
  type ActionType,
  type ActivePhase,
  type AppConfig,
  type GameRow,
  type GameSettings,
  type PlayerRow,
  type Role,
  type ShopItem,
  type Winner
} from "./types.js";

const ACTION_ROLE: Record<ActionType, Role[]> = {
  mafia_kill: ["mafia", "don"],
  don_check: ["don"],
  commissar_check: ["commissar"],
  commissar_shoot: ["commissar"],
  doctor_heal: ["doctor"],
  maniac_kill: ["maniac"],
  bum_visit: ["bum"]
};

const ACTION_TITLES: Record<ActionType, string> = {
  mafia_kill: "🔪 Кого устранить мафии?",
  don_check: "🔎 Кого проверить на роль Комиссара?",
  commissar_check: "🔍 Кого проверить на связь с мафией?",
  commissar_shoot: "🔫 В кого выстрелить? Проверка этой ночью станет недоступна.",
  doctor_heal: "💉 Кого лечить?",
  maniac_kill: "🪓 Кого устранить?",
  bum_visit: "🍾 К кому пойти в гости?"
};

export class GameEngine {
  private readonly phaseTimers = new Map<number, NodeJS.Timeout>();
  private readonly warningTimers = new Map<number, NodeJS.Timeout>();
  private readonly promptTimers = new Map<number, NodeJS.Timeout>();
  private readonly startingGames = new Set<number>();

  constructor(
    private readonly bot: Telegraf<Context>,
    private readonly db: GameDatabase,
    private readonly config: AppConfig,
    private readonly botUsername: string,
    private readonly logger: Logger,
    private readonly media: PhaseMedia
  ) {}

  async createLobby(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("Эту команду нужно отправить в группе.");
      return;
    }
    const chatId = String(ctx.chat.id);
    if (await this.db.getActiveGameByChat(chatId)) {
      await ctx.reply("В этой группе уже есть активный набор или игра. Используйте /players.");
      return;
    }

    try {
      const title = "title" in ctx.chat ? ctx.chat.title : "Telegram chat";
      const game = await this.db.createGame(chatId, title, userData(ctx.from));
      const players = await this.db.getPlayers(game.id);
      const message = await ctx.reply(lobbyText(this.config.brandName, game, players), {
        parse_mode: "HTML",
        reply_markup: this.lobbyKeyboard(game.id)
      });
      await this.db.setLobbyMessage(game.id, message.message_id);
      try {
        await this.bot.telegram.pinChatMessage(chatId, message.message_id, { disable_notification: true });
      } catch (error) {
        this.logger.warn("Не удалось закрепить сообщение набора", error);
      }
      await this.db.recordAudit(chatId, game.id, String(ctx.from.id), "create_game");
    } catch (error) {
      if (isUniqueViolation(error)) await ctx.reply("В этой группе уже открыт набор.");
      else throw error;
    }
  }

  async sendJoinButton(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("Откройте игровую группу и нажмите кнопку присоединения там.");
      return;
    }
    const game = await this.db.getActiveGameByChat(String(ctx.chat.id));
    if (!game || game.status !== "lobby") {
      await ctx.reply("Сейчас набора нет. Создайте его командой /newgame.");
      return;
    }
    await ctx.reply("Откройте бота, чтобы получать тайную роль и ночные действия:", {
      reply_markup: Markup.inlineKeyboard([Markup.button.url("🤵🏻 Присоединиться", this.joinUrl(game.id))]).reply_markup
    });
  }

  async joinFromPrivate(ctx: Context, gameId: number): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    const game = await this.db.getLobby(gameId);
    if (!game) {
      await ctx.reply("Набор уже завершён или отменён.");
      return;
    }
    const result = await this.db.joinLobby(game.id, userData(ctx.from));
    if (result === "closed") {
      await ctx.reply("Набор завершился, пока вы присоединялись.");
      return;
    }
    if (result === "full") {
      await ctx.reply("В этой игре уже заняты все места.");
      return;
    }
    await ctx.reply(result === "existing"
      ? `✅ Вы уже зарегистрированы в игре «${escapeHtml(game.chat_title)}».`
      : `✅ Вы присоединились к игре «${escapeHtml(game.chat_title)}».`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([Markup.button.callback("🚪 Покинуть набор", `leave:${game.id}`)]).reply_markup
    });
    await this.updateLobby(game.id);
  }

  async leaveLobby(ctx: Context, gameId: number): Promise<void> {
    await safeAnswerCallback(ctx);
    if (!ctx.from) return;
    const game = await this.db.getLobby(gameId);
    if (!game) {
      await ctx.reply("Этот набор уже завершён.");
      return;
    }
    const userId = String(ctx.from.id);
    if (game.host_id === userId) {
      await ctx.reply("Создатель не может покинуть набор. Передайте права командой /transfer или отмените игру.");
      return;
    }
    const result = await this.db.removePlayerFromLobby(game.id, userId);
    await ctx.reply(result === "removed" ? "Вы покинули набор." : result === "closed" ? "Набор уже завершён." : "Вы не зарегистрированы в этой игре.");
    if (result === "removed") await this.updateLobby(game.id);
  }

  async refreshLobby(ctx: Context, gameId: number): Promise<void> {
    await safeAnswerCallback(ctx, "Список обновлён");
    await this.updateLobby(gameId);
  }

  async beginGame(ctx: Context, gameId: number): Promise<void> {
    await safeAnswerCallback(ctx);
    if (!ctx.from) return;
    const game = await this.db.getLobby(gameId);
    if (!game) {
      await ctx.reply("Набор уже завершён.");
      return;
    }
    if (this.startingGames.has(game.id)) {
      await ctx.reply("Игра уже запускается.");
      return;
    }
    this.startingGames.add(game.id);
    try {
      if (!(await this.canManage(game, ctx.from.id))) {
        await ctx.reply("Начать игру может создатель или администратор группы.");
        return;
      }
      const players = await this.db.getPlayers(game.id);
      if (players.length < game.settings.minPlayers) {
        await ctx.reply(`Нужно минимум ${game.settings.minPlayers} игроков. Сейчас: ${players.length}.`);
        return;
      }

      const unreachable: PlayerRow[] = [];
      await Promise.all(players.map(async (player) => {
        try { await this.bot.telegram.sendChatAction(player.user_id, "typing"); }
        catch { unreachable.push(player); }
      }));
      if (unreachable.length) {
        await this.bot.telegram.sendMessage(game.chat_id, [
          "⚠️ <b>Не могу начать игру</b>",
          "Эти игроки не открыли личный чат с ботом:",
          ...unreachable.map((player) => `• ${mention(player)}`),
          "",
          "Им нужно нажать «Присоединиться» и запустить бота."
        ].join("\n"), { parse_mode: "HTML", reply_markup: this.lobbyKeyboard(game.id) });
        return;
      }

      const provisionalEndsAt = Date.now() + 10 * 60 * 1000;
      if (!(await this.db.startGame(game.id, provisionalEndsAt))) return;
      await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "start_game", { players: players.length });
      const finalPlayers = await this.db.getPlayers(game.id);
      await this.db.assignRoles(game.id, assignRoles(finalPlayers.map((player) => player.user_id), game.settings));
      const assignedPlayers = await this.db.getPlayers(game.id);

      try {
        for (const player of assignedPlayers) await this.sendRoleCard(player, assignedPlayers, game);
      } catch (error) {
        this.logger.error("Не удалось раздать роли", error);
        await this.db.cancelGame(game.id);
        await this.bot.telegram.sendMessage(game.chat_id, "Игра отменена: одному из игроков не удалось доставить роль. Создайте новый набор командой /newgame.");
        return;
      }

      const running = (await this.db.getGame(game.id))!;
      await this.cleanupPhaseMessages(running);
      await this.sendPhaseMedia(running, "night", `🌃 <b>Ночь 1</b> · город засыпает`);
      await this.sendTracked(running, [
        "Активные роли делают выбор в личных сообщениях.",
        `⏳ На действия: <b>${game.settings.nightSeconds} сек.</b>`,
        "",
        alivePlayersText(assignedPlayers)
      ].join("\n"), this.openBotKeyboard());
      await this.sendNightPrompts(game.id);
      const endsAt = Date.now() + game.settings.nightSeconds * 1000;
      await this.db.setPhase(game.id, "night", 1, endsAt);
      this.schedulePhase(game.id, endsAt);
    } finally {
      this.startingGames.delete(game.id);
    }
  }

  async handleNightAction(ctx: Context, gameId: number, actionDay: number, type: ActionType, targetId: string): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") {
      await safeAnswerCallback(ctx, "Ночные действия доступны только в личном чате", true);
      return;
    }
    const game = await this.db.getGame(gameId);
    if (!game || game.status !== "running" || game.phase !== "night" || game.day !== actionDay) {
      await safeAnswerCallback(ctx, "Эта кнопка относится к завершённой ночи", true);
      return;
    }
    if (type === "commissar_shoot" && !game.settings.commissionerCanShoot) {
      await safeAnswerCallback(ctx, "Стрельба Комиссара отключена", true);
      return;
    }

    const actor = await this.db.getPlayer(game.id, String(ctx.from.id));
    const target = await this.db.getPlayer(game.id, targetId);
    if (!actor?.alive || !actor.role || !ACTION_ROLE[type].includes(actor.role)) {
      await safeAnswerCallback(ctx, "Это действие вам недоступно", true);
      return;
    }
    if (!target?.alive) {
      await safeAnswerCallback(ctx, "Этот игрок уже выбыл", true);
      return;
    }
    if (type !== "doctor_heal" && actor.user_id === target.user_id) {
      await safeAnswerCallback(ctx, "Нельзя выбрать себя", true);
      return;
    }
    if (type === "doctor_heal" && actor.user_id === target.user_id && !game.settings.doctorSelfHeal) {
      await safeAnswerCallback(ctx, "Самолечение отключено", true);
      return;
    }
    if (type === "mafia_kill" && (target.role === "mafia" || target.role === "don")) {
      await safeAnswerCallback(ctx, "Нельзя атаковать участника мафии", true);
      return;
    }
    if (type === "doctor_heal") {
      const previous = await this.db.getPreviousTarget(game.id, actor.user_id, "doctor_heal", game.day);
      if (previous === target.user_id) {
        await safeAnswerCallback(ctx, "Нельзя лечить одну цель две ночи подряд", true);
        return;
      }
    }

    if (type === "commissar_check" || type === "commissar_shoot") {
      const recorded = await this.db.tryRecordCommissionerAction(game.id, game.day, actor.user_id, type, target.user_id);
      if (!recorded) {
        await safeAnswerCallback(ctx, "Комиссар уже использовал действие этой ночью", true);
        return;
      }
    } else if (type === "don_check") {
      const existing = (await this.db.getActions(game.id, game.day, type)).some((action) => action.actor_id === actor.user_id);
      if (existing) {
        await safeAnswerCallback(ctx, "Проверка этой ночью уже использована", true);
        return;
      }
      await this.db.recordAction(game.id, game.day, actor.user_id, type, target.user_id);
    } else {
      await this.db.recordAction(game.id, game.day, actor.user_id, type, target.user_id);
    }

    await safeAnswerCallback(ctx, `Вы выбрали: ${plainPlayerName(target)}`);
    if (type === "don_check") {
      await ctx.reply(target.role === "commissar"
        ? `🎯 ${playerName(target)} — это Комиссар.`
        : `❌ ${playerName(target)} — не Комиссар.`, privateHtml());
    } else if (type === "commissar_check") {
      const mafia = target.role === "mafia" || target.role === "don";
      await ctx.reply(mafia
        ? `🚨 ${playerName(target)} связан(а) с мафией.`
        : `✅ ${playerName(target)} не связан(а) с мафией.`, privateHtml());
    } else if (type === "commissar_shoot") {
      await ctx.reply(`🔫 Выстрел назначен: ${playerName(target)}. Изменить его нельзя.`, privateHtml());
    } else {
      await ctx.reply(`✅ Выбор принят: ${playerName(target)}. До конца ночи его можно изменить.`, privateHtml());
    }
  }

  async handleNomination(ctx: Context, gameId: number, day: number, targetId: string): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") {
      await safeAnswerCallback(ctx, "Выдвижение доступно только в личном чате с ботом", true);
      return;
    }
    const game = await this.db.getGame(gameId);
    if (!game || game.phase !== "nomination" || game.day !== day || game.status !== "running") {
      await safeAnswerCallback(ctx, "Выдвижение уже завершено", true);
      return;
    }
    const nominator = await this.db.getPlayer(game.id, String(ctx.from.id));
    const target = await this.db.getPlayer(game.id, targetId);
    if (!nominator?.alive || !target?.alive) {
      await safeAnswerCallback(ctx, "Действие доступно только живым игрокам", true);
      return;
    }
    if (nominator.user_id === target.user_id) {
      await safeAnswerCallback(ctx, "Нельзя выдвинуть себя", true);
      return;
    }
    const previous = (await this.db.getNominations(game.id, game.day)).find((item) => item.nominator_id === nominator.user_id);
    if (previous?.target_id === target.user_id) {
      await safeAnswerCallback(ctx, "Вы уже выдвинули этого игрока");
      return;
    }
    await this.db.recordNomination(game.id, game.day, nominator.user_id, target.user_id);
    await safeAnswerCallback(ctx, "Кандидатура принята");
    await this.sendTracked(game, previous
      ? `${mention(nominator)} изменил(а) кандидатуру: ${mention(target)}`
      : `${mention(nominator)} выдвинул(а) ${mention(target)}`);
  }

  async handleVote(ctx: Context, gameId: number, voteDay: number, targetId: string): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") {
      await safeAnswerCallback(ctx, "Голосование доступно только в личном чате с ботом", true);
      return;
    }
    const game = await this.db.getGame(gameId);
    if (!game || game.status !== "running" || game.phase !== "vote" || game.day !== voteDay) {
      await safeAnswerCallback(ctx, "Это голосование завершено", true);
      return;
    }
    const voter = await this.db.getPlayer(game.id, String(ctx.from.id));
    if (!voter?.alive) {
      await safeAnswerCallback(ctx, "Голосовать могут только живые игроки", true);
      return;
    }
    let target: PlayerRow | undefined;
    if (targetId === "skip") {
      if (!game.settings.allowSkipVote) {
        await safeAnswerCallback(ctx, "Пропуск отключён", true);
        return;
      }
    } else {
      target = await this.db.getPlayer(game.id, targetId);
      if (!target?.alive) {
        await safeAnswerCallback(ctx, "Этот игрок уже выбыл", true);
        return;
      }
      if (!game.settings.allowSelfVote && voter.user_id === target.user_id) {
        await safeAnswerCallback(ctx, "Голосование за себя отключено", true);
        return;
      }
    }

    const oldVote = (await this.db.getVotes(game.id, game.day)).find((vote) => vote.voter_id === voter.user_id);
    if (oldVote?.target_id === targetId) {
      await safeAnswerCallback(ctx, "Вы уже сделали этот выбор");
      return;
    }
    await this.db.recordVote(game.id, game.day, voter.user_id, targetId);
    await safeAnswerCallback(ctx, "Голос принят");
    const targetText = targetId === "skip" ? "пропуск голосования" : mention(target!);
    await this.sendTracked(game, oldVote
      ? `${mention(voter)} изменил(а) голос: ${targetText}`
      : `${mention(voter)} проголосовал(а) за ${targetText}`);
  }

  async showPlayers(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("Команда работает в игровой группе.");
      return;
    }
    const game = await this.db.getActiveGameByChat(String(ctx.chat.id));
    if (!game) {
      await ctx.reply("Активной игры нет. Создайте её командой /newgame.");
      return;
    }
    const players = await this.db.getPlayers(game.id, game.status === "running");
    await ctx.reply(game.status === "running"
      ? alivePlayersText(players)
      : lobbyText(this.config.brandName, game, players), { parse_mode: "HTML" });
  }

  async stopGame(ctx: Context): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Отменить игру может создатель или администратор.");
      return;
    }
    this.clearTimers(game.id);
    await this.db.cancelGame(game.id);
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "stop_game");
    await ctx.reply("🛑 Игра отменена. Новый набор: /newgame");
  }

  async pauseGame(ctx: Context): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Поставить игру на паузу может создатель или администратор.");
      return;
    }
    if (game.status !== "running" || game.phase === "paused" || game.phase === "finished" || game.phase === "lobby") {
      await ctx.reply(game.phase === "paused" ? "Игра уже на паузе." : "Сейчас игру нельзя поставить на паузу.");
      return;
    }
    const remaining = Math.max(1_000, (game.phase_ends_at ?? Date.now()) - Date.now());
    await this.db.pauseGame(game.id, game.phase as ActivePhase, remaining);
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "pause_game", { phase: game.phase });
    this.clearTimers(game.id);
    await ctx.reply("⏸ Игра поставлена на паузу. Продолжить: /resume");
  }

  async resumeGame(ctx: Context): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Продолжить игру может создатель или администратор.");
      return;
    }
    const resumed = await this.db.resumeGame(game.id);
    if (!resumed?.phase_ends_at) {
      await ctx.reply("Игра не находится на паузе.");
      return;
    }
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "resume_game", { phase: resumed.phase });
    await ctx.reply(`▶️ Игра продолжена. Фаза: <b>${phaseName(resumed.phase)}</b>.`, { parse_mode: "HTML" });
    if (resumed.phase === "night") await this.sendNightPrompts(resumed.id);
    this.schedulePhase(resumed.id, resumed.phase_ends_at);
  }

  async extendGame(ctx: Context, seconds = 30): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Продлить фазу может создатель или администратор.");
      return;
    }
    if (game.phase === "paused" || !game.phase_ends_at) {
      await ctx.reply("На паузе таймер продлить нельзя.");
      return;
    }
    const safeSeconds = Math.max(10, Math.min(300, seconds));
    const updated = await this.db.extendPhase(game.id, safeSeconds * 1000);
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "extend_phase", { seconds: safeSeconds, phase: game.phase });
    if (updated?.phase_ends_at) this.schedulePhase(updated.id, updated.phase_ends_at);
    await ctx.reply(`⏱ Фаза продлена на ${safeSeconds} сек.`);
  }

  async forceNextPhase(ctx: Context): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Переключить фазу может создатель или администратор.");
      return;
    }
    if (!isActivePhase(game.phase)) {
      await ctx.reply("Сейчас нельзя переключить фазу.");
      return;
    }
    await this.db.setPhase(game.id, game.phase, game.day, Date.now());
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "force_next_phase", { phase: game.phase });
    this.clearTimers(game.id);
    await ctx.reply("⏭ Перехожу к следующей фазе.");
    await this.onPhaseTimer(game.id);
  }

  async kickRepliedPlayer(ctx: Context): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Исключать игроков может создатель или администратор.");
      return;
    }
    const targetUser = repliedUser(ctx);
    if (!targetUser) {
      await ctx.reply("Ответьте командой /kick на сообщение игрока.");
      return;
    }
    const player = await this.db.getPlayer(game.id, String(targetUser.id));
    if (!player) {
      await ctx.reply("Этот пользователь не участвует в игре.");
      return;
    }
    if (player.user_id === game.host_id) {
      await ctx.reply("Сначала передайте права ведущего командой /transfer.");
      return;
    }
    if (game.status === "lobby") {
      const removal = await this.db.removePlayerFromLobby(game.id, player.user_id);
      if (removal !== "removed") {
        await ctx.reply("Набор уже завершён или игрок вышел.");
        return;
      }
      await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "kick_player", { targetId: player.user_id, phase: "lobby" });
      await ctx.reply(`🚪 ${mention(player)} исключён(а) из набора.`, { parse_mode: "HTML" });
      await this.updateLobby(game.id);
      return;
    }
    if (!player.alive) {
      await ctx.reply("Этот игрок уже выбыл.");
      return;
    }
    await this.db.killPlayers(game.id, [player.user_id]);
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "kick_player", { targetId: player.user_id, phase: game.phase });
    await this.sendTracked(game, `🚪 ${mention(player)} исключён(а) администратором.`);
    await this.finishIfWinner(game);
  }

  async transferHost(ctx: Context): Promise<void> {
    const game = await this.groupGame(ctx);
    if (!game || !ctx.from) return;
    if (!(await this.canManage(game, ctx.from.id))) {
      await ctx.reply("Передать права может ведущий или администратор.");
      return;
    }
    const targetUser = repliedUser(ctx);
    if (!targetUser) {
      await ctx.reply("Ответьте командой /transfer на сообщение нового ведущего.");
      return;
    }
    const player = await this.db.getPlayer(game.id, String(targetUser.id));
    if (!player) {
      await ctx.reply("Новый ведущий должен участвовать в игре.");
      return;
    }
    await this.db.transferHost(game.id, player.user_id);
    await this.db.recordAudit(game.chat_id, game.id, String(ctx.from.id), "transfer_host", { targetId: player.user_id });
    await ctx.reply(`👑 Новый ведущий: ${mention(player)}`, { parse_mode: "HTML" });
    if (game.status === "lobby") await this.updateLobby(game.id);
  }

  async showProfile(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const profile = await this.db.getProfile(userData(ctx.from));
    const displayName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    await ctx.reply(profileText(displayName, profile), { parse_mode: "HTML" });
  }

  async showShop(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const profile = await this.db.getProfile(userData(ctx.from));
    await ctx.reply(shopText(profile), { parse_mode: "HTML", reply_markup: shopKeyboard() });
  }

  async handleShopPurchase(ctx: Context, item: ShopItem): Promise<void> {
    if (!ctx.from) return;
    const price = SHOP_ITEMS[item].price;
    const { ok, profile } = await this.db.buyShopItem(userData(ctx.from), item, price);
    if (!ok) {
      await ctx.answerCbQuery("Недостаточно денег 💵", { show_alert: true });
      return;
    }
    await ctx.answerCbQuery(`Куплено: ${SHOP_ITEMS[item].title} ✅`);
    try {
      await ctx.editMessageText(shopText(profile), { parse_mode: "HTML", reply_markup: shopKeyboard() });
    } catch { /* message unchanged or too old to edit */ }
  }

  async showStats(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const stats = await this.db.getStats(String(ctx.from.id));
    if (!stats || stats.games === 0) {
      await ctx.reply("У вас пока нет завершённых игр.");
      return;
    }
    const rate = Math.round((stats.wins / stats.games) * 100);
    await ctx.reply([
      `📊 <b>Статистика ${escapeHtml(ctx.from.first_name)}</b>`,
      `Игр: <b>${stats.games}</b>`,
      `Побед: <b>${stats.wins}</b> (${rate}%)`,
      `За город: ${stats.town_wins}`,
      `За мафию: ${stats.mafia_wins}`,
      `За Маньяка: ${stats.maniac_wins}`
    ].join("\n"), { parse_mode: "HTML" });
  }

  async showTop(ctx: Context): Promise<void> {
    const rows = await this.db.getLeaderboard(10);
    if (!rows.length) {
      await ctx.reply("Рейтинг пока пуст.");
      return;
    }
    const lines = rows.map((row, index) => {
      const name = row.username ? `@${escapeHtml(row.username)}` : escapeHtml(row.first_name);
      const rate = Math.round((row.wins / row.games) * 100);
      return `${index + 1}. ${name} — <b>${row.wins}</b> побед из ${row.games} (${rate}%)`;
    });
    await ctx.reply(["🏅 <b>Лучшие игроки</b>", "", ...lines].join("\n"), { parse_mode: "HTML" });
  }

  async showSettings(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("Настройки открываются в группе.");
      return;
    }
    if (!(await this.canManageChat(String(ctx.chat.id), ctx.from.id))) {
      await ctx.reply("Настройки доступны администраторам группы.");
      return;
    }
    const settings = await this.db.getChatSettings(String(ctx.chat.id));
    await ctx.reply(settingsText(settings), { parse_mode: "HTML", reply_markup: settingsKeyboard(settings) });
  }

  async showAdminLog(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("Журнал доступен в группе.");
      return;
    }
    const chatId = String(ctx.chat.id);
    if (!(await this.canManageChat(chatId, ctx.from.id))) {
      await ctx.reply("Журнал доступен администраторам группы.");
      return;
    }
    const entries = await this.db.getAuditLog(chatId, 15);
    if (!entries.length) {
      await ctx.reply("Журнал административных действий пока пуст.");
      return;
    }
    const actionNames: Record<string, string> = {
      create_game: "создал игру",
      start_game: "начал игру",
      stop_game: "остановил игру",
      pause_game: "поставил на паузу",
      resume_game: "продолжил игру",
      extend_phase: "продлил фазу",
      force_next_phase: "переключил фазу",
      kick_player: "исключил игрока",
      transfer_host: "передал ведущего",
      change_setting: "изменил настройку"
    };
    const lines = entries.map((entry) => {
      const date = new Date(entry.created_at).toISOString().replace("T", " ").slice(0, 16);
      const details = Object.keys(entry.details ?? {}).length ? ` · <code>${escapeHtml(JSON.stringify(entry.details))}</code>` : "";
      return `${date} · <code>${escapeHtml(entry.actor_id)}</code> — ${actionNames[entry.action] ?? escapeHtml(entry.action)}${details}`;
    });
    await ctx.reply(["📋 <b>Журнал администраторов</b>", "", ...lines].join("\n"), { parse_mode: "HTML" });
  }

  async handleSetting(ctx: Context, key: string): Promise<void> {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await safeAnswerCallback(ctx, "Настройки доступны в группе", true);
      return;
    }
    const chatId = String(ctx.chat.id);
    if (!(await this.canManageChat(chatId, ctx.from.id))) {
      await safeAnswerCallback(ctx, "Только для администраторов", true);
      return;
    }
    const settings = await this.db.getChatSettings(chatId);
    mutateSetting(settings, key);
    const activeBeforeUpdate = await this.db.getActiveGameByChat(chatId);
    if (activeBeforeUpdate?.status === "lobby") {
      const registered = (await this.db.getPlayers(activeBeforeUpdate.id)).length;
      settings.maxPlayers = Math.max(settings.maxPlayers, registered, settings.minPlayers);
    }
    await this.db.updateChatSettings(chatId, settings);
    const activeGame = await this.db.getActiveGameByChat(chatId);
    await this.db.recordAudit(chatId, activeGame?.id ?? null, String(ctx.from.id), "change_setting", { key });
    if (activeGame?.status === "lobby") await this.updateLobby(activeGame.id);
    await safeAnswerCallback(ctx, "Настройка сохранена");
    try {
      await ctx.editMessageText(settingsText(settings), { parse_mode: "HTML", reply_markup: settingsKeyboard(settings) });
    } catch (error) {
      if (!String(error).includes("message is not modified")) throw error;
    }
  }

  async relayMafiaMessage(ctx: Context, rawText: string): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") {
      await ctx.reply("Команда /mafia работает только в личном чате с ботом.");
      return;
    }
    const games = await this.db.getRunningGamesForPlayer(String(ctx.from.id));
    const mafiaGames: Array<{ game: GameRow; actor: PlayerRow }> = [];
    for (const game of games) {
      const actor = await this.db.getPlayer(game.id, String(ctx.from.id));
      if (actor?.alive && (actor.role === "mafia" || actor.role === "don")) mafiaGames.push({ game, actor });
    }
    if (!mafiaGames.length) {
      await ctx.reply("Сейчас вы не состоите в живой команде мафии.");
      return;
    }

    let selected = mafiaGames[0]!;
    let text = rawText.trim();
    const gamePrefix = /^(\d+)\s+([\s\S]+)$/.exec(text);
    if (mafiaGames.length > 1) {
      if (!gamePrefix) {
        await ctx.reply(`Вы участвуете в нескольких играх. Используйте: /mafia ID текст\nID: ${mafiaGames.map((item) => item.game.id).join(", ")}`);
        return;
      }
      const match = mafiaGames.find((item) => item.game.id === Number(gamePrefix[1]));
      if (!match) {
        await ctx.reply("Игра с таким ID не найдена.");
        return;
      }
      selected = match;
      text = gamePrefix[2]!.trim();
    }
    if (!text) {
      await ctx.reply("Использование: /mafia текст сообщения");
      return;
    }
    if (text.length > 1000) text = text.slice(0, 1000);
    const team = (await this.db.getPlayers(selected.game.id, true)).filter((player) =>
      player.user_id !== selected.actor.user_id && (player.role === "mafia" || player.role === "don"));
    for (const teammate of team) {
      try {
        await this.bot.telegram.sendMessage(teammate.user_id, [
          `🔒 <b>Чат мафии · ${escapeHtml(selected.game.chat_title)}</b>`,
          `${mention(selected.actor)}: ${escapeHtml(text)}`
        ].join("\n"), privateHtml());
      } catch (error) {
        this.logger.warn(`Не удалось доставить сообщение мафии ${teammate.user_id}`, error);
      }
    }
    await ctx.reply(`✅ Сообщение отправлено участникам мафии: ${team.length}.`);
  }

  async deleteMyData(ctx: Context): Promise<void> {
    if (!ctx.from || ctx.chat?.type !== "private") {
      await ctx.reply("Для защиты от случайного удаления отправьте /deleteme в личном чате с ботом.");
      return;
    }
    const deleted = await this.db.deleteUserData(String(ctx.from.id));
    await ctx.reply(deleted
      ? "✅ Ваша статистика и идентификаторы в завершённых играх удалены или обезличены."
      : "Сейчас вы участвуете в активной игре или наборе. Выйдите из него и повторите команду.");
  }

  async sendReport(ctx: Context, text: string): Promise<void> {
    if (!ctx.from) return;
    if (!text.trim()) {
      await ctx.reply("Опишите проблему после команды: /report текст");
      return;
    }
    if (!this.config.ownerTelegramId) {
      const contact = this.config.supportUsername ? `@${this.config.supportUsername}` : this.config.privacyContact;
      await ctx.reply(`Автоматическая отправка не настроена. Контакт поддержки: ${escapeHtml(contact)}`, { parse_mode: "HTML" });
      return;
    }
    const source = ctx.chat?.type === "private" ? "личный чат" : `чат ${ctx.chat?.id}`;
    await this.bot.telegram.sendMessage(this.config.ownerTelegramId, [
      "🚨 <b>Новый отчёт</b>",
      `От: ${escapeHtml(ctx.from.first_name)} · <code>${ctx.from.id}</code>`,
      `Источник: ${escapeHtml(source)}`,
      "",
      escapeHtml(text.slice(0, 3000))
    ].join("\n"), { parse_mode: "HTML" });
    await ctx.reply("✅ Сообщение отправлено владельцу бота.");
  }

  async resumeGames(): Promise<void> {
    const games = await this.db.getRunningGames();
    for (const game of games) {
      if (game.phase === "paused") continue;
      if (!game.phase_ends_at) continue;
      this.schedulePhase(game.id, game.phase_ends_at);
      try {
        await this.bot.telegram.sendMessage(game.chat_id,
          `♻️ Бот перезапущен. Фаза: <b>${phaseName(game.phase)}</b>. Игра продолжается.`, { parse_mode: "HTML" });
        if (game.phase === "night") {
          const allPlayers = await this.db.getPlayers(game.id);
          for (const player of allPlayers.filter((item) => item.alive === 1)) await this.sendRoleCard(player, allPlayers, game);
          await this.sendNightPrompts(game.id);
        }
      } catch (error) {
        this.logger.warn(`Не удалось восстановить игру ${game.id}`, error);
      }
    }
  }

  shutdown(): void {
    for (const gameId of new Set([...this.phaseTimers.keys(), ...this.warningTimers.keys(), ...this.promptTimers.keys()])) {
      this.clearTimers(gameId);
    }
  }

  private async updateLobby(gameId: number): Promise<void> {
    const game = await this.db.getLobby(gameId);
    if (!game?.lobby_message_id) return;
    const players = await this.db.getPlayers(game.id);
    try {
      await this.bot.telegram.editMessageText(game.chat_id, game.lobby_message_id, undefined,
        lobbyText(this.config.brandName, game, players), { parse_mode: "HTML", reply_markup: this.lobbyKeyboard(game.id) });
    } catch (error) {
      if (!String(error).includes("message is not modified")) this.logger.warn("Не удалось обновить лобби", error);
    }
  }

  private lobbyKeyboard(gameId: number): InlineKeyboardMarkup {
    return Markup.inlineKeyboard([
      [Markup.button.url("🤵🏻 Присоединиться", this.joinUrl(gameId))]
    ]).reply_markup;
  }

  private openBotKeyboard(): InlineKeyboardMarkup {
    return Markup.inlineKeyboard([Markup.button.url("🌙 Перейти к боту", `https://t.me/${this.botUsername}`)]).reply_markup;
  }

  private joinUrl(gameId: number): string {
    return `https://t.me/${this.botUsername}?start=join_${gameId}`;
  }

  private async canManage(game: GameRow, telegramUserId: number): Promise<boolean> {
    return game.host_id === String(telegramUserId) || this.canManageChat(game.chat_id, telegramUserId);
  }

  private async canManageChat(chatId: string, telegramUserId: number): Promise<boolean> {
    try {
      const member = await this.bot.telegram.getChatMember(chatId, telegramUserId);
      return member.status === "administrator" || member.status === "creator";
    } catch {
      return false;
    }
  }

  private async groupGame(ctx: Context): Promise<GameRow | undefined> {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("Команда работает в игровой группе.");
      return undefined;
    }
    const game = await this.db.getActiveGameByChat(String(ctx.chat.id));
    if (!game) await ctx.reply("Активной игры или набора нет.");
    return game;
  }

  private async sendRoleCard(player: PlayerRow, allPlayers: PlayerRow[], game: GameRow): Promise<void> {
    if (!player.role) throw new Error(`У игрока ${player.user_id} нет роли`);
    const lines = [
      `🎴 <b>${escapeHtml(this.config.brandName)} · Ваша роль</b>`,
      "",
      roleLabel(player.role),
      roleDescription(player.role),
      "",
      `Игра: <b>${escapeHtml(game.chat_title)}</b> · ID ${game.id}`
    ];
    if (player.role === "mafia" || player.role === "don") {
      const team = allPlayers.filter((candidate) => candidate.user_id !== player.user_id && (candidate.role === "mafia" || candidate.role === "don"));
      lines.push("", "<b>Ваша команда:</b>", ...(team.length
        ? team.map((member) => `• ${mention(member)} — ${roleLabel(member.role!)}`)
        : ["Вы действуете в одиночку."]), "", "Тайный обмен сообщениями: <code>/mafia текст</code>");
    }
    await this.bot.telegram.sendMessage(player.user_id, lines.join("\n"), privateHtml());
  }

  private async sendNightPrompts(gameId: number): Promise<void> {
    const game = await this.db.getGame(gameId);
    if (!game || game.phase !== "night" || game.status !== "running") return;
    const alive = await this.db.getPlayers(game.id, true);
    for (const actor of alive) {
      if (!actor.role) continue;
      try {
        for (const type of nightActionsForRole(actor.role, game.settings)) {
          const targets = await this.validTargets(type, actor, alive, game);
          if (!targets.length) continue;
          const oneTime = type === "don_check" || type === "commissar_check" || type === "commissar_shoot";
          await this.bot.telegram.sendMessage(actor.user_id,
            `<b>Ночь ${game.day}</b>\n${ACTION_TITLES[type]}\n${oneTime ? "Действие выполняется один раз." : "Выбор можно изменить до конца ночи."}`, {
              ...privateHtml(),
              reply_markup: targetKeyboard(game.id, game.day, type, targets)
            });
        }
      } catch (error) {
        this.logger.warn(`Не удалось отправить ночное действие игроку ${actor.user_id}`, error);
      }
    }
  }

  private async validTargets(type: ActionType, actor: PlayerRow, alive: PlayerRow[], game: GameRow): Promise<PlayerRow[]> {
    const previousDoctorTarget = type === "doctor_heal"
      ? await this.db.getPreviousTarget(game.id, actor.user_id, "doctor_heal", game.day)
      : undefined;
    return alive.filter((target) => {
      if (type !== "doctor_heal" && target.user_id === actor.user_id) return false;
      if (type === "doctor_heal" && target.user_id === actor.user_id && !game.settings.doctorSelfHeal) return false;
      if (type === "mafia_kill" && (target.role === "mafia" || target.role === "don")) return false;
      if (type === "doctor_heal" && target.user_id === previousDoctorTarget) return false;
      return true;
    });
  }

  private schedulePhase(gameId: number, endsAt: number): void {
    this.clearPhaseTimers(gameId);
    const delay = Math.max(50, endsAt - Date.now());
    this.phaseTimers.set(gameId, setTimeout(() => {
      this.phaseTimers.delete(gameId);
      void this.onPhaseTimer(gameId).catch((error) => this.logger.error(`Ошибка таймера игры ${gameId}`, error));
    }, delay));

    if (delay > 10_500) {
      this.warningTimers.set(gameId, setTimeout(() => {
        this.warningTimers.delete(gameId);
        void (async () => {
          const game = await this.db.getGame(gameId);
          if (!game || game.status !== "running" || game.phase === "paused" || !game.phase_ends_at) return;
          if (game.phase_ends_at - Date.now() > 11_000) return;
          await this.sendTracked(game, `⏳ До окончания фазы «${phaseName(game.phase)}» осталось <b>10 секунд</b>.`);
        })().catch((error) => this.logger.warn("Не удалось отправить предупреждение таймера", error));
      }, delay - 10_000));
    }
  }

  private clearPhaseTimers(gameId: number): void {
    const phase = this.phaseTimers.get(gameId);
    const warning = this.warningTimers.get(gameId);
    if (phase) clearTimeout(phase);
    if (warning) clearTimeout(warning);
    this.phaseTimers.delete(gameId);
    this.warningTimers.delete(gameId);
  }

  private clearTimers(gameId: number): void {
    this.clearPhaseTimers(gameId);
    const prompt = this.promptTimers.get(gameId);
    if (prompt) clearTimeout(prompt);
    this.promptTimers.delete(gameId);
  }

  private async onPhaseTimer(gameId: number): Promise<void> {
    const game = await this.db.getGame(gameId);
    if (!game || game.status !== "running" || game.phase === "paused") return;
    if (game.phase_ends_at && game.phase_ends_at > Date.now() + 100) {
      this.schedulePhase(game.id, game.phase_ends_at);
      return;
    }
    if (game.phase === "night") await this.resolveNight(game);
    else if (game.phase === "day") {
      if (game.settings.nominationsEnabled) await this.openNominations(game);
      else await this.openVoting(game, await this.db.getPlayers(game.id, true));
    } else if (game.phase === "nomination") await this.openVotingFromNominations(game);
    else if (game.phase === "vote") await this.resolveVoting(game);
    else if (game.phase === "last_word") await this.finalizeLastWord(game);
  }

  private async resolveNight(game: GameRow): Promise<void> {
    const players = await this.db.getPlayers(game.id);
    const aliveBefore = players.filter((player) => player.alive === 1);
    const aliveIds = new Set(aliveBefore.map((player) => player.user_id));
    const actions = await this.db.getActions(game.id, game.day);
    const afkIds = await this.applyNightAfk(game, aliveBefore, actions);

    const mafiaVotes = actions.filter((action) => {
      if (action.type !== "mafia_kill" || !aliveIds.has(action.actor_id) || !aliveIds.has(action.target_id)) return false;
      const actor = players.find((player) => player.user_id === action.actor_id);
      const target = players.find((player) => player.user_id === action.target_id);
      return !!actor && !!target && (actor.role === "mafia" || actor.role === "don") && target.role !== "mafia" && target.role !== "don";
    });
    const mafiaTarget = selectPluralityTarget(mafiaVotes.map((action) => action.target_id));
    const maniacTarget = validSingleActionTarget(actions, players, aliveIds, "maniac_kill", "maniac");
    const commissionerTarget = validSingleActionTarget(actions, players, aliveIds, "commissar_shoot", "commissar");
    const healed = new Set(actions.filter((action) => {
      const actor = players.find((player) => player.user_id === action.actor_id);
      return action.type === "doctor_heal" && aliveIds.has(action.actor_id) && aliveIds.has(action.target_id) && actor?.role === "doctor";
    }).map((action) => action.target_id));

    const attacked = new Set<string>();
    if (mafiaTarget) attacked.add(mafiaTarget);
    if (maniacTarget) attacked.add(maniacTarget);
    if (commissionerTarget) attacked.add(commissionerTarget);
    const attackDeaths = [...attacked].filter((id) => !healed.has(id));
    const killedIds = [...new Set([...attackDeaths, ...afkIds])];
    await this.db.killPlayers(game.id, killedIds);
    await this.sendBumReports(game, players, actions);

    const killed = killedIds.map((id) => players.find((player) => player.user_id === id)).filter(isPlayer);
    const afkSet = new Set(afkIds);
    const savedCount = [...attacked].filter((id) => healed.has(id)).length;
    const winner = determineWinner(await this.db.getPlayers(game.id, true));
    if (winner) {
      await this.cleanupPhaseMessages(game);
      await this.sendMorningSummary(game, killed, afkSet, savedCount, mafiaTarget, mafiaVotes.length);
      await this.finishGame(game, winner);
      return;
    }

    const endsAt = Date.now() + game.settings.daySeconds * 1000;
    await this.db.setPhase(game.id, "day", game.day, endsAt);
    const current = (await this.db.getGame(game.id))!;
    await this.cleanupPhaseMessages(current);
    await this.sendPhaseMedia(current, "day", `🌇 <b>День ${game.day}</b> · город просыпается`);
    await this.sendMorningSummary(current, killed, afkSet, savedCount, mafiaTarget, mafiaVotes.length);
    await this.sendTracked(current, [alivePlayersText(await this.db.getPlayers(game.id, true)), "", `💬 Обсуждение: <b>${game.settings.daySeconds} сек.</b>`].join("\n"));
    this.schedulePhase(game.id, endsAt);
  }

  private async sendMorningSummary(game: GameRow, killed: PlayerRow[], afkSet: Set<string>, savedCount: number, mafiaTarget: string | null, mafiaVotes: number): Promise<void> {
    const lines = ["🌇 <b>Итоги ночи</b>"];
    const attackedKilled = killed.filter((player) => !afkSet.has(player.user_id));
    if (!attackedKilled.length) lines.push("Город проснулся без жертв нападений.");
    for (const victim of attackedKilled) {
      lines.push(`Убит(а) ${mention(victim)}${game.settings.revealDeadRoles && victim.role ? ` — ${roleLabel(victim.role)}` : ""}.`);
    }
    for (const player of killed.filter((item) => afkSet.has(item.user_id))) {
      lines.push(`💤 ${mention(player)} выбыл(а) за бездействие${game.settings.revealDeadRoles && player.role ? ` — ${roleLabel(player.role)}` : ""}.`);
    }
    if (savedCount) lines.push("👨‍⚕️ Доктор предотвратил нападение.");
    if (!mafiaTarget && mafiaVotes) lines.push("🔪 Мафия не смогла договориться.");
    await this.sendTracked(game, lines.join("\n"));
  }

  private async applyNightAfk(game: GameRow, players: PlayerRow[], actions: ActionRow[]): Promise<string[]> {
    if (!game.settings.afkLimit) return [];
    const inactive: string[] = [];
    for (const player of players) {
      if (!player.role || player.role === "citizen") continue;
      const acted = actions.some((action) => action.actor_id === player.user_id);
      const strikes = acted ? 0 : player.afk_strikes + 1;
      await this.db.setAfkStrikes(game.id, player.user_id, strikes);
      if (!acted && strikes >= game.settings.afkLimit) inactive.push(player.user_id);
    }
    return inactive;
  }

  private async sendBumReports(game: GameRow, players: PlayerRow[], actions: ActionRow[]): Promise<void> {
    const aliveIds = new Set(players.filter((player) => player.alive === 1).map((player) => player.user_id));
    for (const visit of actions.filter((action) => action.type === "bum_visit" && aliveIds.has(action.actor_id))) {
      const target = players.find((player) => player.user_id === visit.target_id);
      const guests = actions
        .filter((action) => action.target_id === visit.target_id && action.actor_id !== visit.actor_id && aliveIds.has(action.actor_id))
        .map((action) => players.find((player) => player.user_id === action.actor_id)).filter(isPlayer);
      try {
        await this.bot.telegram.sendMessage(visit.actor_id, [
          `🍾 Вы провели ночь у ${target ? playerName(target) : "неизвестного игрока"}.`,
          guests.length ? `Вы видели гостей: ${guests.map((guest) => playerName(guest)).join(", ")}.` : "Других гостей вы не заметили."
        ].join("\n"), privateHtml());
      } catch (error) {
        this.logger.warn(`Не удалось отправить отчёт Бомжу ${visit.actor_id}`, error);
      }
    }
  }

  private async openNominations(game: GameRow): Promise<void> {
    const current = await this.db.getGame(game.id);
    if (!current || current.phase !== "day") return;
    const alive = await this.db.getPlayers(game.id, true);
    const endsAt = Date.now() + game.settings.nominationSeconds * 1000;
    await this.db.setPhase(game.id, "nomination", game.day, endsAt);
    const updated = (await this.db.getGame(game.id))!;
    await this.cleanupPhaseMessages(updated);
    await this.sendTracked(updated, [
      "📣 <b>Выдвижение кандидатур</b>",
      `У вас <b>${game.settings.nominationSeconds} сек.</b>`,
      "Каждый живой игрок выдвигает кандидата в личных сообщениях с ботом."
    ].join("\n"), this.openBotKeyboard());
    await this.sendNominationPrompts(updated, alive);
    this.schedulePhase(game.id, endsAt);
  }

  private async sendNominationPrompts(game: GameRow, alive: PlayerRow[]): Promise<void> {
    for (const player of alive) {
      try {
        await this.bot.telegram.sendMessage(player.user_id, [
          "📣 <b>Пришло время выдвигать кандидатов!</b>",
          "Кого вы хотите выдвинуть на голосование?"
        ].join("\n"), {
          ...privateHtml(),
          reply_markup: nominationKeyboard(game.id, game.day, alive)
        });
      } catch (error) {
        this.logger.warn(`Не удалось отправить выдвижение игроку ${player.user_id}`, error);
      }
    }
  }

  private async openVotingFromNominations(game: GameRow): Promise<void> {
    const current = await this.db.getGame(game.id);
    if (!current || current.phase !== "nomination") return;
    const alive = await this.db.getPlayers(game.id, true);
    const aliveIds = new Set(alive.map((player) => player.user_id));
    const nominations = await this.db.getNominations(game.id, game.day);
    const candidateIds = [...new Set(nominations.map((item) => item.target_id))].filter((id) => aliveIds.has(id));
    const candidates = candidateIds.map((id) => alive.find((player) => player.user_id === id)).filter(isPlayer);
    if (!candidates.length) {
      await this.cleanupPhaseMessages(game);
      await this.sendTracked(game, "Кандидатов нет. Город переходит к ночи.");
      await this.startNextNight(game.id, game.day + 1);
      return;
    }
    await this.openVoting(game, candidates);
  }

  private async openVoting(game: GameRow, candidates: PlayerRow[]): Promise<void> {
    const alive = await this.db.getPlayers(game.id, true);
    const endsAt = Date.now() + game.settings.voteSeconds * 1000;
    await this.db.setPhase(game.id, "vote", game.day, endsAt);
    const updated = (await this.db.getGame(game.id))!;
    await this.cleanupPhaseMessages(updated);
    await this.sendTracked(updated, [
      "⚖️ <b>Голосование</b>",
      `Время: <b>${game.settings.voteSeconds} сек.</b>`,
      `Кандидаты: ${candidates.map((player) => mention(player)).join(", ")}`,
      "Голосуйте в личных сообщениях с ботом."
    ].join("\n"), this.openBotKeyboard());
    await this.sendTracked(updated, `Право голоса имеют <b>${alive.length}</b> живых игроков.`);
    await this.sendVotePrompts(updated, candidates);
    this.schedulePhase(game.id, endsAt);
  }

  private async sendVotePrompts(game: GameRow, candidates: PlayerRow[]): Promise<void> {
    const alive = await this.db.getPlayers(game.id, true);
    for (const voter of alive) {
      try {
        await this.bot.telegram.sendMessage(voter.user_id, [
          "🔥 <b>Пришло время искать виноватых!</b>",
          "Кого ты хочешь линчевать?"
        ].join("\n"), {
          ...privateHtml(),
          reply_markup: voteKeyboard(game.id, game.day, candidates, game.settings.allowSkipVote)
        });
      } catch (error) {
        this.logger.warn(`Не удалось отправить голосование игроку ${voter.user_id}`, error);
      }
    }
  }

  private async resolveVoting(game: GameRow): Promise<void> {
    const current = await this.db.getGame(game.id);
    if (!current || current.phase !== "vote") return;
    const alive = await this.db.getPlayers(game.id, true);
    const aliveIds = new Set(alive.map((player) => player.user_id));
    const votes = (await this.db.getVotes(game.id, game.day)).filter((vote) => aliveIds.has(vote.voter_id) && (vote.target_id === "skip" || aliveIds.has(vote.target_id)));

    const afkIds: string[] = [];
    if (game.settings.afkLimit) {
      const voters = new Set(votes.map((vote) => vote.voter_id));
      for (const player of alive) {
        const voted = voters.has(player.user_id);
        const strikes = voted ? 0 : player.afk_strikes + 1;
        await this.db.setAfkStrikes(game.id, player.user_id, strikes);
        if (!voted && strikes >= game.settings.afkLimit) afkIds.push(player.user_id);
      }
      await this.db.killPlayers(game.id, afkIds);
    }

    const selected = selectPluralityTarget(votes.map((vote) => vote.target_id));
    const afkSet = new Set(afkIds);
    const selectedPlayer = selected && selected !== "skip" && !afkSet.has(selected)
      ? alive.find((player) => player.user_id === selected)
      : undefined;
    await this.cleanupPhaseMessages(game);
    const lines = ["⚖️ <b>Голосование окончено</b>"];
    if (!selected || selected === "skip") {
      lines.push(!votes.length ? "Никто не проголосовал." : selected === "skip" ? "Город решил никого не изгонять." : "Голоса разделились. Никто не изгнан.");
    } else if (!selectedPlayer) {
      lines.push("Выбранный кандидат уже выбыл за бездействие.");
    } else {
      lines.push(`${mention(selectedPlayer)} получает большинство голосов.`);
    }
    for (const player of alive.filter((item) => afkSet.has(item.user_id))) {
      lines.push(`💤 ${mention(player)} выбыл(а) за пропуск голосований${game.settings.revealDeadRoles && player.role ? ` — ${roleLabel(player.role)}` : ""}.`);
    }
    await this.sendTracked(game, lines.join("\n"));

    if (!selectedPlayer) {
      const winnerAfterAfk = determineWinner(await this.db.getPlayers(game.id, true));
      if (winnerAfterAfk) await this.finishGame(game, winnerAfterAfk);
      else await this.startNextNight(game.id, game.day + 1);
      return;
    }
    if (game.settings.lastWordSeconds > 0) {
      const endsAt = Date.now() + game.settings.lastWordSeconds * 1000;
      await this.db.setPendingElimination(game.id, selectedPlayer.user_id);
      await this.db.setPhase(game.id, "last_word", game.day, endsAt);
      const updated = (await this.db.getGame(game.id))!;
      await this.sendTracked(updated, `🎙 ${mention(selectedPlayer)}, ваше последнее слово. У вас <b>${game.settings.lastWordSeconds} сек.</b>`);
      this.schedulePhase(game.id, endsAt);
    } else {
      await this.eliminateVotedPlayer(game, selectedPlayer);
    }
  }

  private async finalizeLastWord(game: GameRow): Promise<void> {
    const current = await this.db.getGame(game.id);
    if (!current || current.phase !== "last_word") return;
    const player = current.pending_elimination_id ? await this.db.getPlayer(game.id, current.pending_elimination_id) : undefined;
    if (!player?.alive) {
      await this.db.setPendingElimination(game.id, null);
      await this.startNextNight(game.id, game.day + 1);
      return;
    }
    await this.eliminateVotedPlayer(current, player);
  }

  private async eliminateVotedPlayer(game: GameRow, player: PlayerRow): Promise<void> {
    await this.db.killPlayers(game.id, [player.user_id]);
    await this.db.setPendingElimination(game.id, null);
    await this.cleanupPhaseMessages(game);
    await this.sendTracked(game, `${mention(player)} покидает город${game.settings.revealDeadRoles && player.role ? ` — ${roleLabel(player.role)}` : ""}.`);
    const winner = determineWinner(await this.db.getPlayers(game.id, true));
    if (winner) await this.finishGame(game, winner);
    else await this.startNextNight(game.id, game.day + 1);
  }

  private async startNextNight(gameId: number, day: number): Promise<void> {
    const game = await this.db.getGame(gameId);
    if (!game || game.status !== "running") return;
    const delayMs = this.config.betweenPhasesSeconds * 1000;
    const endsAt = Date.now() + delayMs + game.settings.nightSeconds * 1000;
    await this.db.setPhase(game.id, "night", day, endsAt);
    const updated = (await this.db.getGame(game.id))!;
    this.schedulePhase(game.id, endsAt);

    this.promptTimers.set(game.id, setTimeout(() => {
      this.promptTimers.delete(game.id);
      void (async () => {
        const current = await this.db.getGame(game.id);
        if (!current || current.phase !== "night" || current.day !== day) return;
        await this.cleanupPhaseMessages(current);
        await this.sendPhaseMedia(current, "night", `🌃 <b>Ночь ${day}</b> · город засыпает`);
        await this.sendTracked(current, `Активные роли делают выбор в личных сообщениях. На действия: <b>${game.settings.nightSeconds} сек.</b>`, this.openBotKeyboard());
        await this.sendNightPrompts(game.id);
      })().catch((error) => this.logger.error(`Не удалось начать ночь ${day}`, error));
    }, delayMs));
  }

  private async finishIfWinner(game: GameRow): Promise<boolean> {
    const winner = determineWinner(await this.db.getPlayers(game.id, true));
    if (!winner) return false;
    await this.finishGame(game, winner);
    return true;
  }

  private async finishGame(game: GameRow, winner: Winner): Promise<void> {
    this.clearTimers(game.id);
    await this.db.finishGame(game.id, winner);
    await this.cleanupPhaseMessages(game);
    const players = await this.db.getPlayers(game.id);
    await this.bot.telegram.sendMessage(game.chat_id, [
      winnerText(winner),
      "",
      "Рейтинг: /top · Новая игра: /newgame"
    ].join("\n"), { parse_mode: "HTML" });
    const roleLines = players.map((player) => `${roleLabel(player.role!)} — ${mention(player)}`);
    for (const part of chunkLines(roleLines, 3400)) {
      await this.bot.telegram.sendMessage(game.chat_id, ["<b>Роли игроков:</b>", ...part].join("\n"), { parse_mode: "HTML" });
    }
    await this.sendEndGameProfiles(players);
  }

  private async sendEndGameProfiles(players: PlayerRow[]): Promise<void> {
    for (const player of players) {
      try {
        const profile = await this.db.getProfile({
          id: player.user_id,
          username: player.username ?? undefined,
          firstName: player.first_name
        });
        const displayName = player.username ? `@${player.username}` : player.first_name;
        await this.bot.telegram.sendMessage(player.user_id, [
          "🏁 Игра окончена. Ваш профиль:",
          "",
          profileText(displayName, profile)
        ].join("\n"), privateHtml());
      } catch (error) {
        this.logger.warn(`Не удалось отправить профиль игроку ${player.user_id}`, error);
      }
    }
  }

  private async sendTracked(game: GameRow, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
    try {
      const message = await this.bot.telegram.sendMessage(game.chat_id, text, {
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
      if (game.settings.autoDeleteMessages) await this.db.recordGameMessage(game.id, game.chat_id, message.message_id);
    } catch (error) {
      this.logger.warn(`Не удалось отправить сообщение игры ${game.id}`, error);
    }
  }

  private async sendPhaseMedia(game: GameRow, phase: "night" | "day", caption: string): Promise<void> {
    const message = await this.media.send(game.chat_id, phase, caption);
    if (message && game.settings.autoDeleteMessages) await this.db.recordGameMessage(game.id, game.chat_id, message.message_id);
  }

  private async cleanupPhaseMessages(game: GameRow): Promise<void> {
    if (!game.settings.autoDeleteMessages) return;
    const messageIds = await this.db.takeGameMessages(game.id);
    for (const messageId of messageIds) {
      try { await this.bot.telegram.deleteMessage(game.chat_id, messageId); }
      catch (error) { this.logger.debug(`Не удалось удалить сообщение ${messageId}`, error); }
    }
  }
}

function userData(user: { id: number; username?: string; first_name: string }): TelegramUserData {
  return { id: String(user.id), username: user.username, firstName: user.first_name };
}

function nightActionsForRole(role: Role, settings: GameSettings): ActionType[] {
  switch (role) {
    case "mafia": return ["mafia_kill"];
    case "don": return ["mafia_kill", "don_check"];
    case "commissar": return settings.commissionerCanShoot ? ["commissar_check", "commissar_shoot"] : ["commissar_check"];
    case "doctor": return ["doctor_heal"];
    case "maniac": return ["maniac_kill"];
    case "bum": return ["bum_visit"];
    case "citizen": return [];
  }
}

function targetKeyboard(gameId: number, day: number, type: ActionType, players: PlayerRow[]): InlineKeyboardMarkup {
  const buttons = players.map((player) => Markup.button.callback(plainPlayerName(player), `act:${gameId}:${day}:${type}:${player.user_id}`));
  return Markup.inlineKeyboard(chunk(buttons, 2)).reply_markup;
}

function nominationKeyboard(gameId: number, day: number, players: PlayerRow[]): InlineKeyboardMarkup {
  const buttons = players.map((player) => Markup.button.callback(plainPlayerName(player), `nom:${gameId}:${day}:${player.user_id}`));
  return Markup.inlineKeyboard(chunk(buttons, 2)).reply_markup;
}

function voteKeyboard(gameId: number, day: number, players: PlayerRow[], allowSkip: boolean): InlineKeyboardMarkup {
  const buttons = players.map((player) => Markup.button.callback(plainPlayerName(player), `vote:${gameId}:${day}:${player.user_id}`));
  if (allowSkip) buttons.push(Markup.button.callback("⏭ Пропустить", `vote:${gameId}:${day}:skip`));
  return Markup.inlineKeyboard(chunk(buttons, 2)).reply_markup;
}

function settingsKeyboard(settings: GameSettings): InlineKeyboardMarkup {
  const flag = (value: boolean) => value ? "✅" : "❌";
  return Markup.inlineKeyboard([
    [Markup.button.callback(`👥 Мин. ${settings.minPlayers}`, "cfg:minplayers"), Markup.button.callback(`👥 Макс. ${settings.maxPlayers}`, "cfg:maxplayers")],
    [Markup.button.callback(`🌙 Ночь ${settings.nightSeconds}с`, "cfg:night"), Markup.button.callback(`☀️ День ${settings.daySeconds}с`, "cfg:day")],
    [Markup.button.callback(`📣 Кандидаты ${settings.nominationSeconds}с`, "cfg:nomtime"), Markup.button.callback(`⚖️ Голос ${settings.voteSeconds}с`, "cfg:votetime")],
    [Markup.button.callback(`🎙 Слово ${settings.lastWordSeconds}с`, "cfg:lastword"), Markup.button.callback(`💤 AFK ${settings.afkLimit || "выкл"}`, "cfg:afk")],
    [Markup.button.callback(`${flag(settings.nominationsEnabled)} Кандидатуры`, "cfg:nominations"), Markup.button.callback(`${flag(settings.revealDeadRoles)} Роли`, "cfg:reveal")],
    [Markup.button.callback(`${flag(settings.doctorSelfHeal)} Самолечение`, "cfg:selfheal"), Markup.button.callback(`${flag(settings.commissionerCanShoot)} Выстрел`, "cfg:shoot")],
    [Markup.button.callback(`${flag(settings.allowSelfVote)} За себя`, "cfg:selfvote"), Markup.button.callback(`${flag(settings.allowSkipVote)} Пропуск`, "cfg:skip")],
    [Markup.button.callback(`${flag(settings.autoDeleteMessages)} Автоудаление`, "cfg:autodelete")],
    [Markup.button.callback(`${flag(settings.roles.don)} Дон`, "cfg:role_don"), Markup.button.callback(`${flag(settings.roles.commissar)} Комиссар`, "cfg:role_commissar")],
    [Markup.button.callback(`${flag(settings.roles.doctor)} Доктор`, "cfg:role_doctor"), Markup.button.callback(`${flag(settings.roles.maniac)} Маньяк`, "cfg:role_maniac")],
    [Markup.button.callback(`${flag(settings.roles.bum)} Бомж`, "cfg:role_bum")]
  ]).reply_markup;
}

function shopKeyboard(): InlineKeyboardMarkup {
  return Markup.inlineKeyboard(
    Object.entries(SHOP_ITEMS).map(([key, item]) =>
      Markup.button.callback(`${item.title} — ${item.price}💵`, `shop:${key}`))
      .map((button) => [button])
  ).reply_markup;
}

function mutateSetting(settings: GameSettings, key: string): void {
  const timers = [15, 30, 45, 60, 90, 120, 180];
  const cycle = (value: number, values = timers) => values[(Math.max(0, values.indexOf(value)) + 1) % values.length]!;
  switch (key) {
    case "minplayers":
      settings.minPlayers = cycle(settings.minPlayers, [5, 6, 7, 8, 9, 10, 12, 15]);
      if (settings.maxPlayers < settings.minPlayers) settings.maxPlayers = settings.minPlayers;
      break;
    case "maxplayers":
      settings.maxPlayers = cycle(settings.maxPlayers, [10, 15, 20, 30, 40, 50].filter((value) => value >= settings.minPlayers));
      break;
    case "night": settings.nightSeconds = cycle(settings.nightSeconds); break;
    case "day": settings.daySeconds = cycle(settings.daySeconds); break;
    case "nomtime": settings.nominationSeconds = cycle(settings.nominationSeconds); break;
    case "votetime": settings.voteSeconds = cycle(settings.voteSeconds); break;
    case "lastword": settings.lastWordSeconds = cycle(settings.lastWordSeconds, [0, 10, 15, 30, 45, 60]); break;
    case "afk": settings.afkLimit = cycle(settings.afkLimit, [0, 1, 2, 3]); break;
    case "nominations": settings.nominationsEnabled = !settings.nominationsEnabled; break;
    case "reveal": settings.revealDeadRoles = !settings.revealDeadRoles; break;
    case "selfheal": settings.doctorSelfHeal = !settings.doctorSelfHeal; break;
    case "shoot": settings.commissionerCanShoot = !settings.commissionerCanShoot; break;
    case "selfvote": settings.allowSelfVote = !settings.allowSelfVote; break;
    case "skip": settings.allowSkipVote = !settings.allowSkipVote; break;
    case "autodelete": settings.autoDeleteMessages = !settings.autoDeleteMessages; break;
    case "role_don": settings.roles.don = !settings.roles.don; break;
    case "role_commissar": settings.roles.commissar = !settings.roles.commissar; break;
    case "role_doctor": settings.roles.doctor = !settings.roles.doctor; break;
    case "role_maniac": settings.roles.maniac = !settings.roles.maniac; break;
    case "role_bum": settings.roles.bum = !settings.roles.bum; break;
  }
}

function validSingleActionTarget(actions: ActionRow[], players: PlayerRow[], aliveIds: Set<string>, type: ActionType, role: Role): string | null {
  return actions.find((action) => {
    const actor = players.find((player) => player.user_id === action.actor_id);
    return action.type === type && aliveIds.has(action.actor_id) && aliveIds.has(action.target_id) && actor?.role === role;
  })?.target_id ?? null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function chunkLines(lines: string[], maximumLength: number): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (current.length && length + line.length + 1 > maximumLength) {
      parts.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) parts.push(current);
  return parts;
}

function plainPlayerName(player: Pick<PlayerRow, "username" | "first_name">): string {
  const value = player.username ? `@${player.username}` : player.first_name;
  return value.length > 28 ? `${value.slice(0, 27)}…` : value;
}

function isPlayer(player: PlayerRow | undefined): player is PlayerRow {
  return player !== undefined;
}

function isActivePhase(phase: GameRow["phase"]): phase is ActivePhase {
  return ["night", "day", "nomination", "vote", "last_word"].includes(phase);
}

function privateHtml(): { parse_mode: "HTML"; protect_content: true } {
  return { parse_mode: "HTML", protect_content: true };
}

function repliedUser(ctx: Context): { id: number } | undefined {
  const message = ctx.message;
  if (!message || !("reply_to_message" in message)) return undefined;
  return message.reply_to_message?.from;
}

async function safeAnswerCallback(ctx: Context, text?: string, showAlert = false): Promise<void> {
  if (!("callbackQuery" in ctx.update)) return;
  try { await ctx.answerCbQuery(text, { show_alert: showAlert }); } catch { /* stale callback */ }
}

function phaseName(phase: GameRow["phase"]): string {
  switch (phase) {
    case "lobby": return "набор";
    case "night": return "ночь";
    case "day": return "обсуждение";
    case "nomination": return "выдвижение";
    case "vote": return "голосование";
    case "last_word": return "последнее слово";
    case "paused": return "пауза";
    case "finished": return "игра окончена";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}
