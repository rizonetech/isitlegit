"""Writes the synthetic Meta smoke-test fixtures (D00 T01 §7) and their known geometry to fixtures.json. Nothing here is
real mail or a real brand: the code is random, the logo and the page are invented. Run once; the files are committed."""
import json
import pathlib
import secrets

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
code = "-".join("".join(secrets.choice(alphabet) for _ in range(3)) for _ in range(3))

card = Image.new("RGB", (800, 400), "white")
draw = ImageDraw.Draw(card)
draw.text((60, 120), "Verification code", font=ImageFont.truetype(FONT, 36), fill="#333333")
draw.text((60, 190), code, font=ImageFont.truetype(BOLD, 72), fill="black")
card.save(HERE / "code-card.png")

logo = Image.new("RGB", (800, 500), "white")
draw = ImageDraw.Draw(logo)
box = (250, 150, 550, 350)
draw.rounded_rectangle(box, radius=24, fill="#1F4E8C")
draw.ellipse((280, 200, 380, 300), fill="#F2A900")
draw.text((395, 225), "ZENTROVA", font=ImageFont.truetype(BOLD, 34), fill="white")
draw.text((60, 420), "Invoice 2026-104, due on receipt", font=ImageFont.truetype(FONT, 22), fill="#555555")
logo.save(HERE / "logo-card.png")

page = Image.new("RGB", (1280, 800), "#F5F6F8")
draw = ImageDraw.Draw(page)
draw.text((120, 140), "Welcome back", font=ImageFont.truetype(BOLD, 48), fill="#111111")
draw.text((120, 220), "Review the details below, then continue to your account.", font=ImageFont.truetype(FONT, 24), fill="#444444")
button = (540, 420, 740, 480)
draw.rounded_rectangle(button, radius=10, fill="#0B6E4F")
draw.text((577, 433), "Continue", font=ImageFont.truetype(BOLD, 28), fill="white")
page.save(HERE / "continue-page.png")

# Written as the repository's formatter (Biome) lays out JSON: two-space indent, short arrays on one line.
facts = {"code": code, "logoBox": list(box), "logoSize": [800, 500], "buttonBox": list(button), "pageSize": [1280, 800]}
body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, separators=(', ', ': '))}" for k, v in facts.items())
(HERE / "fixtures.json").write_text("{\n" + body + "\n}\n", encoding="utf-8")
print("fixtures written; code", code)
