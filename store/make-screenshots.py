#!/usr/bin/env python3
"""
Composite raw Simulator captures into store-ready screenshots.

INPUT   store/screenshots/raw/01.png … 06.png  (1320x2868 from iPhone 16/17 Pro Max)
OUTPUT  store/screenshots/appstore/  1320x2868  — Apple, one iPhone set
        store/screenshots/play/      1080x1920  — Play, portrait phone

WHY TWO CANVASES
Apple's 6.9" frame is 1320x2868, an aspect ratio of 1:2.17. Play rejects any
image whose longest side is more than twice the shortest, so an Apple asset
cannot simply be resized for Play — 2.17 > 2. The Play canvas is therefore
composed separately at 9:16 with the device inset, not cropped down.

FONT
Headlines are set in Lora, not the app's Cormorant Garamond, because this
runs in a Linux sandbox that has no Cormorant. Same substitution as the Play
feature graphic, so the two are at least consistent with each other. If exact
brand typography matters, install Cormorant Garamond and set FONT_SERIF.
"""

# Defers annotation evaluation so `str | None` and friends parse on Python 3.9,
# which is what Xcode's bundled python3 is. Without this the module fails to
# import on a stock Mac.
from __future__ import annotations

from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "screenshots" / "raw"
RAW_IPAD = ROOT / "screenshots" / "raw-ipad"
OUT_APPLE = ROOT / "screenshots" / "appstore"
OUT_PLAY = ROOT / "screenshots" / "play"
OUT_IPAD = ROOT / "screenshots" / "ipad"
OUT_PLAY_7 = ROOT / "screenshots" / "play-tablet-7"
OUT_PLAY_10 = ROOT / "screenshots" / "play-tablet-10"

# Brand palette — lifted from tailwind.config.js, keep in sync.
PAPER = (250, 246, 239)
INK = (31, 27, 22)
MOSS = (61, 90, 68)
MUTED = (110, 102, 89)

# Tried in order. Cormorant Garamond first so this picks up the real brand
# face automatically if the script is ever run somewhere that has it (e.g.
# Antonio's Mac with the font installed), falling back to Lora in the sandbox.
FONT_CANDIDATES = [
    # The real brand face, if installed. Google Fonts' static download plus
    # Font Book puts it in ~/Library/Fonts.
    "/Library/Fonts/CormorantGaramond-Medium.ttf",
    str(Path.home() / "Library/Fonts/CormorantGaramond-Medium.ttf"),
    str(Path.home() / "Library/Fonts/CormorantGaramond-Regular.ttf"),
    "/usr/share/fonts/truetype/google-fonts/CormorantGaramond-Variable.ttf",
    # Georgia next, deliberately: tailwind.config.js declares the display
    # stack as ["Cormorant Garamond", "Georgia", "serif"], so Georgia is what
    # the app itself falls back to. Matching that keeps the store art and the
    # running app consistent instead of picking a third face at random.
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "/Library/Fonts/Georgia.ttf",
    "/System/Library/Fonts/NewYork.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    # Linux sandbox.
    "/usr/share/fonts/truetype/google-fonts/Lora-Variable.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
]

# Order matters: this is the order they appear in both stores. Shot 1 does the
# most work — most people never swipe past 2.
CAPTIONS = [
    "One passage. One thought.\nOne question to carry.",
    "Some mornings it\npushes back.",
    "Follow several threads\nat once.",
    "Every note you've written,\nin one place.",
    "See what's emerging\nover weeks, not days.",
    "You set the pace —\nand how hard it presses.",
]


def resolve_font() -> str:
    """First installed candidate wins. Resolved once so the run can report it."""
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return path
    raise SystemExit(
        "\nNo serif font found on this machine.\n\n"
        "Install the brand face — it's what the app itself uses:\n"
        "  1. https://fonts.google.com/specimen/Cormorant+Garamond\n"
        "  2. Get font > Download all, unzip, open static/\n"
        "  3. Double-click CormorantGaramond-Medium.ttf > Install Font\n\n"
        "Or add any .ttf path to FONT_CANDIDATES at the top of this file.\n"
    )


_FONT_PATH: Optional[str] = None


def load_font(size: int) -> ImageFont.FreeTypeFont:
    global _FONT_PATH
    if _FONT_PATH is None:
        _FONT_PATH = resolve_font()
    return ImageFont.truetype(_FONT_PATH, size)


def rounded(img: Image.Image, radius: int) -> Image.Image:
    """Round the device corners so the capture doesn't read as a flat rectangle."""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), img.size], radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def drop_shadow(size: tuple[int, int], radius: int, blur: int, spread: int) -> Image.Image:
    """Soft shadow layer sized to the device, drawn separately so it can blur past its edges."""
    w, h = size
    layer = Image.new("RGBA", (w + spread * 2, h + spread * 2), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        [(spread, spread), (spread + w, spread + h)],
        radius=radius,
        fill=(31, 27, 22, 60),
    )
    return layer.filter(ImageFilter.GaussianBlur(blur))


def compose(
    shot: Image.Image,
    caption: str,
    canvas_size: tuple[int, int],
    *,
    device_width_pct: float,
    caption_size: int,
    line_gap: float,
    top_pad: int,
    accent_len: int,
) -> Image.Image:
    cw, ch = canvas_size
    canvas = Image.new("RGB", canvas_size, PAPER)
    draw = ImageDraw.Draw(canvas)

    # --- caption block, top-aligned and centred.
    # Shrink to fit rather than trusting the hand-tuned size: captions get
    # reworded often and a headline touching the canvas edge looks broken.
    lines = caption.split("\n")
    max_text_w = cw * 0.86
    font = load_font(caption_size)
    while caption_size > 24 and lines and max(
        draw.textlength(ln, font=font) for ln in lines
    ) > max_text_w:
        caption_size -= 4
        font = load_font(caption_size)

    line_h = int(caption_size * line_gap)
    y = top_pad
    for line in lines:
        w = draw.textlength(line, font=font)
        draw.text(((cw - w) / 2, y), line, font=font, fill=INK)
        y += line_h

    # --- short accent rule under the caption, in place of a heavier divider
    y += int(caption_size * 0.55)
    draw.line(
        [((cw - accent_len) / 2, y), ((cw + accent_len) / 2, y)],
        fill=MOSS,
        width=max(2, cw // 440),
    )
    y += int(caption_size * 0.9)

    # --- device: scale to width, let it run off the bottom edge
    dev_w = int(cw * device_width_pct)
    dev_h = int(shot.height * (dev_w / shot.width))
    device = rounded(shot.resize((dev_w, dev_h), Image.LANCZOS), radius=int(dev_w * 0.055))

    dx = (cw - dev_w) // 2
    dy = y

    spread = int(dev_w * 0.09)
    shadow = drop_shadow(
        (dev_w, dev_h), int(dev_w * 0.055), blur=int(dev_w * 0.035), spread=spread
    )
    canvas.paste(shadow, (dx - spread, dy - spread + int(dev_w * 0.012)), shadow)
    canvas.paste(device, (dx, dy), device)

    return canvas


def main() -> None:
    if not RAW.exists():
        raise SystemExit(
            f"No raw captures found.\nExpected PNGs in: {RAW}\n"
            "See store/SCREENSHOTS.md for how to capture them."
        )

    shots = sorted(p for p in RAW.glob("*.png"))
    if not shots:
        raise SystemExit(f"{RAW} is empty — nothing to composite.")

    OUT_APPLE.mkdir(parents=True, exist_ok=True)
    OUT_PLAY.mkdir(parents=True, exist_ok=True)

    font_path = resolve_font()
    print(f"\nHeadline font: {font_path}")
    if "Cormorant" not in font_path:
        print(
            "  NOTE: this is not Cormorant Garamond, the face the app uses.\n"
            "  Install it from fonts.google.com/specimen/Cormorant+Garamond\n"
            "  and re-run if you want the headlines to match the app.\n"
        )

    for i, path in enumerate(shots):
        shot = Image.open(path).convert("RGB")
        caption = CAPTIONS[i] if i < len(CAPTIONS) else ""
        stem = f"{i + 1:02d}"

        apple = compose(
            shot,
            caption,
            (1320, 2868),
            device_width_pct=0.82,
            caption_size=104,
            line_gap=1.24,
            top_pad=210,
            accent_len=150,
        )
        apple.save(OUT_APPLE / f"{stem}.png", "PNG", optimize=True)

        play = compose(
            shot,
            caption,
            (1080, 1920),
            device_width_pct=0.60,
            caption_size=76,
            line_gap=1.22,
            top_pad=120,
            accent_len=110,
        )
        play.save(OUT_PLAY / f"{stem}.png", "PNG", optimize=True)

        print(f"  {stem}  {path.name}  ->  appstore/{stem}.png  play/{stem}.png")

    print(f"\n{len(shots)} iPhone screenshots written.")
    print(f"  Apple (1320x2868): {OUT_APPLE}")
    print(f"  Play  (1080x1920): {OUT_PLAY}")

    build_ipad()


def build_ipad() -> None:
    """
    iPad set — only if raw-ipad/ has captures. Skipped silently otherwise so
    the iPhone pass stays usable on its own.

    Required because TARGETED_DEVICE_FAMILY is "1,2" (iPhone + iPad): App
    Store Connect will not accept the submission without an iPad set. The
    canvas is 2064x2752, the 13" iPad Pro (M4) size; Apple scales it down for
    the smaller iPad classes.

    The device is inset much further than on the phone canvas — the capture
    and the canvas share an aspect ratio here, so a phone-like 0.82 width
    would leave no room for a headline.
    """
    if not RAW_IPAD.exists():
        return
    shots = sorted(RAW_IPAD.glob("*.png"))
    if not shots:
        return

    for out in (OUT_IPAD, OUT_PLAY_7, OUT_PLAY_10):
        out.mkdir(parents=True, exist_ok=True)
    print(f"\niPad captures found in {RAW_IPAD.name}/ — building tablet sets.")

    for i, path in enumerate(shots):
        shot = Image.open(path).convert("RGB")
        caption = CAPTIONS[i] if i < len(CAPTIONS) else ""
        stem = f"{i + 1:02d}"

        # Apple, 13" iPad Pro (M4).
        compose(
            shot,
            caption,
            (2064, 2752),
            device_width_pct=0.66,
            caption_size=132,
            line_gap=1.24,
            top_pad=210,
            accent_len=200,
        ).save(OUT_IPAD / f"{stem}.png", "PNG", optimize=True)

        # Play 10" tablet. Taller canvas than the iPad (1:1.6 vs 1:1.33), so
        # the device is set wider to avoid a band of dead space underneath.
        compose(
            shot,
            caption,
            (1600, 2560),
            device_width_pct=0.80,
            caption_size=104,
            line_gap=1.22,
            top_pad=150,
            accent_len=150,
        ).save(OUT_PLAY_10 / f"{stem}.png", "PNG", optimize=True)

        # Play 7" tablet — same proportions, smaller canvas.
        compose(
            shot,
            caption,
            (1200, 1920),
            device_width_pct=0.80,
            caption_size=78,
            line_gap=1.22,
            top_pad=112,
            accent_len=112,
        ).save(OUT_PLAY_7 / f"{stem}.png", "PNG", optimize=True)

        print(
            f"  {stem}  {path.name}  ->  ipad/  play-tablet-10/  play-tablet-7/"
        )

    print(f"\n{len(shots)} of each tablet size written.")
    print(f"  Apple iPad 13\"  (2064x2752): {OUT_IPAD}")
    print(f"  Play 10\" tablet (1600x2560): {OUT_PLAY_10}")
    print(f"  Play 7\" tablet  (1200x1920): {OUT_PLAY_7}")


if __name__ == "__main__":
    main()
