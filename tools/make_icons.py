"""Generate the PWA icons.

Pure stdlib so there is no image dependency to install for two flat-colour
pictures. Run it if you change the colours:  python tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).resolve().parent.parent / "docs" / "icons"

BG = (18, 21, 28)
FG = (76, 141, 255)


def rounded_square(x: int, y: int, size: int, radius: int) -> bool:
    """True if (x, y) is inside a rounded square anchored at the origin."""
    cx = min(max(x, radius), size - radius - 1)
    cy = min(max(y, radius), size - radius - 1)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def dumbbell(x: int, y: int, size: int) -> bool:
    """A bar with a plate at each end, centred in a size x size canvas."""
    u = size / 32.0                      # one grid unit
    mid = size / 2.0
    bar = abs(y - mid) <= 1.2 * u and 7 * u <= x <= size - 7 * u
    plate = (
        abs(y - mid) <= 8 * u
        and (5 * u <= x <= 8 * u or size - 8 * u <= x <= size - 5 * u)
    )
    collar = (
        abs(y - mid) <= 4.5 * u
        and (9 * u <= x <= 11 * u or size - 11 * u <= x <= size - 9 * u)
    )
    return bar or plate or collar


def write_png(path: Path, size: int) -> None:
    radius = size // 5
    raw = bytearray()
    for y in range(size):
        raw.append(0)                    # PNG filter type 0 for each scanline
        for x in range(size):
            inside = rounded_square(x, y, size, radius)
            colour = FG if (inside and dumbbell(x, y, size)) else (BG if inside else BG)
            raw.extend(colour)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">2I5B", size, size, 8, 2, 0, 0, 0)   # 8-bit truecolour
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    for px in (192, 512):
        write_png(ICON_DIR / f"icon-{px}.png", px)
