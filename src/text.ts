import type { Currency, GameRow, GameSettings, PlayerRow, Role, ShopItem, UserProfile, Winner } from "./types.js";
import { ROLES, SHOP_ITEMS } from "./types.js";

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function playerName(player: Pick<PlayerRow, "first_name" | "username">): string {
  return player.username ? `@${escapeHtml(player.username)}` : escapeHtml(player.first_name);
}

export function mention(player: Pick<PlayerRow, "user_id" | "first_name" | "username">): string {
  const label = player.username ? `@${escapeHtml(player.username)}` : escapeHtml(player.first_name);
  return `<a href="tg://user?id=${player.user_id}">${label}</a>`;
}

export function roleLabel(role: Role): string {
  const info = ROLES[role];
  if (!info) return "❔ <b>Неизвестная роль</b>";
  return `${info.emoji} <b>${info.title}</b>`;
}

export function roleDescription(role: Role): string {
  switch (role) {
    case "citizen": return "Днём обсуждайте события, вычисляйте преступников и голосуйте. Ночью вы спите.";
    case "mafia": return "Ночью вместе с мафией выберите жертву. Для тайной связи используйте /mafia текст.";
    case "don": return "Вы глава мафии: участвуете в убийстве и можете искать Комиссара.";
    case "commissar": return "Главный городской защитник и гроза мафии. Каждую ночь проверяйте одного игрока на связь с мафией, а при включённой стрельбе можете вместо проверки сделать выстрел.";
    case "doctor": return "Каждую ночь спасайте одного игрока от всех атак. Одну цель нельзя лечить две ночи подряд.";
    case "maniac": return "Каждую ночь выбирайте жертву. Вы победите, если останетесь единственным выжившим.";
    case "bum": return "Ночью идите в гости к игроку и узнавайте, кто ещё к нему приходил.";
    case "kamikaze": return "Если вас изгонят или убьют, вы утянете с собой одного из тех, кто голосовал против вас.";
    case "sergeant": return "Напарник Комиссара: вы видите результаты его проверок. Если Комиссар погибнет, следующей ночью вы примете его роль.";
    case "lawyer": return "Пособник мафии, но вы не знаете клан. Ночью выберите подзащитного: если его проверят, он покажется Мирным жителем.";
    case "lucky": return "У вас пассивный щит: вы переживаете первое смертельное ночное нападение. Щит ломается, при следующей атаке или казни вы погибаете.";
    case "suicide": return "Вы побеждаете, только если город казнит вас на дневном голосовании. Ночью вы не действуете.";
    case "mistress": return "Ночью вы навещаете игрока: он теряет ночное действие и не может голосовать днём. Если вас убьют ночью, блок не срабатывает.";
  }
}

export function lobbyText(brandName: string, game: GameRow, players: PlayerRow[]): string {
  // Каждое имя — кликабельная ссылка на профиль: <a href="tg://user?id=USER_ID">Имя</a>.
  // Отправлять/редактировать этот текст нужно только с parse_mode: "HTML".
  const names = players.map((player, index) => `${index + 1}. ${mention(player)}`).join("\n");
  const chatTitle = game.chat_title ? ` ${escapeHtml(game.chat_title)}` : "";
  return [
    `<b>${escapeHtml(brandName)}</b>${chatTitle}`,
    "<b>Ведётся набор в игру</b>",
    "",
    "<b>Зарегистрировались:</b>",
    names ? names : "Пока никого нет.",
    "",
    `Итого <b>${players.length}</b> чел.`
  ].join("\n");
}

const ROLE_LIST_ORDER: Role[] = [
  "citizen", "mafia", "lucky", "doctor", "commissar", "don",
  "maniac", "bum", "kamikaze", "sergeant", "lawyer", "suicide", "mistress"
];

function roleListTitle(role: Role): string {
  return ROLES[role].title;
}

export function alivePlayersText(players: PlayerRow[], settings?: GameSettings, showTotal = true): string {
  const list = players.map((player, index) =>
    `${index + 1}. ${player.username ? escapeHtml(player.username) : escapeHtml(player.first_name)}`
  ).join("\n");
  const lines: string[] = [
    "<b>Живые игроки:</b>",
    "",
    list
  ];

  if (settings) {
    const roleCounts = new Map<Role, number>();
    for (const player of players) {
      if (player.role) roleCounts.set(player.role, (roleCounts.get(player.role) ?? 0) + 1);
    }
    const presentRoles = ROLE_LIST_ORDER.filter((role) => (roleCounts.get(role) ?? 0) > 0 && ({
      citizen: true,
      mafia: true,
      don: settings.roles.don,
      commissar: settings.roles.commissar,
      doctor: settings.roles.doctor,
      maniac: settings.roles.maniac,
      bum: settings.roles.bum,
      kamikaze: settings.roles.kamikaze,
      sergeant: settings.roles.sergeant,
      lawyer: settings.roles.lawyer,
      lucky: settings.roles.lucky,
      suicide: settings.roles.suicide,
      mistress: settings.roles.mistress
    } as Record<Role, boolean>)[role]);
    const parts = presentRoles.map((role) => {
      const count = roleCounts.get(role) ?? 0;
      const base = `${ROLES[role].emoji} ${roleListTitle(role)}`;
      return count > 1 ? `${base} - ${count}` : base;
    });
    lines.push(
      "",
      "<b>Кто-то из них:</b>",
      `${parts.join(", ")}.`,
      "",
      `Всего: ${players.length} чел.`
    );
  } else if (showTotal) {
    lines.push("", `Всего: <b>${players.length}</b>`);
  }

  return lines.join("\n");
}

export function winnerText(winner: Winner): string {
  switch (winner) {
    case "town": return "🏆 <b>Мирный город победил!</b>\nВсе представители мафии и Маньяк выбыли.";
    case "mafia": return "🔪 <b>Мафия победила!</b>\nПреступники захватили город.";
    case "maniac": return "🪓 <b>Маньяк победил!</b>\nОн остался единственным выжившим.";
    case "suicide": return "💀 <b>Самоубийца победил!</b>\nГород казнил его, сыграв его игру.";
    case "mistress": return "💋 <b>Любовница победила!</b>\nОна осталась последней, оставив город во тьме.";
  }
}

export function settingsText(settings: GameSettings): string {
  const enabledRoles = [
    settings.roles.don && "Дон",
    settings.roles.commissar && "Комиссар",
    settings.roles.doctor && "Доктор",
    settings.roles.maniac && "Маньяк",
    settings.roles.bum && "Бомж",
    settings.roles.kamikaze && "Камикадзе",
    settings.roles.sergeant && "Сержант",
    settings.roles.lawyer && "Адвокат",
    settings.roles.lucky && "Счастливчик",
    settings.roles.suicide && "Самоубийца",
    settings.roles.mistress && "Любовница"
  ].filter(Boolean).join(", ");
  return [
    "⚙️ <b>Настройки игры</b>",
    "",
    `<b>Игроки:</b> ${settings.minPlayers}–${settings.maxPlayers}`,
    `<b>Таймеры:</b> ночь ${settings.nightSeconds}с · день ${settings.daySeconds}с · голосование ${settings.voteSeconds}с · последнее слово ${settings.lastWordSeconds}с · суд ${settings.judgeSeconds}с`,
    `<b>Роли:</b> ${enabledRoles || "только Мафия и Мирные"}`,
    "",
    `${flag(settings.revealDeadRoles)} Раскрывать роли выбывших`,
    `${flag(settings.doctorSelfHeal)} Доктор может лечить себя`,
    `${flag(settings.commissionerCanShoot)} Комиссар может стрелять`,
    `${flag(settings.allowSelfVote)} Голосование за себя`,
    `${flag(settings.allowSkipVote)} Вариант «пропустить»`,
    `${flag(settings.autoDeleteMessages)} Удалять сообщения прошлой фазы`,
    `${flag(settings.friendlyFire)} Огонь по своим (Friendly Fire)`,
    `${settings.afkLimit > 0 ? "✅" : "❌"} AFK: ${settings.afkLimit > 0 ? `${settings.afkLimit} пропуска` : "отключён"}`,
    "",
    "Настройки применяются к текущему набору и следующим играм. Уже начатая игра не меняется."
  ].join("\n");
}

function flag(value: boolean): string {
  return value ? "✅" : "❌";
}

export function profileText(displayName: string, profile: UserProfile): string {
  return [
    `👤 <b>${escapeHtml(displayName)}</b>`,
    "",
    `💵 Деньги: <b>${profile.money}</b>`,
    `💎 Камни: <b>${profile.gems}</b>`,
    "",
    `🛡 Защита: <b>${profile.protection}</b>`,
    `📂 Документы: <b>${profile.documents}</b>`,
    `🎭 Активная роль: <b>${profile.active_role}</b>`
  ].join("\n");
}

export function currencyLabel(currency: Currency): string {
  return currency === "gems" ? "💎" : "💵";
}

export function priceLabel(item: (typeof SHOP_ITEMS)[ShopItem]): string {
  return `${item.price} ${currencyLabel(item.currency)}`;
}

export function shopText(profile: UserProfile): string {
  return [
    "Что будем покупать?",
    "",
    ...Object.values(SHOP_ITEMS).flatMap((item) => [
      item.title,
      item.description,
      ""
    ]),
    `Ваш баланс: 💵 <b>${profile.money}</b> · 💎 <b>${profile.gems}</b>`
  ].join("\n");
}
