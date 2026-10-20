#!/usr/bin/env python3
"""
Book threads launch carousel: 4 typographic 1080x1350 Instagram slides.
Reuses the brand palette and font lookup from make-screenshots.py.
Slide 3 quotes Mark §1 exactly as it is stored in prod book_section_content.

    python3 store/make-instagram-books.py  ->  store/screenshots/instagram-books/
"""
import importlib.util
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("shots", HERE / "make-screenshots.py")
shots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shots)
PAPER, INK, MOSS, MUTED, load_font = shots.PAPER, shots.INK, shots.MOSS, shots.MUTED, shots.load_font

OUT = HERE / "screenshots" / "instagram-books"
W, H = 1080, 1350
MARGIN = 100

# (kind, lines) per slide. Each line: (text, size, colour, gap_after).
SLIDES = [
    [
        ("NEW IN PONDER", 30, MOSS, 40),
        ("Read a whole book", 84, INK, 0),
        ("of the Bible.", 84, INK, 60),
        ("One passage a day.", 52, MUTED, 0),
    ],
    [
        ("BOOK THREADS", 30, MOSS, 40),
        ("Pick a book.", 84, INK, 50),
        ("Genesis to Revelation.", 46, MUTED, 0),
        ("All 66 are ready.", 46, MUTED, 70),
        ("Ponder walks you through it,", 46, INK, 0),
        ("passage by passage, in order.", 46, INK, 0),
    ],
    [
        ("MARK · PASSAGE 1 OF 87", 30, MOSS, 44),
        ("“Mark wastes no words. His first", 46, INK, 0),
        ("line reads almost like a title: this", 46, INK, 0),
        ("is where the good news of Jesus", 46, INK, 0),
        ("Christ, the Son of God, begins.”", 46, INK, 70),
        ("TO PONDER", 30, MOSS, 30),
        ("What might it look like for the way", 40, MUTED, 0),
        ("to be made ready for the Lord", 40, MUTED, 0),
        ("in your own life?", 40, MUTED, 0),
    ],
    [
        ("NO STREAKS. NO CATCHING UP.", 30, MOSS, 40),
        ("It waits for you.", 84, INK, 50),
        ("The next passage comes once", 46, MUTED, 0),
        ("you've read the last one.", 46, MUTED, 90),
        ("Ponder: Daily Discernment", 46, INK, 0),
        ("App Store · Google Play", 36, MUTED, 0),
    ],
]


def render(lines) -> Image.Image:
    img = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(img)
    fonts = [load_font(size) for _, size, _, _ in lines]
    heights = [int(f.size * 1.32) + gap for f, (_, _, _, gap) in zip(fonts, lines)]
    y = (H - sum(heights)) / 2
    for (text, _, colour, _), font, h in zip(lines, fonts, heights):
        assert draw.textlength(text, font=font) <= W - 2 * MARGIN, f"too wide: {text}"
        draw.text((MARGIN, y), text, font=font, fill=colour)
        y += h
    # Moss rule bottom-left, same accent the other posts use.
    draw.line([(MARGIN, H - 120), (MARGIN + 100, H - 120)], fill=MOSS, width=3)
    return img


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for i, lines in enumerate(SLIDES, 1):
        render(lines).save(OUT / f"book{i}.png", "PNG", optimize=True)
        print(f"  instagram-books/book{i}.png")
