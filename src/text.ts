import type { GameRow, GameSettings, PlayerRow, Role, UserProfile, Winner } from "./types.js";
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
  return `${info.emoji} <b>${info.title}</b>`;
}

export function roleDescription(role: Role): string {
  switch (role) {
    case "citizen": return "Днём выдвигайте кандидатов, вычисляйте преступников и голосуйте. Ночью вы спите.";
    case "mafia": return "Ночью вместе с мафией выберите жертву. Для тайной связи используйте /mafia текст.";
    case "don": return "Вы глава мафии: участвуете в убийстве и можете искать Комиссара.";
    case "commissar": return "Каждую ночь проверяйте игрока. Если стрельба разрешена настройками, вместо проверки можно сделать выстрел.";
    case "doctor": return "Каждую ночь спасайте одного игрока от всех атак. Одну цель нельзя лечить две ночи подряд.";
    case "maniac": return "Каждую ночь выбирайте жертву. Вы победите, если останетесь единственным выжившим.";
    case "bum": return "Ночью идите в гости к игроку и узнавайте, кто ещё к нему приходил.";
  }
}

export function lobbyText(brandName: string, game: GameRow, players: PlayerRow[]): string {
  const names = players.length
    ? players.map((player) => mention(player)).join(", ")
    : "Пока никого нет";
  return [
    "<b>Ведётся набор в игру</b>",
    "",
    "Зарегистрировались::",
    "",
    names,
    "",
    `Итого ${players.length} чел.`
  ].join("\n");
}

export function alivePlayersText(players: PlayerRow[]): string {
  return [
    "<b>Живые игроки:</b>",
    ...players.map((player, index) => `${index + 1}. ${mention(player)}${player.afk_strikes ? ` · ⚠️ ${player.afk_strikes}` : ""}`),
    "",
    `Всего: <b>${players.length}</b>`
  ].join("\n");
}

export function winnerText(winner: Winner): string {
  switch (winner) {
    case "town": return "🏆 <b>Мирный город победил!</b>\nВсе представители мафии и Маньяк выбыли.";
    case "mafia": return "🔪 <b>Мафия победила!</b>\nПреступники захватили город.";
    case "maniac": return "🪓 <b>Маньяк победил!</b>\nОн остался единственным выжившим.";
  }
}

export function settingsText(settings: GameSettings): string {
  const enabledRoles = [
    settings.roles.don && "Дон",
    settings.roles.commissar && "Комиссар",
    settings.roles.doctor && "Доктор",
    settings.roles.maniac && "Маньяк",
    settings.roles.bum && "Бомж"
  ].filter(Boolean).join(", ");
  return [
    "⚙️ <b>Настройки игры</b>",
    "",
    `<b>Игроки:</b> ${settings.minPlayers}–${settings.maxPlayers}`,
    `<b>Таймеры:</b> ночь ${settings.nightSeconds}с · день ${settings.daySeconds}с · кандидатуры ${settings.nominationSeconds}с · голосование ${settings.voteSeconds}с · последнее слово ${settings.lastWordSeconds}с`,
    `<b>Роли:</b> ${enabledRoles || "только Мафия и Мирные"}`,
    "",
    `${flag(settings.nominationsEnabled)} Кандидатуры перед голосованием`,
    `${flag(settings.revealDeadRoles)} Раскрывать роли выбывших`,
    `${flag(settings.doctorSelfHeal)} Доктор может лечить себя`,
    `${flag(settings.commissionerCanShoot)} Комиссар может стрелять`,
    `${flag(settings.allowSelfVote)} Голосование за себя`,
    `${flag(settings.allowSkipVote)} Вариант «пропустить»`,
    `${flag(settings.autoDeleteMessages)} Удалять сообщения прошлой фазы`,
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

export function shopText(profile: UserProfile): string {
  return [
    "🛒 <b>Магазин</b>",
    "Что будем покупать?",
    "",
    ...Object.values(SHOP_ITEMS).flatMap((item) => [
      `${item.title} — 💵 ${item.price}`,
      item.description,
      ""
    ]),
    `Ваш баланс: 💵 <b>${profile.money}</b>`
  ].join("\n");
}
