#!/usr/bin/env python3
"""Generate README visuals for dsh-invoice-ledger (docs/assets/).

Outputs (idempotent overwrite):
  dsh-invoice-ledger-hero-{zh,en}-{light,dark}.webp   1440x576 raster hero (Pillow)
  dsh-invoice-ledger-flow-v5-{light,dark}.svg         1100x660 hand-written SVG

Design notes
------------
* Hero: the left column is prose (kicker / title / two value lines / one
  subtitle / one meta / footer); the right column is this repo's own semantic
  object — the five-row quickstart ledger as a marked-up sheet. Rows 1-2 share
  one invoice key, row 3 carries a total that does not add up, row 5 is dated
  after the pinned check day. Every number comes from
  samples/quickstart/{input/invoices.csv,expected/result.json}: 5 rows,
  3 errors, 12 executed rules, 14 unexecuted rules, 3 workbook sheets.
* Flow: a merge -> gate -> split -> merge structure, not a row of boxes:
  the ledger and the rule pack converge into `invoice_ledger`, the gate
  dispatches by `params.check.kind`, then splits into an EXECUTED channel
  (3 row-level findings) and a NOT EXECUTED channel (14 rule ids, listed by
  id + kind), and both channels re-converge on the markdown report order and
  the three-sheet workbook. Text is command-surface tokens only, so all five
  README languages share one light/dark pair.

Run once:  python scripts/gen-readme-assets.py
Requires:  Python 3.10+ with Pillow; Windows fonts msyh.ttc / msyhbd.ttc /
           consola.ttf / segoeui.ttf / segoeuib.ttf.
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "assets")

FONT_CJK = r"C:\Windows\Fonts\msyh.ttc"
FONT_CJK_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_MONO = r"C:\Windows\Fonts\consola.ttf"
FONT_EN = r"C:\Windows\Fonts\segoeui.ttf"
FONT_EN_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"

for _path in (FONT_CJK, FONT_CJK_BOLD, FONT_MONO, FONT_EN, FONT_EN_BOLD):
    if not os.path.exists(_path):
        raise SystemExit(f"FATAL: font missing: {_path}")

WARNINGS: list[str] = []

# ---------------------------------------------------------------- palette
SKIN = {
    "light": dict(
        bg_from="#f9f6fd", bg_to="#e4eaf8", card="#ffffff",
        card_edge="#e4e1ee", zone="#f5f2fb", zone_edge="#e3def1",
        text="#141419", sub="#4d5261", faint="#8f94a4",
        accent="#4B67B4", accent_soft="#ece8f9", pill="#ece7f9",
        danger="#b42318", danger_soft="#fbeceb",
        amber="#b45309", amber_soft="#fdf1e3",
        track="#eae6f3", grid="#e7e4f0", shadow=(32, 26, 64),
    ),
    "dark": dict(
        bg_from="#131a2a", bg_to="#0c1016", card="#1b2231",
        card_edge="#2e374b", zone="#171e2d", zone_edge="#2b3448",
        text="#f0f3f9", sub="#a8b1c4", faint="#737b8d",
        accent="#8496f5", accent_soft="#252d44", pill="#242d42",
        danger="#f08b83", danger_soft="#3a2528",
        amber="#d9a03c", amber_soft="#33291a",
        track="#243049", grid="#1e2636", shadow=(0, 0, 0),
    ),
}


def font(size: float, kind: str = "cjk") -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(
        {"cjk": FONT_CJK, "cjk_bold": FONT_CJK_BOLD, "mono": FONT_MONO,
         "en": FONT_EN, "en_bold": FONT_EN_BOLD}[kind], max(9, int(round(size)))
    )


def hx(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    return (*hx(value), alpha)


def gradient(w: int, h: int, c1: str, c2: str) -> Image.Image:
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    a, b = hx(c1), hx(c2)
    for y in range(h):
        t = 0.28 * (y / h) + 0.72 * (y / h) ** 1.55
        draw.line([(0, y), (w, y)],
                  fill=tuple(int(p + (q - p) * t) for p, q in zip(a, b)))
    return img


def glow(img: Image.Image, cx: int, cy: int, r: int, color: str,
         alpha: int = 40) -> Image.Image:
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for i in range(12, 0, -1):
        rr = r * i / 12
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr],
                     fill=rgba(color, int(alpha * (1 - i / 13))))
    return Image.alpha_composite(img, layer.filter(ImageFilter.GaussianBlur(18)))


def card(img: Image.Image, box: tuple[int, int, int, int], s: dict,
         radius: int = 22, blur: int = 30) -> None:
    x0, y0, x1, y1 = box
    shadow_rgb = s["shadow"] if isinstance(s["shadow"], tuple) else hx(s["shadow"])
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for i in range(blur, 0, -2):
        sd.rounded_rectangle([x0, y0 + i * 0.55, x1, y1 + i * 0.55],
                             radius=radius + i // 4,
                             fill=(*shadow_rgb, int(7 * (1 - i / blur))))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(11)))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(box, radius=radius, fill=rgba(s["card"]),
                           outline=rgba(s["card_edge"]), width=2)


def pill(img: Image.Image, xy: tuple[int, int], text: str, s: dict,
         size: float = 17, kind: str = "cjk_bold", fg: str = "accent",
         bg: str = "pill", pad_x: int = 16, pad_y: int = 9) -> tuple[int, int]:
    draw = ImageDraw.Draw(img)
    f = font(size, kind)
    width = draw.textlength(text, font=f)
    x, y = xy
    h = int(round(size)) + pad_y * 2
    draw.rounded_rectangle([x, y, x + width + pad_x * 2, y + h],
                           radius=h // 2, fill=rgba(s[bg]))
    draw.text((x + pad_x, y + pad_y - 1), text, font=f, fill=rgba(s[fg]))
    return (x + width + pad_x * 2, y + h)


def write(img: Image.Image, xy: tuple[int, int], text: str, s: dict,
          size: float, kind: str = "cjk", color: str = "text",
          max_w: int | None = None, min_size: float = 12,
          tag: str = "") -> float:
    draw = ImageDraw.Draw(img)
    size = float(size)
    if max_w is not None:
        while size > min_size and draw.textlength(text, font=font(size, kind)) > max_w:
            size -= 1
        if draw.textlength(text, font=font(size, kind)) > max_w:
            WARNINGS.append(f"{tag}: {text!r} wider than {max_w}px at {size:.0f}px")
    draw.text(xy, text, font=font(size, kind), fill=rgba(s[color]))
    return size


# ---------------------------------------------------------------- hero copy
HERO = {
    "zh": dict(
        kicker="DeepSeek Harness · 发票台账核查插件",
        title="dsh-invoice-ledger",
        value=["逐行核完再入账，差异指到行",
               "未执行的规则单列，未执行 ≠ 通过"],
        sub="读 .xlsx / .xlsm / .csv → 26 条规则 → 差异清单 + 三页工作簿",
        meta="只读原件 · 唯一写入异常工作簿 · 不联网 · 不调模型",
        foot="Apache-2.0 · PerryLink DSH plugin family",
        file="invoices.csv",
        file_note="5 行 × 8 列 · 基准日 2026-10-15",
        tag="只读原件",
        head=["发票号码", "合计", "开票日期", "判定"],
        chips={1: "", 2: "重复 ×2", 3: "价税不符", 4: "", 5: "未来日期"},
        stat1=("3", "条差异 · 全部指到行"),
        stat2=("12 / 14", "执行 / 未执行规则"),
        note="判重键 = 发票代码 + 号码，不看金额",
        stamp="未执行 ≠ 通过",
    ),
    "en": dict(
        kicker="DeepSeek Harness · invoice ledger checker",
        title="dsh-invoice-ledger",
        value=["Every row checked before booking",
               "Rules not executed — listed, never a pass"],
        sub="Reads .xlsx / .xlsm / .csv → 26 rules → findings + workbook",
        meta="Read-only ledger · one workbook written · no network, no model call",
        foot="Apache-2.0 · PerryLink DSH plugin family",
        file="invoices.csv",
        file_note="5 rows × 8 cols · check day 2026-10-15",
        tag="source read-only",
        head=["invoice no.", "total", "date", "verdict"],
        chips={1: "", 2: "duplicate ×2", 3: "total mismatch", 4: "", 5: "future date"},
        stat1=("3", "findings, each on a row"),
        stat2=("12 / 14", "executed / not executed"),
        note="key = invoice code + number, amount ignored",
        stamp="not executed ≠ passed",
    ),
}

# rows of samples/quickstart/input/invoices.csv (shortened numbers, same data)
LEDGER_ROWS = [
    ("…0001", "113.00", "10-08", None),
    ("…0001", "113.00", "10-08", "dup"),
    ("…0002", "300.00", "10-09", "money"),
    ("…0003", "56.50", "10-10", None),
    ("…0004", "90.40", "10-20", "date"),
]


def stamp(img: Image.Image, center: tuple[int, int], text: str, s: dict,
          size: float = 18, angle: float = -7.0) -> None:
    layer = Image.new("RGBA", (520, 150), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    f = font(size, "cjk_bold")
    width = draw.textlength(text, font=f)
    w, hh = width + 44, size + 34
    x, y = (520 - w) / 2, (150 - hh) / 2
    draw.rounded_rectangle([x, y, x + w, y + hh], radius=12,
                           outline=rgba(s["danger"], 225), width=3)
    draw.text((x + 22, y + 15), text, font=f, fill=rgba(s["danger"], 235))
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=False)
    img.alpha_composite(layer, (int(center[0] - 260), int(center[1] - 75)))


def hero(lang: str, skin_name: str) -> None:
    s = SKIN[skin_name]
    model = HERO[lang]
    is_zh = lang == "zh"
    w, h = 1440, 576
    img = gradient(w, h, s["bg_from"], s["bg_to"]).convert("RGBA")
    img = glow(img, 1210, 30, 430, s["accent"], 24 if skin_name == "light" else 46)
    img = glow(img, 90, 570, 300, s["accent"], 10 if skin_name == "light" else 18)

    # -------------------------------------------------------- left column
    m = 56
    pill(img, (m, 52), model["kicker"], s, size=20 if is_zh else 19,
         kind="cjk_bold" if is_zh else "en_bold")

    draw = ImageDraw.Draw(img)
    title_size = 80
    if draw.textlength(model["title"], font=font(title_size, "mono")) > 806:
        WARNINGS.append("hero title wider than the left column")
    draw.text((m, 186), model["title"], font=font(title_size, "mono"),
              fill=rgba(s["text"]))

    vkind = "cjk_bold" if is_zh else "en_bold"
    vsize = 38 if is_zh else 32
    for i, line in enumerate(model["value"]):
        write(img, (m, 272 + i * 52), line, s, vsize, vkind, "text", 806, 24,
              f"hero.{lang}.value{i}")

    write(img, (m, 386), model["sub"], s, 25, "cjk" if is_zh else "en",
          "sub", 806, 24, f"hero.{lang}.sub")
    write(img, (m, 436), model["meta"], s, 20, "cjk" if is_zh else "en",
          "faint", 806, 18, f"hero.{lang}.meta")

    draw = ImageDraw.Draw(img)
    draw.line([m, 478, 848, 478], fill=rgba(s["grid"]), width=2)
    write(img, (m, 504), model["foot"], s, 17, "en", "faint", 500, 14,
          f"hero.{lang}.foot")

    # --------------------------------------------------- right: ledger sheet
    box = (880, 44, 1398, 544)
    card(img, box, s, radius=22)
    draw = ImageDraw.Draw(img)

    write(img, (906, 84), model["file"], s, 21, "mono", "text", 320, 18,
          f"hero.{lang}.file")
    draw.text((1372, 84), model["tag"], font=font(14, "cjk" if is_zh else "mono"),
              fill=rgba(s["faint"]), anchor="ra")
    write(img, (906, 112), model["file_note"], s, 15,
          "cjk" if is_zh else "en", "sub", 420, 14, f"hero.{lang}.file_note")
    draw.line([906, 132, 1372, 132], fill=rgba(s["grid"]), width=2)

    # column heads
    heads = model["head"]
    hkind = "cjk_bold" if is_zh else "en_bold"
    draw.text((906, 160), heads[0], font=font(16, hkind), fill=rgba(s["sub"]))
    draw.text((1085, 160), heads[1], font=font(16, hkind), fill=rgba(s["sub"]), anchor="ra")
    draw.text((1195, 160), heads[2], font=font(16, hkind), fill=rgba(s["sub"]), anchor="ra")
    draw.text((1228, 160), heads[3], font=font(16, hkind), fill=rgba(s["sub"]))

    chip_kind = "cjk_bold" if is_zh else "en_bold"
    for i, (number, total, date, state) in enumerate(LEDGER_ROWS):
        base = 198 + i * 42
        draw.text((906, base), number, font=font(19, "mono"), fill=rgba(s["text"]))
        draw.text((1085, base), total, font=font(19, "mono"), fill=rgba(s["text"]), anchor="ra")
        date_color = s["danger"] if state == "date" else s["sub"]
        draw.text((1195, base), date, font=font(17, "mono"), fill=rgba(date_color), anchor="ra")
        label = model["chips"][i + 1]
        if label != "":
            f = font(16, chip_kind)
            tw = draw.textlength(label, font=f)
            draw.rounded_rectangle([1228, base - 20, 1228 + tw + 20, base + 8],
                                   radius=14, fill=rgba(s["danger_soft"]))
            draw.text((1238, base - 14), label, font=f, fill=rgba(s["danger"]))
        else:
            draw.text((1228, base), "—", font=font(16, "mono"), fill=rgba(s["faint"]))
        if i < 4:
            draw.line([906, base + 13, 1372, base + 13],
                      fill=rgba(s["grid"]), width=1)

    # flagged-row gutter: the duplicate pair shares one bar, singles get a tick
    draw.rounded_rectangle([894, 184, 898, 252], radius=2, fill=rgba(s["danger"], 190))
    draw.rounded_rectangle([894, 268, 898, 290], radius=2, fill=rgba(s["danger"], 190))
    draw.rounded_rectangle([894, 352, 898, 374], radius=2, fill=rgba(s["danger"], 190))

    # ------------------------------------------------------- result strip
    draw.line([906, 400, 1372, 400], fill=rgba(s["grid"]), width=2)

    big1, label1 = model["stat1"]
    big2, label2 = model["stat2"]
    draw.text((906, 430), big1, font=font(36, "mono"), fill=rgba(s["text"]))
    write(img, (952, 429), label1, s, 15, "cjk" if is_zh else "en",
          "sub", 220, 12, f"hero.{lang}.stat1")
    draw.text((906, 470), big2, font=font(26, "mono"), fill=rgba(s["text"]))
    write(img, (1024, 469), label2, s, 15, "cjk" if is_zh else "en",
          "sub", 220, 12, f"hero.{lang}.stat2")

    stamp(img, (1272, 452) if is_zh else (1262, 452), model["stamp"], s,
          size=18 if is_zh else 14)

    draw = ImageDraw.Draw(img)
    write(img, (906, 512), model["note"], s, 13,
          "cjk" if is_zh else "en", "faint", 430, 12, f"hero.{lang}.note")

    path = os.path.join(OUT, f"dsh-invoice-ledger-hero-{lang}-{skin_name}.webp")
    img.convert("RGB").save(path, "WEBP", quality=92, method=6)
    print(f"wrote {os.path.basename(path)}")


# ---------------------------------------------------------------- flow svg
FLOW = {
    "light": dict(
        bg_from="#f9f6fd", bg_to="#e4eaf8", card="#ffffff",
        edge="#e4e1ee", zone="#f5f2fb", text="#141419", sub="#4d5261",
        faint="#8f94a4", accent="#4B67B4", accent_soft="#ece8f9",
        danger="#b42318", danger_soft="#fbeceb", amber="#b45309",
        amber_soft="#fdf1e3", track="#eae6f3", grid="#e7e4f0",
        dot="#dcd5ea", shadow="#1b1735", shadow_op="0.10",
    ),
    "dark": dict(
        bg_from="#131a2a", bg_to="#0c1016", card="#1b2231",
        edge="#2e374b", zone="#171e2d", text="#f0f3f9", sub="#a8b1c4",
        faint="#737b8d", accent="#8496f5", accent_soft="#252d44",
        danger="#f08b83", danger_soft="#3a2528", amber="#d9a03c",
        amber_soft="#33291a", track="#243049", grid="#1e2636",
        dot="#26314a", shadow="#000000", shadow_op="0.55",
    ),
}

MONO = "Consolas, 'Cascadia Mono', 'SFMono-Regular', Menlo, monospace"
SANS = "'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"


def esc(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def svg_text(x: float, y: float, text: str, size: float, fill: str,
             family: str = MONO, weight: int | None = None,
             anchor: str | None = None, spread: float | None = None) -> str:
    attrs = [f'x="{x}"', f'y="{y}"', f'fill="{fill}"',
             f'font-family="{family}"', f'font-size="{size}"']
    if weight is not None:
        attrs.append(f'font-weight="{weight}"')
    if anchor is not None:
        attrs.append(f'text-anchor="{anchor}"')
    if spread is not None:
        attrs.append(f'letter-spacing="{spread}"')
    return f'<text {" ".join(attrs)}>{esc(text)}</text>'


def measured(text: str, size: float, family: str = "mono") -> float:
    kind = {"mono": "mono", "sans": "en", "sans_bold": "en_bold"}[family]
    draw = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    return draw.textlength(text, font=font(size, kind))


def guard(tag: str, text: str, size: float, avail: float,
          family: str = "mono") -> None:
    width = measured(text, size, family)
    if width > avail:
        WARNINGS.append(f"svg {tag}: {text!r} {width:.0f}px > {avail:.0f}px")


# 14 rules the shipped pack cannot execute on the sample: 12 use a check kind
# with no handler, 2 (INV-013 lineTotals, INV-019 formTotals) declare a kind
# that the engine lists but never enters. Verified against rules/*.yaml and
# src/engine.ts; the count matches samples/quickstart/expected/result.json
# (unsupportedCount: 14).
NOT_EXECUTED = ["INV-004", "INV-007", "INV-008", "INV-011",
                "INV-012", "INV-013", "INV-014", "INV-015",
                "INV-016", "INV-018", "INV-019", "INV-023",
                "INV-024", "INV-026"]

GATE_CHIPS = ["invoiceKey", "moneyEquation", "uniqueInvoice", "duplicateAcross",
              "dateWindow", "partyMatch", "partyCompare", "placeholderScan"]


def flow_svg(skin_name: str) -> None:
    s = FLOW[skin_name]
    p: list[str] = []
    p.append(f'''<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="660" viewBox="0 0 1100 660" role="img" aria-label="dsh-invoice-ledger structure: the ledger file and the 26-rule pack converge into the invoice_ledger gate, which dispatches by params.check.kind and splits into an executed channel (3 row-level findings) and a not-executed channel (14 rule ids listed by id and kind); both channels converge again on the markdown report order and the three-sheet workbook">
<title>dsh-invoice-ledger: merge, gate, split, merge</title>
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="{s['bg_from']}"/>
    <stop offset="1" stop-color="{s['bg_to']}"/>
  </linearGradient>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="180%">
    <feDropShadow dx="0" dy="8" stdDeviation="11" flood-color="{s['shadow']}" flood-opacity="{s['shadow_op']}"/>
  </filter>
  <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
    <circle cx="1.4" cy="1.4" r="1.4" fill="{s['dot']}"/>
  </pattern>
</defs>
<rect width="1100" height="660" fill="url(#bg)"/>
<rect width="1100" height="660" fill="url(#dots)" opacity=".45"/>''')

    # header
    guard("title", "dsh-invoice-ledger", 34, 386)
    p.append(svg_text(44, 58, "dsh-invoice-ledger", 34, s["text"], weight=700))
    sub = "one ledger · 26 rules · 12 executed / 14 not executed · findings + workbook"
    guard("subtitle", sub, 15, 700, "sans")
    p.append(svg_text(44, 86, sub, 15, s["sub"], SANS))
    pill_text = "pack 2026.1 · today 2026-10-15"
    guard("pill", pill_text, 13, 280)
    p.append(f'<rect x="768" y="40" width="296" height="32" rx="16" fill="{s["accent_soft"]}"/>')
    p.append(svg_text(916, 61, pill_text, 13, s["accent"], anchor="middle"))
    p.append(f'<line x1="44" y1="104" x2="1056" y2="104" stroke="{s["grid"]}" stroke-width="1.5"/>')

    # ---------------------------------------------------------- input card
    p.append(f'<g filter="url(#soft)"><rect x="40" y="120" width="260" height="224" rx="20" fill="{s["card"]}" stroke="{s["edge"]}" stroke-width="1.5"/></g>')
    p.append(svg_text(60, 150, "INPUT · LEDGER", 17, s["accent"], weight=700, spread=0.8))
    p.append(svg_text(60, 182, "invoices.csv", 18, s["text"], weight=700))
    p.append(svg_text(60, 206, "dsh-table-ingest", 14, s["accent"]))
    p.append(svg_text(60, 230, "5 rows × 8 columns", 14, s["sub"], SANS))
    p.append(svg_text(60, 253, ".xlsx · .xlsm · .csv", 14, s["sub"]))
    p.append(f'<line x1="60" y1="265" x2="280" y2="265" stroke="{s["grid"]}" stroke-width="1.4"/>')
    p.append(svg_text(60, 289, "one invoice per row", 14, s["sub"], SANS))
    p.append(svg_text(60, 312, "invoiceNumber · issueDate", 14, s["faint"]))
    p.append(svg_text(60, 333, "amount · tax · total", 14, s["faint"]))

    # ------------------------------------------------------ rule pack card
    p.append(f'<g filter="url(#soft)"><rect x="40" y="360" width="260" height="208" rx="20" fill="{s["card"]}" stroke="{s["edge"]}" stroke-width="1.5"/></g>')
    p.append(svg_text(60, 390, "RULE PACK", 17, s["accent"], weight=700, spread=0.8))
    p.append(svg_text(60, 420, "rules/invoice-ledger.yaml", 16, s["text"], weight=700))
    p.append(svg_text(60, 444, "26 rules · version 2026.1", 14, s["sub"], SANS))
    p.append(svg_text(60, 466, "8 check families in code", 14, s["sub"], SANS))
    p.append(svg_text(60, 487, "validated on load, not trusted", 14, s["faint"], SANS))
    bar_w = 220
    ex_w = round(bar_w * 12 / 26)
    p.append(f'<rect x="60" y="504" width="{bar_w}" height="16" rx="8" fill="{s["track"]}"/>')
    p.append(f'<rect x="60" y="504" width="{ex_w}" height="16" rx="8" fill="{s["accent"]}"/>')
    p.append(f'<rect x="{60 + ex_w}" y="504" width="{bar_w - ex_w}" height="16" rx="8" fill="{s["amber"]}" opacity=".9"/>')
    p.append(svg_text(60, 544, "12 executed / 14 not executed", 14, s["sub"]))

    # ----------------------------------------------------------- gate card
    p.append(f'<g filter="url(#soft)"><rect x="330" y="120" width="336" height="310" rx="20" fill="{s["card"]}" stroke="{s["edge"]}" stroke-width="1.5"/></g>')
    p.append(svg_text(350, 153, "invoice_ledger · check()", 19, s["text"], weight=700))
    p.append(svg_text(350, 178, "dispatch by params.check.kind", 14, s["sub"], SANS))
    p.append(f'<line x1="350" y1="190" x2="646" y2="190" stroke="{s["grid"]}" stroke-width="1.4"/>')
    for i, name in enumerate(GATE_CHIPS):
        col, row = i % 2, i // 2
        x, y = 350 + col * 152, 204 + row * 34
        guard("gate chip", name, 14, 124)
        p.append(f'<rect x="{x}" y="{y}" width="144" height="28" rx="9" fill="{s["zone"]}" stroke="{s["edge"]}" stroke-width="1.2"/>')
        p.append(svg_text(x + 10, y + 19, name, 14, s["sub"]))
    p.append(f'<line x1="350" y1="352" x2="646" y2="352" stroke="{s["grid"]}" stroke-width="1.4"/>')
    p.append(f'<rect x="350" y="364" width="172" height="30" rx="15" fill="{s["accent_soft"]}"/>')
    p.append(svg_text(362, 385, "today 2026-10-15", 14, s["accent"]))
    p.append(svg_text(350, 416, "original file stays read-only", 14, s["faint"], SANS))

    # --------------------------------------------------------- executed lane
    p.append(f'<g filter="url(#soft)"><rect x="690" y="120" width="374" height="210" rx="20" fill="{s["card"]}" stroke="{s["edge"]}" stroke-width="1.5"/></g>')
    p.append(svg_text(710, 151, "EXECUTED · 12 RULES", 17, s["accent"], weight=700, spread=0.9))
    p.append(f'<rect x="958" y="132" width="86" height="26" rx="13" fill="{s["danger_soft"]}"/>')
    p.append(svg_text(1001, 150, "3 findings", 13, s["danger"], anchor="middle"))
    p.append(f'<line x1="710" y1="164" x2="1044" y2="164" stroke="{s["grid"]}" stroke-width="1.4"/>')
    findings = [
        "row 2 · invoice key ×2 (rows 1,2)",
        "row 3 · total 300.00 ≠ 226.00",
        "row 5 · issue date 2026-10-20 > today",
    ]
    for i, line in enumerate(findings):
        guard("finding", line, 16, 320, "sans")
        y = 194 + i * 34
        p.append(f'<circle cx="714" cy="{y - 5}" r="3.4" fill="{s["danger"]}"/>')
        p.append(svg_text(724, y, line, 16, s["text"], SANS))
    p.append(svg_text(710, 316, "each finding: row · actual · expected · basis", 14, s["faint"], SANS))

    # ------------------------------------------------------ not-executed lane
    p.append(f'<g filter="url(#soft)"><rect x="690" y="346" width="374" height="222" rx="20" fill="{s["card"]}" stroke="{s["edge"]}" stroke-width="1.5"/></g>')
    p.append(svg_text(710, 377, "NOT EXECUTED · 14 RULES", 17, s["amber"], weight=700, spread=0.9))
    p.append(svg_text(1044, 377, "by id", 13, s["faint"], anchor="end"))
    p.append(f'<line x1="710" y1="390" x2="1044" y2="390" stroke="{s["grid"]}" stroke-width="1.4"/>')
    p.append(svg_text(710, 414, "listed by rule id + check kind", 14, s["sub"], SANS))
    for i, rule_id in enumerate(NOT_EXECUTED):
        col, row = i % 4, i // 4
        x, y = 710 + col * 84, 426 + row * 28
        guard("rule chip", rule_id, 14, 58)
        p.append(f'<rect x="{x}" y="{y}" width="76" height="23" rx="7" fill="{s["amber_soft"]}"/>')
        p.append(svg_text(x + 9, y + 16, rule_id, 14, s["amber"]))
    p.append(svg_text(710, 552, "not executed ≠ passed · a missing column ≠ passed", 14, s["amber"], SANS))

    # ----------------------------------------------------------- connectors
    p.append(f'<path d="M300 232 H316 M300 464 H316 M316 232 V464" stroke="{s["accent"]}" stroke-width="2" fill="none" opacity=".55"/>')
    p.append(f'<path d="M316 348 H325" stroke="{s["accent"]}" stroke-width="2" opacity=".65"/>')
    p.append(f'<path d="M325 343 L333 348 L325 353 Z" fill="{s["accent"]}" opacity=".7"/>')
    p.append(f'<path d="M666 225 H681" stroke="{s["accent"]}" stroke-width="2" opacity=".6"/>')
    p.append(f'<path d="M681 220 L689 225 L681 230 Z" fill="{s["accent"]}" opacity=".7"/>')
    p.append(f'<path d="M666 392 H678 V460 H685" stroke="{s["amber"]}" stroke-width="2" fill="none" opacity=".65"/>')
    p.append(f'<path d="M685 455 L693 460 L685 465 Z" fill="{s["amber"]}" opacity=".75"/>')
    # collector bus: both lanes re-converge on the report/workbook strip
    p.append(f'<path d="M1064 300 H1078 V604 H1070" stroke="{s["accent"]}" stroke-width="2" fill="none" opacity=".5"/>')
    p.append(f'<path d="M1064 500 H1078" stroke="{s["accent"]}" stroke-width="2" opacity=".5"/>')
    p.append(f'<path d="M1070 599 L1062 604 L1070 609 Z" fill="{s["accent"]}" opacity=".7"/>')

    # ------------------------------------------------------- output strip
    p.append(f'<g filter="url(#soft)"><rect x="40" y="578" width="1024" height="52" rx="18" fill="{s["card"]}" stroke="{s["edge"]}" stroke-width="1.5"/></g>')
    p.append(svg_text(60, 601, "markdown report", 15, s["text"], weight=700))
    p.append(svg_text(60, 621, "order: not executed → findings → boundary", 14, s["sub"], SANS))
    p.append(svg_text(524, 601, "invoice-anomalies.xlsx", 15, s["text"], weight=700))
    p.append(svg_text(524, 621, "3 sheets: summary · findings · unexecuted", 14, s["sub"], SANS))
    p.append(svg_text(880, 601, "only write", 14, s["sub"], SANS, weight=700))
    p.append(svg_text(880, 621, "source stays read-only", 14, s["faint"], SANS))

    # -------------------------------------------------------------- footer
    p.append(svg_text(44, 650, "findings only, no compliance verdict · no network · no model call", 14, s["sub"], SANS))
    p.append(svg_text(1056, 650, "Apache-2.0 · PerryLink DSH plugin family", 14, s["faint"], SANS, anchor="end"))
    p.append("</svg>")

    path = os.path.join(OUT, f"dsh-invoice-ledger-flow-v5-{skin_name}.svg")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(p) + "\n")
    print(f"wrote {os.path.basename(path)}")


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for skin_name in ("light", "dark"):
        for lang in ("zh", "en"):
            hero(lang, skin_name)
        flow_svg(skin_name)
    if WARNINGS:
        print(f"{len(WARNINGS)} layout warning(s):")
        for warning in WARNINGS:
            print(f"  WARN {warning}")
    else:
        print("layout: no overflow warnings")


if __name__ == "__main__":
    main()
