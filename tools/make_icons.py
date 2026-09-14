"""Generate the PWA icons from tools/logo.png, composited onto black.

Needs Pillow (a dev-only dependency; the app itself stays dependency-free).
Run it if you change the logo:  python tools/make_icons.py
"""

from pathlib import Path

from PIL import Image

TOOLS = Path(__file__).resolve().parent
LOGO = TOOLS / "logo.png"
ICON_DIR = TOOLS.parent / "docs" / "icons"

BG = (0, 0, 0, 255)


def make_icon(logo: Image.Image, size: int, padding: float) -> Image.Image:
    """Centre the logo on a black square, leaving `padding` (a fraction of size) per side."""
    box = round(size * (1 - 2 * padding))
    art = logo.copy()
    art.thumbnail((box, box), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BG)
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas.convert("RGB")


if __name__ == "__main__":
    logo = Image.open(LOGO).convert("RGBA")
    logo = logo.crop(logo.getchannel("A").getbbox())   # drop empty transparent margins
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "icon-192.png": (192, 0.06),
        "icon-512.png": (512, 0.06),
        # Maskable icons get cropped to a circle or squircle; keep the art in the 80% safe zone.
        "icon-maskable-512.png": (512, 0.16),
    }
    for name, (size, padding) in outputs.items():
        path = ICON_DIR / name
        make_icon(logo, size, padding).save(path, optimize=True)
        print(f"wrote {path} ({path.stat().st_size} bytes)")
