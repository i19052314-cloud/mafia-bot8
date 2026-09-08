import { createServer, type Server } from "node:http";
import { Telegraf, type Context, type MiddlewareFn } from "telegraf";
import { loadConfig } from "./config.js";
import { GameDatabase } from "./database.js";
import { GameEngine } from "./game-engine.js";
import { Logger } from "./logger.js";
import { PhaseMedia } from "./media.js";
import { escapeHtml } from "./text.js";
import type { ActionType, ShopItem } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const db = new GameDatabase(config.databaseUrl, config.defaults, config.databaseSsl);
  await db.migrate();
  const bot = new Telegraf(config.token);
  const me = await bot.telegram.getMe();
  const media = new PhaseMedia(bot, config.assetsDirectory, logger);
  const engine = new GameEngine(bot, db, config, me.username, logger, media);
  const healthServer = config.healthPort ? startHealthServer(config.healthPort, db, logger) : undefined;

  bot.use(rateLimitMiddleware());

  bot.start(async (ctx) => {
    const joinMatch = /^join_(\d+)$/.exec(ctx.startPayload ?? "");
    if (joinMatch) {
      await engine.joinFromPrivate(ctx, Number(joinMatch[1]));
      await safeShowProfile(ctx);
      return;
    }
    await ctx.reply([
      `🎭 <b>${escapeHtml(config.brandName)}</b>`,
      "Я провожу игру в Мафию: раздаю тайные роли, принимаю ночные действия, веду кандидатуры и голосование.",
      "",
      "1. Добавьте меня в группу.",
      "2. Отправьте /newgame.",
      "3. Игроки нажимают «Присоединиться».",
      "4. Ведущий нажимает «Начать игру».",
      "",
      "Справка: /help · Конфиденциальность: /privacy"
    ].join("\n"), { parse_mode: "HTML" });
    await safeShowProfile(ctx);
  });

  async function safeShowProfile(ctx: Context): Promise<void> {
    try {
      await engine.showProfile(ctx);
    } catch (error) {
      logger.error("Не удалось показать профиль при /start", error);
      try { await ctx.reply("Не удалось загрузить профиль. Попробуйте команду /profile."); } catch { /* noop */ }
    }
  }

  bot.command(["newgame", "game"], (ctx) => engine.createLobby(ctx));
  bot.command("join", (ctx) => engine.sendJoinButton(ctx));
  bot.command("leave", (ctx) => engine.leaveGame(ctx));
  bot.command("players", (ctx) => engine.showPlayers(ctx));
  bot.command("stopgame", (ctx) => engine.stopGame(ctx));
  bot.command("pause", (ctx) => engine.pauseGame(ctx));
  bot.command("resume", (ctx) => engine.resumeGame(ctx));
  bot.command("extend", (ctx) => engine.extendGame(ctx, parseNumberArgument(ctx, 30)));
  bot.command("nextphase", (ctx) => engine.forceNextPhase(ctx));
  bot.command("kick", (ctx) => engine.kickRepliedPlayer(ctx));
  bot.command("transfer", (ctx) => engine.transferHost(ctx));
  bot.command("settings", (ctx) => engine.showSettings(ctx));
  bot.command("adminlog", (ctx) => engine.showAdminLog(ctx));
  bot.command("stats", (ctx) => engine.showStats(ctx));
  bot.command("top", (ctx) => engine.showTop(ctx));
  bot.command("profile", (ctx) => engine.showProfile(ctx));
  bot.command("shop", (ctx) => engine.showShop(ctx));
  bot.command("mafia", (ctx) => engine.relayMafiaMessage(ctx, commandArgument(ctx)));
  bot.command("deleteme", (ctx) => engine.deleteMyData(ctx));
  bot.command("report", (ctx) => engine.sendReport(ctx, commandArgument(ctx)));
  bot.command("give", (ctx) => engine.giveCurrency(ctx, commandArgument(ctx)));

  bot.command("begin", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("Команда работает в игровой группе.");
      return;
    }
    const game = await db.getActiveGameByChat(String(ctx.chat.id));
    if (!game || game.status !== "lobby") {
      await ctx.reply("Активного набора нет.");
      return;
    }
    await engine.beginGame(ctx, game.id);
  });

  bot.command("rules", async (ctx) => {
    await ctx.reply([
      "📖 <b>Правила Mafia Noir</b>",
      "",
      "Ночью активные роли выбирают цели в личном чате. Днём город обсуждает события, выдвигает кандидатов и голосует.",
      "",
      "🔪 <b>Мафия</b> и 🤵 <b>Дон</b> выбирают общую жертву. При ничьей выстрела нет.",
      "🤵 <b>Дон</b> ищет Комиссара.",
      "👮 <b>Комиссар</b> проверяет игроков; выстрел может быть включён администратором.",
      "👨‍⚕️ <b>Доктор</b> спасает от всех атак и не лечит одну цель две ночи подряд.",
      "🪓 <b>Маньяк</b> действует один и стремится остаться последним.",
      "🧔 <b>Бомж</b> видит гостей выбранного игрока.",
      "🎖️ <b>Сержант</b> — напарник Комиссара, наследует его роль после гибели.",
      "🎩 <b>Адвокат</b> укрывает подзащитного от проверки.",
      "🍀 <b>Счастливчик</b> переживает первое ночное нападение.",
      "💀 <b>Самоубийца</b> побеждает, если город казнит его.",
      "💋 <b>Любовница</b> блокирует ночное действие и голос цели.",
      "👨 <b>Мирные</b> ищут преступников голосованием.",
      "",
      "Пропуски действий учитывает AFK-система. Точные правила группы показаны в /settings."
    ].join("\n"), { parse_mode: "HTML" });
  });

  bot.command("privacy", async (ctx) => {
    await ctx.reply([
      "🔐 <b>Конфиденциальность</b>",
      "",
      "Бот хранит Telegram ID, имя, username, участие в играх, роли, статистику и игровой профиль (деньги, камни, покупки). Данные используются только для проведения игр, защиты от злоупотреблений и подсчёта результатов.",
      "",
      "Данные не продаются и не передаются рекламным сетям. Сообщения тайного чата мафии пересылаются только живым членам команды и отдельно не сохраняются.",
      "",
      "Удаление данных: /deleteme в личном чате. Данные активной игры удаляются после её завершения или выхода из набора.",
      `Контакт владельца данных: ${escapeHtml(config.privacyContact)}`
    ].join("\n"), { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply([
      "🛠 <b>Команды Mafia Noir</b>",
      "/newgame — открыть набор",
      "/join — кнопка присоединения",
      "/leave — выйти из набора или игры",
      "/begin — начать игру",
      "/players — игроки",
      "/settings — правила группы",
      "/adminlog — журнал действий администраторов",
      "/pause, /resume — пауза и продолжение",
      "/extend 30 — продлить фазу",
      "/nextphase — завершить текущую фазу",
      "/kick — исключить игрока ответом на сообщение",
      "/transfer — передать ведущего ответом",
      "/stopgame — отменить игру",
      "/mafia текст — тайный чат мафии в личке",
      "/stats, /top — статистика и рейтинг",
      "/profile — игровой профиль",
      "/shop — магазин",
      "/rules — правила",
      "/report текст — написать владельцу",
      "/privacy, /deleteme — данные пользователя",
      "",
      "Команды управления доступны ведущему и администраторам."
    ].join("\n"), { parse_mode: "HTML" });
  });

  bot.action(/^leave:(\d+)$/, (ctx) => engine.leaveLobby(ctx, Number(ctx.match[1])));
  bot.action(/^refresh:(\d+)$/, (ctx) => engine.refreshLobby(ctx, Number(ctx.match[1])));
  bot.action(/^begin:(\d+)$/, (ctx) => engine.beginGame(ctx, Number(ctx.match[1])));
  bot.action(/^cfg:([a-z_]+)$/, (ctx) => engine.handleSetting(ctx, ctx.match[1]!));
  bot.action(/^profile:shop$/, (ctx) => engine.openShop(ctx));
  bot.action(/^profile:back$/, (ctx) => engine.backToProfile(ctx));
  bot.action(/^profile:buy_money$/, (ctx) => engine.handleBuyCurrency(ctx, "money"));
  bot.action(/^profile:buy_gems$/, (ctx) => engine.handleBuyCurrency(ctx, "gems"));
  bot.action(/^shop:(documents|protection|active_role)$/, (ctx) => engine.handleShopPurchase(ctx, ctx.match[1] as ShopItem));
  bot.action(/^nom:(\d+):(\d+):(-?\d+)$/,
    (ctx) => engine.handleNomination(ctx, Number(ctx.match[1]), Number(ctx.match[2]), ctx.match[3]!));
  bot.action(/^vote:(\d+):(\d+):(skip|-?\d+)$/,
    (ctx) => engine.handleVote(ctx, Number(ctx.match[1]), Number(ctx.match[2]), ctx.match[3]!));
  bot.action(/^judge:(\d+):(\d+):(yes|no)$/,
    (ctx) => engine.handleJudgmentVote(ctx, Number(ctx.match[1]), Number(ctx.match[2]), ctx.match[3] as "yes" | "no"));
  bot.action(/^act:(\d+):(\d+):(mafia_kill|don_check|commissar_check|commissar_shoot|doctor_heal|maniac_kill|bum_visit|lawyer_defend|mistress_visit):(-?\d+)$/,
    (ctx) => engine.handleNightAction(ctx, Number(ctx.match[1]), Number(ctx.match[2]), ctx.match[3] as ActionType, ctx.match[4]!));
  bot.action(/^cc:(\d+):(\d+):(check|shoot)$/,
    (ctx) => engine.handleCommissionerChoice(ctx, Number(ctx.match[1]), Number(ctx.match[2]), ctx.match[3] as "check" | "shoot"));

  let lastOwnerAlert = 0;
  bot.catch(async (error, ctx) => {
    logger.error(`Необработанная ошибка в update ${ctx.update.update_id}`, error);
    try { await ctx.reply("⚠️ Произошла внутренняя ошибка. Попробуйте ещё раз чуть позже."); } catch { /* chat may be unavailable */ }
    if (!config.ownerTelegramId || Date.now() - lastOwnerAlert < 60_000) return;
    lastOwnerAlert = Date.now();
    try {
      await bot.telegram.sendMessage(config.ownerTelegramId,
        `🚨 Ошибка Mafia Noir\nUpdate: <code>${ctx.update.update_id}</code>\n<code>${escapeHtml(String(error).slice(0, 3000))}</code>`,
        { parse_mode: "HTML" });
    } catch (notifyError) {
      logger.warn("Не удалось уведомить владельца", notifyError);
    }
  });

  await bot.telegram.setMyDescription("Mafia Noir проводит полноценную игру в группах: тайные роли, ночные действия, кандидатуры, голосование, AFK-контроль и статистика.", "ru");
  await bot.telegram.setMyShortDescription("Кинематографичная Мафия для групповых чатов.", "ru");
  await bot.telegram.setMyCommands([
    { command: "newgame", description: "Открыть набор" },
    { command: "join", description: "Присоединиться" },
    { command: "begin", description: "Начать игру" },
    { command: "players", description: "Игроки" },
    { command: "settings", description: "Настройки группы" },
    { command: "adminlog", description: "Журнал администраторов" },
    { command: "pause", description: "Поставить на паузу" },
    { command: "resume", description: "Продолжить игру" },
    { command: "extend", description: "Продлить текущую фазу" },
    { command: "rules", description: "Правила и роли" },
    { command: "stats", description: "Моя статистика" },
    { command: "top", description: "Рейтинг игроков" },
    { command: "profile", description: "Игровой профиль" },
    { command: "shop", description: "Магазин" },
    { command: "report", description: "Сообщить о проблеме" },
    { command: "privacy", description: "Конфиденциальность" },
    { command: "help", description: "Все команды" }
  ]);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Получен ${signal}, завершаю работу`);
    engine.shutdown();
    try { bot.stop(signal); } catch { /* startup had not completed */ }
    await closeServer(healthServer);
    await db.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  let markLaunched!: () => void;
  let launchError: unknown;
  const launched = new Promise<void>((resolve) => { markLaunched = resolve; });
  const polling = bot.launch({ dropPendingUpdates: true }, markLaunched).catch((error: unknown) => {
    launchError = error;
    markLaunched();
  });
  await launched;
  if (launchError) throw launchError;
  logger.info(`Бот @${me.username} запущен`, { database: "postgresql", healthPort: config.healthPort || null });
  await engine.resumeGames();
  await polling;
  if (launchError) throw launchError;
}

function commandArgument(ctx: Context): string {
  const message = ctx.message;
  if (!message || !("text" in message)) return "";
  return message.text.replace(/^\/\w+(?:@\w+)?\s*/u, "").trim();
}

function parseNumberArgument(ctx: Context, fallback: number): number {
  const value = Number(commandArgument(ctx));
  return Number.isFinite(value) ? value : fallback;
}

function rateLimitMiddleware(): MiddlewareFn<Context> {
  const buckets = new Map<number, number[]>();
  return async (ctx, next) => {
    if (!ctx.from) return next();
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [userId, timestamps] of buckets) {
        if (!timestamps.length || now - timestamps[timestamps.length - 1]! > 60_000) buckets.delete(userId);
      }
    }
    const recent = (buckets.get(ctx.from.id) ?? []).filter((timestamp) => now - timestamp < 10_000);
    recent.push(now);
    buckets.set(ctx.from.id, recent);
    if (recent.length <= 20) return next();
    if ("callbackQuery" in ctx.update) {
      try { await ctx.answerCbQuery("Слишком много действий. Подождите несколько секунд.", { show_alert: true }); } catch { /* noop */ }
    } else if (recent.length === 21) {
      await ctx.reply("Слишком много команд. Подождите несколько секунд.");
    }
  };
}

function startHealthServer(port: number, db: GameDatabase, logger: Logger): Server {
  const startedAt = Date.now();
  const server = createServer(async (request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      const database = await db.ping();
      response.writeHead(database ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: database, database, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
    } catch (error) {
      logger.warn("Health check failed", error);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, database: false }));
    }
  });
  server.listen(port, "0.0.0.0", () => logger.info(`Health endpoint: 0.0.0.0:${port}/health`));
  return server;
}

function closeServer(server?: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
