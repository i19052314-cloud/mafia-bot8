#!/usr/bin/env python3
"""Create lightweight looping Telegram GIF banners from the original Mafia Noir art."""
from __future__ import annotations

import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SIZE = (640, 360)
FRAMES = 28
DURATION_MS = 110


def cover(image: Image.Image, width: int, height: int, zoom: float, shift_x: float, shift_y: float) -> Image.Image:
    scale = max(width / image.width, height / image.height) * zoom
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = round((resized.width - width) / 2 + shift_x)
    top = round((resized.height - height) / 2 + shift_y)
    left = max(0, min(left, resized.width - width))
    top = max(0, min(top, resized.height - height))
    return resized.crop((left, top, left + width, top + height))


def make_frames(source: Path, mode: str) -> list[Image.Image]:
    original = Image.open(source).convert("RGB")
    result: list[Image.Image] = []
    random.seed(1930 if mode == "night" else 1931)
    particles = [(random.randrange(SIZE[0]), random.randrange(SIZE[1]), random.randrange(8, 22)) for _ in range(45)]

    for index in range(FRAMES):
        progress = index / FRAMES
        wave = math.sin(progress * math.tau)
        zoom = 1.035 + 0.012 * (1 - math.cos(progress * math.tau)) / 2
        frame = cover(original, *SIZE, zoom, 5 * wave, 2 * math.cos(progress * math.tau))
        frame = ImageEnhance.Brightness(frame).enhance((0.97 if mode == "night" else 1.0) + 0.025 * wave)

        overlay = Image.new("RGBA", SIZE, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        if mode == "night":
            # Rain crosses the frame and loops seamlessly.
            for x, y, speed in particles:
                yy = (y + index * speed) % (SIZE[1] + 30) - 15
                xx = (x + index * 2) % (SIZE[0] + 20) - 10
                draw.line((xx, yy, xx - 5, yy + 13), fill=(205, 218, 225, 48), width=1)
            # A restrained burgundy pulse preserves the noir palette.
            draw.rectangle((0, 0, *SIZE), fill=(70, 0, 12, round(7 + 3 * (wave + 1))))
        else:
            # Slowly drifting dawn haze and dust.
            for x, y, speed in particles[:28]:
                xx = (x + index * max(1, speed // 8)) % SIZE[0]
                yy = (y - index * max(1, speed // 10)) % SIZE[1]
                radius = 1 if speed < 15 else 2
                draw.ellipse((xx - radius, yy - radius, xx + radius, yy + radius), fill=(255, 224, 160, 28))
            haze = Image.new("RGBA", SIZE, (221, 172, 92, round(7 + 4 * (wave + 1))))
            overlay = Image.alpha_composite(overlay, haze)

        composed = Image.alpha_composite(frame.convert("RGBA"), overlay).convert("RGB")
        if mode == "day":
            composed = composed.filter(ImageFilter.GaussianBlur(radius=0.12))
        # A shared adaptive palette keeps the animation small enough for Telegram.
        result.append(composed.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG))
    return result


def save(mode: str) -> None:
    source = ASSETS / f"{mode}-noir.png"
    target = ASSETS / f"{mode}-noir.gif"
    frames = make_frames(source, mode)
    frames[0].save(
        target,
        save_all=True,
        append_images=frames[1:],
        duration=DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"{target.name}: {target.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    save("night")
    save("day")
