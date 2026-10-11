"""
Generates high-resolution branded icons for ChatMCP Desktop Application and Web Studio.
Outputs:
- assets/icons/chatmcp.ico (Multi-resolution: 256, 128, 64, 48, 32, 24, 16)
- assets/icons/chatmcp.png (512x512)
- assets/icons/chatmcp-1024.png (1024x1024)
- CHATMCP-HUB/web/favicon.ico
- CHATMCP-HUB/web/chatmcp-logo.png
"""

import os
import math
from PIL import Image, ImageDraw, ImageFilter

def create_brand_icon(size=1024):
    # Create canvas with RGBA
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(size * 0.08)  # 80px pad
    radius = int(size * 0.22) # 220px corner radius
    w = size - 2 * pad
    h = size - 2 * pad

    # 1. Base Shadow
    shadow_offset = int(size * 0.03)
    shadow_box = [pad, pad + shadow_offset, pad + w, pad + h + shadow_offset]
    shadow_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_img)
    shadow_draw.rounded_rectangle(shadow_box, radius=radius, fill=(0, 0, 0, 140))
    shadow_img = shadow_img.filter(ImageFilter.GaussianBlur(int(size * 0.04)))
    img = Image.alpha_composite(img, shadow_img)

    # 2. Main Background with Gradient Squircle
    bg_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg_img)

    # Draw gradient background mask
    mask_img = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask_img)
    mask_draw.rounded_rectangle([pad, pad, pad + w, pad + h], radius=radius, fill=255)

    # Create gradient fill from top-left (#111827) to bottom-right (#090D1A)
    grad_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad_draw = ImageDraw.Draw(grad_img)
    for y in range(size):
        ratio = y / size
        # Smooth deep blue / dark slate gradient
        r = int(14 + ratio * (7 - 14))
        g = int(22 + ratio * (11 - 22))
        b = int(38 + ratio * (22 - 38))
        grad_draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    bg_img = Image.composite(grad_img, bg_img, mask_img)
    img = Image.alpha_composite(img, bg_img)

    # 3. Outer Glowing Rim / Border
    border_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border_img)
    border_draw.rounded_rectangle(
        [pad, pad, pad + w, pad + h],
        radius=radius,
        outline=(0, 242, 254, 180),
        width=int(size * 0.012)
    )
    # Subtle inner bevel
    border_draw.rounded_rectangle(
        [pad + 4, pad + 4, pad + w - 4, pad + h - 4],
        radius=radius - 4,
        outline=(138, 43, 226, 80),
        width=int(size * 0.008)
    )
    img = Image.alpha_composite(img, border_img)

    # 4. Central Emblem: Futuristic Hexagonal Cyber Shield + Code Brackets + Core Spark
    center_x = size / 2.0
    center_y = size / 2.0

    # Draw Hexagonal Shield Ambient Glow
    glow_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    hex_radius = size * 0.28
    hex_points = []
    for i in range(6):
        angle = math.radians(60 * i - 30)
        px = center_x + hex_radius * math.cos(angle)
        py = center_y + hex_radius * math.sin(angle)
        hex_points.append((px, py))

    glow_draw.polygon(hex_points, fill=(0, 220, 255, 35))
    glow_img = glow_img.filter(ImageFilter.GaussianBlur(int(size * 0.06)))
    img = Image.alpha_composite(img, glow_img)

    # Draw Hexagonal Shield Outline
    shield_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shield_draw = ImageDraw.Draw(shield_img)
    shield_draw.polygon(hex_points, outline=(0, 242, 254, 230), width=int(size * 0.016))
    
    # Inner hexagon
    inner_points = []
    for i in range(6):
        angle = math.radians(60 * i - 30)
        px = center_x + (hex_radius * 0.88) * math.cos(angle)
        py = center_y + (hex_radius * 0.88) * math.sin(angle)
        inner_points.append((px, py))
    shield_draw.polygon(inner_points, outline=(139, 92, 246, 160), width=int(size * 0.008))
    img = Image.alpha_composite(img, shield_img)

    # 5. Stylized Code Brackets '<' and '>' with Gradient Glow
    code_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    code_draw = ImageDraw.Draw(code_img)

    bracket_w = size * 0.09
    bracket_h = size * 0.16
    thick = int(size * 0.024)

    # Left bracket '<'
    left_x = center_x - size * 0.12
    l_pt1 = (left_x + bracket_w * 0.5, center_y - bracket_h)
    l_pt2 = (left_x - bracket_w * 0.6, center_y)
    l_pt3 = (left_x + bracket_w * 0.5, center_y + bracket_h)
    code_draw.line([l_pt1, l_pt2, l_pt3], fill=(0, 245, 255, 255), width=thick, joint="curve")

    # Right bracket '>'
    right_x = center_x + size * 0.12
    r_pt1 = (right_x - bracket_w * 0.5, center_y - bracket_h)
    r_pt2 = (right_x + bracket_w * 0.6, center_y)
    r_pt3 = (right_x - bracket_w * 0.5, center_y + bracket_h)
    code_draw.line([r_pt1, r_pt2, r_pt3], fill=(167, 139, 250, 255), width=thick, joint="curve")

    # 6. Central AI Core: Brilliant Quantum Diamond / Spark
    spark_w = size * 0.045
    spark_h = size * 0.08
    core_pts = [
        (center_x, center_y - spark_h),
        (center_x + spark_w, center_y),
        (center_x, center_y + spark_h),
        (center_x - spark_w, center_y),
    ]
    code_draw.polygon(core_pts, fill=(16, 185, 129, 255)) # Emerald core

    inner_core_pts = [
        (center_x, center_y - spark_h * 0.55),
        (center_x + spark_w * 0.55, center_y),
        (center_x, center_y + spark_h * 0.55),
        (center_x - spark_w * 0.55, center_y),
    ]
    code_draw.polygon(inner_core_pts, fill=(255, 255, 255, 255)) # Pure white shine

    # Horizontal spark flare
    code_draw.line(
        [(center_x - spark_w * 1.8, center_y), (center_x + spark_w * 1.8, center_y)],
        fill=(52, 211, 153, 200),
        width=int(size * 0.008)
    )

    img = Image.alpha_composite(img, code_img)
    return img

def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    icons_dir = os.path.join(repo_root, "assets", "icons")
    web_dir = os.path.join(repo_root, "CHATMCP-HUB", "web")
    os.makedirs(icons_dir, exist_ok=True)
    os.makedirs(web_dir, exist_ok=True)

    print("Rendering master 1024x1024 ChatMCP brand icon...")
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
