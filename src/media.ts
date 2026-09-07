import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Input, type Context, type Telegraf } from "telegraf";
import type { Message } from "telegraf/types";
import type { Logger } from "./logger.js";

export class PhaseMedia {
  private readonly animationFileIds = new Map<"night" | "day", string>();
  private readonly photoFileIds = new Map<"night" | "day", string>();

  constructor(
    private readonly bot: Telegraf<Context>,
    private readonly assetsDirectory: string,
    private readonly logger: Logger
  ) {}

  async send(chatId: string, phase: "night" | "day", caption: string): Promise<Message.PhotoMessage | Message.AnimationMessage | null> {
    const gif = resolve(this.assetsDirectory, `${phase}-noir.gif`);
    const png = resolve(this.assetsDirectory, `${phase}-noir.png`);
    try {
      if (existsSync(gif)) {
        let message: Message.AnimationMessage;
        const cached = this.animationFileIds.get(phase);
        try {
          message = await this.bot.telegram.sendAnimation(chatId, cached ?? Input.fromLocalFile(gif), { caption, parse_mode: "HTML" });
        } catch (error) {
          if (!cached) throw error;
          this.animationFileIds.delete(phase);
          message = await this.bot.telegram.sendAnimation(chatId, Input.fromLocalFile(gif), { caption, parse_mode: "HTML" });
        }
        this.animationFileIds.set(phase, message.animation.file_id);
        return message;
      }
      if (existsSync(png)) {
        let message: Message.PhotoMessage;
        const cached = this.photoFileIds.get(phase);
        try {
          message = await this.bot.telegram.sendPhoto(chatId, cached ?? Input.fromLocalFile(png), { caption, parse_mode: "HTML" });
        } catch (error) {
          if (!cached) throw error;
          this.photoFileIds.delete(phase);
          message = await this.bot.telegram.sendPhoto(chatId, Input.fromLocalFile(png), { caption, parse_mode: "HTML" });
        }
        const largest = message.photo[message.photo.length - 1];
        if (largest) this.photoFileIds.set(phase, largest.file_id);
        return message;
      }
    } catch (error) {
      this.logger.warn(`Не удалось отправить заставку ${phase}`, error);
    }
    return null;
  }
}
