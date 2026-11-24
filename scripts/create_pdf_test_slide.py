"""Create an original, deterministic one-page slide and a negative test fixture."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parents[1]


def draw_slide(pdf):
    pdf.setFillColor(HexColor("#ffffff"))
    pdf.rect(0, 0, 960, 540, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#243147"))
    pdf.rect(0, 468, 960, 72, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#ffffff"))
    pdf.setFont("Helvetica-Bold", 26)
    pdf.drawString(48, 497, "LiveMitschrift / PDF slide test")
    pdf.setFillColor(HexColor("#64748b"))
    pdf.setFont("Helvetica", 15)
    pdf.drawString(48, 429, "One PDF. The same geometry in the desktop and browser.")
    pdf.setFillColor(HexColor("#243147"))
    pdf.setFont("Helvetica-Bold", 23)
    pdf.drawString(48, 363, "A simple linear function")
    pdf.setFont("Helvetica", 27)
    pdf.drawString(48, 311, "f(x) = x / 2 + 1")
    pdf.setFillColor(HexColor("#64748b"))
    pdf.setFont("Helvetica", 14)
    pdf.drawString(48, 259, "Draw on the slide, then zoom and scroll.")
    pdf.drawString(48, 236, "Your annotations stay independent of the PDF.")
    # This solid target has known PDF coordinates for alignment checks.
    pdf.setFillColor(HexColor("#397566"))
    pdf.rect(448, 238, 64, 64, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#64748b"))
    pdf.setFont("Helvetica", 11)
    pdf.drawCentredString(480, 216, "Annotation target")
    pdf.setStrokeColor(HexColor("#dfe4ec"))
    pdf.setLineWidth(1)
    for x in range(600, 901, 50):
        pdf.line(x, 150, x, 370)
    for y in range(150, 371, 55):
        pdf.line(600, y, 900, y)
    pdf.setStrokeColor(HexColor("#243147"))
    pdf.setLineWidth(2)
    pdf.line(600, 150, 915, 150)
    pdf.line(600, 150, 600, 385)
    pdf.setStrokeColor(HexColor("#397566"))
    pdf.setLineWidth(4)
    pdf.line(600, 205, 900, 370)
    pdf.setFillColor(HexColor("#64748b"))
    pdf.setFont("Helvetica", 12)
    pdf.drawString(919, 146, "x")
    pdf.drawString(586, 391, "y")
    pdf.setFont("Helvetica", 11)
    pdf.drawString(48, 52, "Original test slide. Landscape 960 x 540 PDF points.")
    pdf.drawRightString(912, 52, "1 / 1")


def create(path: Path, pages: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=(960, 540), invariant=1, pageCompression=1)
    pdf.setTitle("LiveMitschrift PDF test slide")
    pdf.setAuthor("LiveMitschrift")
    for _ in range(pages):
        draw_slide(pdf)
        pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    create(ROOT / "output/pdf/livemitschrift-test-slide.pdf", 1)
    create(ROOT / "tmp/pdfs/livemitschrift-two-pages.pdf", 2)
