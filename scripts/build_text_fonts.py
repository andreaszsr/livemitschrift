"""Build the text box fonts and their advance-width table.

Text boxes must wrap at exactly the same places in the desktop app, the reader
view and PDF exports. All three use these fonts and break lines with one shared
routine (packages/core/src/text-layout.ts) that reads the generated width
table, so no engine-specific text measurement is involved.

Sources (SIL Open Font License 1.1, pinned by SHA-256): Noto Sans and Noto Sans
Mono; arrows and mathematical operators missing in a font are copied from Noto
Sans Mono or Noto Sans Math. The result is renamed ("LiveMitschrift Sans/Mono")
because it is a modified version.

Requires fontTools (a build-time tool only):
    python3 -m venv .font-tools && .font-tools/bin/pip install fonttools==4.60.1
    .font-tools/bin/python scripts/build_text_fonts.py
"""
import hashlib
import json
import urllib.request
from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "tmp" / "fonts"
RAW = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/{0}/unhinted/ttf/{0}-Regular.ttf"
SOURCES = {
    "NotoSans": "dc67b5987378d6523e99db2a633a39f318610855da2966ea698cccb70a0dddc8",
    "NotoSansMono": "87f8ce0522a6c99b743ee5fc75b4073cfdd575639119672828b7b9944b65b4f4",
    "NotoSansMath": "b127e84699212b6b2ef50aff58e0ebebeec04ffe6db1b9eb9e209c8c3d97b4aa",
}
LICENSE_URL = "https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt"

# Latin (incl. extended), Greek, punctuation, super/subscripts, currency,
# letterlike symbols, number forms, arrows, mathematical operators,
# miscellaneous technical, box drawing (code) and geometric shapes.
RANGES = [(0x20, 0x7E), (0xA0, 0x24F), (0x1E00, 0x1EFF), (0x370, 0x3FF), (0x2000, 0x206F), (0x2070, 0x209F),
          (0x20A0, 0x20CF), (0x2100, 0x214F), (0x2150, 0x218F), (0x2190, 0x21FF), (0x2200, 0x22FF),
          (0x2300, 0x23FF), (0x2500, 0x257F), (0x25A0, 0x25FF)]
CODEPOINTS = [code for start, end in RANGES for code in range(start, end + 1)]
FONT_DIR = ROOT / "packages" / "ui" / "src" / "fonts"
METRICS = ROOT / "packages" / "core" / "src" / "text-metrics.ts"


def source(name: str) -> TTFont:
    path = CACHE / f"{name}-Regular.ttf"
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(RAW.format(name), timeout=60) as response:
            path.write_bytes(response.read())
    if hashlib.sha256(path.read_bytes()).hexdigest() != SOURCES[name]:
        raise SystemExit(f"{path} does not match the pinned SHA-256.")
    return TTFont(path)


def borrow(base: TTFont, donors: list[TTFont]) -> None:
    """Copy outlines and advances of code points the base font lacks (decomposed, same units per em)."""
    cmap, glyf, hmtx = base.getBestCmap(), base["glyf"], base["hmtx"]
    for donor in donors:
        if donor["head"].unitsPerEm != base["head"].unitsPerEm:
            raise SystemExit("Donor fonts must use the same units per em.")
        donor_cmap, glyphs = donor.getBestCmap(), donor.getGlyphSet()
        for code in CODEPOINTS:
            if code in cmap or code not in donor_cmap:
                continue
            name = f"uni{code:04X}.borrowed"
            recording = DecomposingRecordingPen(glyphs)
            glyphs[donor_cmap[code]].draw(recording)
            pen = TTGlyphPen(None)
            recording.replay(pen)
            glyf[name] = pen.glyph()  # also appends the name to glyf.glyphOrder
            hmtx[name] = (donor["hmtx"][donor_cmap[code]][0], 0)
            cmap[code] = name
    order = list(glyf.glyphOrder)
    base.setGlyphOrder(order)
    for table in base["cmap"].tables:
        if table.isUnicode():
            table.cmap.update({code: name for code, name in cmap.items() if table.format != 4 or code <= 0xFFFF})
    for name in order:
        if hasattr(glyf[name], "recalcBounds"):
            glyf[name].recalcBounds(glyf)
    hmtx_names = set(hmtx.metrics)
    for name in order:
        if name not in hmtx_names:
            hmtx[name] = (0, 0)


def rename(font: TTFont, family: str) -> None:
    for record in font["name"].names:
        if record.nameID in (1, 16):
            record.string = family
        elif record.nameID == 4:
            record.string = f"{family} Regular"
        elif record.nameID == 6:
            record.string = family.replace(" ", "") + "-Regular"


def build(base_name: str, donors: list[str], family: str, file_name: str) -> dict:
    font = source(base_name)
    borrow(font, [source(name) for name in donors])
    options = Options()
    options.layout_features = []  # no kerning or ligatures: rendering uses plain advances
    options.hinting = False
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=CODEPOINTS)
    subsetter.subset(font)
    rename(font, family)
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    font.save(FONT_DIR / file_name)
    cmap = font.getBestCmap()
    return {
        "unitsPerEm": font["head"].unitsPerEm,
        "ascent": font["hhea"].ascent,
        "descent": font["hhea"].descent,
        "widths": {code: font["hmtx"][name][0] for code, name in sorted(cmap.items())},
    }


def encode(metrics: dict) -> str:
    # Runs of consecutive code points with equal advance compress well: [start, count, advance].
    runs: list[list[int]] = []
    for code, width in metrics["widths"].items():
        if runs and runs[-1][0] + runs[-1][1] == code and runs[-1][2] == width:
            runs[-1][1] += 1
        else:
            runs.append([code, 1, width])
    return json.dumps({"unitsPerEm": metrics["unitsPerEm"], "ascent": metrics["ascent"], "descent": metrics["descent"], "runs": runs}, separators=(",", ":"))


def main() -> None:
    sans = build("NotoSans", ["NotoSansMono", "NotoSansMath"], "LiveMitschrift Sans", "LiveMitschriftSans.ttf")
    mono = build("NotoSansMono", ["NotoSansMath"], "LiveMitschrift Mono", "LiveMitschriftMono.ttf")
    with urllib.request.urlopen(LICENSE_URL, timeout=60) as response:
        (FONT_DIR / "OFL.txt").write_bytes(response.read())
    METRICS.write_text(
        "// Generated by scripts/build_text_fonts.py from the bundled text box fonts. Do not edit.\n"
        "// Advance widths in font units, as runs [first code point, count, advance].\n"
        "export interface FontMetrics { unitsPerEm: number; ascent: number; descent: number; runs: [number, number, number][] }\n"
        f"export const SANS_METRICS: FontMetrics = {encode(sans)};\n"
        f"export const MONO_METRICS: FontMetrics = {encode(mono)};\n")
    for name in ("LiveMitschriftSans.ttf", "LiveMitschriftMono.ttf"):
        print(name, (FONT_DIR / name).stat().st_size, "bytes")
    print("glyphs:", len(sans["widths"]), len(mono["widths"]))


if __name__ == "__main__":
    main()
