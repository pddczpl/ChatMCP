"""
Generates the DatGold brand icon: a gold "D" on a dark rounded square. The D is drawn from rectangles and circles (no font, no third-party artwork),
so the icon is original work under the repository licence.

Outputs (the file names keep the old product name on purpose: the desktop shell, the installer and the web UI refer to them by these names):
- assets/icons/chatmcp.ico (Multi-resolution: 256, 128, 64, 48, 32, 24, 16)
- assets/icons/chatmcp.png (512x512)
- assets/icons/chatmcp-1024.png (1024x1024)
- DATGOLD-HUB/web/favicon.ico
- DATGOLD-HUB/web/chatmcp-logo.png
"""

import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

# The palette. The background is the same dark slate the installer and the app use; the gold runs from a pale highlight to a deep amber.
SLATE_TOP = (17, 24, 39)
SLATE_BOTTOM = (9, 13, 26)
GOLD_LIGHT = (255, 226, 138)
GOLD = (242, 180, 22)
GOLD_DEEP = (176, 112, 4)
GOLD_EDGE = (255, 244, 200)


def rounded_square_mask(size, pad, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=255)
    return mask


def d_mask(size, left, top, width, height, stem, bowl):
    """
    The letter D as a mask: an outer shape (a rectangle whose right end is a half circle) minus a counter of the same kind, inset by `stem` on the left
    and by `bowl` on the other three sides, so the left stroke is `stem` thick and the strokes at the top, the bottom and the right are `bowl` thick.
    """
    def d_shape(l, t, w, h):
        radius = h / 2.0
        shape = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(shape)
        draw.rectangle([l, t, l + w - radius, t + h], fill=255)
        # only the right half of the circle: its left half would stick out of the rectangle when the shape is narrower than it is tall
        draw.pieslice([l + w - 2 * radius, t, l + w, t + h], start=-90, end=90, fill=255)
        return shape

    outer = d_shape(left, top, width, height)
    inner = d_shape(left + stem, top + bowl, width - stem - bowl, height - 2 * bowl)
    return ImageChops.subtract(outer, inner)


def vertical_gradient(size, top, bottom, colors):
    """An RGBA image the size of the canvas whose colour goes from colors[0] at row `top` through colors[1] to colors[2] at row `bottom`."""
    ramp = Image.linear_gradient("L").resize((size, max(1, int(bottom - top))), Image.Resampling.BILINEAR)
    painted = ImageOps.colorize(ramp, black=colors[0], white=colors[2], mid=colors[1]).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), colors[0] + (255,))
    canvas.paste(painted, (0, int(top)))
    canvas.paste(Image.new("RGBA", (size, size - int(bottom)), colors[2] + (255,)), (0, int(bottom)))
    return canvas


def create_brand_icon(size=1024):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    pad = int(size * 0.08)
    radius = int(size * 0.22)
    body = rounded_square_mask(size, pad, radius)

    # 1. A soft shadow under the rounded square
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + int(size * 0.03), size - pad, size - pad + int(size * 0.03)], radius=radius, fill=(0, 0, 0, 140))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(int(size * 0.04))))

    # 2. The dark body, a vertical gradient
    slate = vertical_gradient(size, pad, size - pad, (SLATE_TOP, tuple((a + b) // 2 for a, b in zip(SLATE_TOP, SLATE_BOTTOM)), SLATE_BOTTOM))
    img = Image.alpha_composite(img, Image.composite(slate, Image.new("RGBA", (size, size), (0, 0, 0, 0)), body))

    # 3. A thin gold rim, with a fainter one inside it
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rim_draw = ImageDraw.Draw(rim)
    rim_draw.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, outline=GOLD + (150,), width=max(1, int(size * 0.012)))
    rim_draw.rounded_rectangle([pad + 6, pad + 6, size - pad - 6, size - pad - 6], radius=radius - 6, outline=GOLD_DEEP + (70,), width=max(1, int(size * 0.006)))
    img = Image.alpha_composite(img, rim)

    # 4. The D: 500 tall, 440 wide, strokes 128 thick, centred a little to the right because the flat left side carries less weight to the eye
    height = size * 0.50
    width = size * 0.43
    left = (size - width) / 2.0 + size * 0.012
    top = (size - height) / 2.0
    stem = size * 0.125
    bowl = size * 0.125
    letter = d_mask(size, left, top, width, height, stem, bowl)

    # a warm glow behind the letter
    glow = Image.new("RGBA", (size, size), GOLD + (0,))
    glow.putalpha(letter.filter(ImageFilter.GaussianBlur(int(size * 0.035))).point(lambda value: int(value * 0.32)))
    img = Image.alpha_composite(img, glow)

    # the letter itself, in a gold that runs from light at the top to deep amber at the bottom
    gold = vertical_gradient(size, top, top + height, (GOLD_LIGHT, GOLD, GOLD_DEEP))
    img = Image.alpha_composite(img, Image.composite(gold, Image.new("RGBA", (size, size), (0, 0, 0, 0)), letter))

    # a pale edge on the upper and left sides of every stroke, so the letter reads as a raised piece of metal
    shift = max(2, int(size * 0.009))
    edge = ImageChops.subtract(letter, ImageChops.offset(letter, shift, shift))
    edge_layer = Image.new("RGBA", (size, size), GOLD_EDGE + (0,))
    edge_layer.putalpha(edge.point(lambda value: int(value * 0.6)))
    img = Image.alpha_composite(img, edge_layer)
    return img


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    icons_dir = os.path.join(repo_root, "assets", "icons")
    web_dir = os.path.join(repo_root, "DATGOLD-HUB", "web")
    os.makedirs(icons_dir, exist_ok=True)
    os.makedirs(web_dir, exist_ok=True)

    print("Rendering master 1024x1024 DatGold brand icon...")
    master_1024 = create_brand_icon(1024)

    # Save master 1024 PNG
    p1024 = os.path.join(icons_dir, "chatmcp-1024.png")
    master_1024.save(p1024, "PNG")
    print(f"  [OK] Saved: {p1024}")

    # Save 512 PNG
    master_512 = master_1024.resize((512, 512), Image.Resampling.LANCZOS)
    p512 = os.path.join(icons_dir, "chatmcp.png")
    master_512.save(p512, "PNG")
    print(f"  [OK] Saved: {p512}")

    # Copy to web dir
    web_logo = os.path.join(web_dir, "chatmcp-logo.png")
    master_512.save(web_logo, "PNG")
    print(f"  [OK] Saved: {web_logo}")

    # Generate multi-resolution .ico (16, 24, 32, 48, 64, 128, 256)
    ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
    ico_images = [master_1024.resize(sz, Image.Resampling.LANCZOS) for sz in ico_sizes]

    ico_path = os.path.join(icons_dir, "chatmcp.ico")
    ico_images[0].save(ico_path, format="ICO", sizes=ico_sizes)
    print(f"  [OK] Saved multi-layer ICO: {ico_path}")

    # Save web favicon.ico
    fav_path = os.path.join(web_dir, "favicon.ico")
    ico_images[0].save(fav_path, format="ICO", sizes=[(32, 32), (16, 16)])
    print(f"  [OK] Saved Web Favicon: {fav_path}")

    print("\nBrand icon generation completed successfully!")


if __name__ == "__main__":
    main()
