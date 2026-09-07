import { randomInt } from "node:crypto";
import type { GameSettings, PlayerRow, Role, Winner } from "./types.js";

export function buildRoleDeck(playerCount: number, settings: GameSettings): Role[] {
  if (playerCount < settings.minPlayers) {
    throw new Error(`Для игры нужно минимум ${settings.minPlayers} игроков`);
  }

  const mafiaTeamSize = Math.max(1, Math.floor(playerCount / 4));
  const roles: Role[] = [];
  if (settings.roles.don && playerCount >= 6) {
    roles.push("don");
    for (let index = 1; index < mafiaTeamSize; index += 1) roles.push("mafia");
  } else {
    for (let index = 0; index < mafiaTeamSize; index += 1) roles.push("mafia");
  }

  const optional: Array<[Role, boolean, number]> = [
    ["commissar", settings.roles.commissar, 5],
    ["doctor", settings.roles.doctor, 5],
    ["bum", settings.roles.bum, 7],
    ["maniac", settings.roles.maniac, 8],
    ["kamikaze", settings.roles.kamikaze, 8]
  ];
  for (const [role, enabled, threshold] of optional) {
    if (enabled && playerCount >= threshold && roles.length < playerCount) roles.push(role);
  }
  while (roles.length < playerCount) roles.push("citizen");
  return roles;
}

export function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

export function assignRoles(userIds: string[], settings: GameSettings): Map<string, Role> {
  const roles = shuffled(buildRoleDeck(userIds.length, settings));
  const users = shuffled(userIds);
  return new Map(users.map((userId, index) => [userId, roles[index]!]));
}

export function determineWinner(alivePlayers: Pick<PlayerRow, "role">[]): Winner | null {
  const mafiaCount = alivePlayers.filter((player) => player.role === "mafia" || player.role === "don").length;
  const maniacCount = alivePlayers.filter((player) => player.role === "maniac").length;
  const total = alivePlayers.length;

  if (total === 0) return "town";
  if (maniacCount === 1 && total === 1) return "maniac";
  if (mafiaCount === 0 && maniacCount === 0) return "town";
  if (mafiaCount > 0 && mafiaCount >= total - mafiaCount) return "mafia";
  return null;
}

export function selectPluralityTarget(targetIds: string[]): string | null {
  if (targetIds.length === 0) return null;
  const counts = new Map<string, number>();
  for (const id of targetIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const maximum = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, count]) => count === maximum).map(([id]) => id);
  return leaders.length === 1 ? leaders[0]! : null;
}
