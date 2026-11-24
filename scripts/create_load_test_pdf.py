"""Create a deterministic synthetic two-page PDF with a realistic image payload.

Development-only dependencies: ReportLab and Pillow (already used by PDF checks).
The existing original vector fixture becomes page 1; a noise image makes page 2
approximately 3 MB without copyrighted or user-provided material.
"""
import io
from pathlib import Path
import random

from PIL import Image
from pypdf import PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    image = Image.frombytes('RGB', (1280, 720), random.Random(42).randbytes(1280 * 720 * 3))
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(960, 540), invariant=1)
    pdf.setTitle('Synthetic LiveMitschrift load fixture')
    pdf.drawImage(ImageReader(image), 0, 0, width=960, height=540)
    pdf.setFillColorRGB(1, 1, 1); pdf.rect(30, 460, 900, 60, fill=1, stroke=0)
    pdf.setFillColorRGB(.14, .19, .28); pdf.setFont('Helvetica-Bold', 22)
    pdf.drawString(50, 480, 'Synthetic image payload / 50-reader load test')
    pdf.showPage(); pdf.save(); buffer.seek(0)
    writer = PdfWriter()
    writer.append(ROOT / 'tmp/pdfs/livemitschrift-two-pages.pdf', pages=[0], import_outline=False)
    writer.append(buffer, import_outline=False)
    path = ROOT / 'tmp/pdfs/livemitschrift-load-test.pdf'
    writer.write(path)
    assert 2_000_000 < path.stat().st_size < 10_000_000
    print(f'Created {path.relative_to(ROOT)} ({path.stat().st_size:,} bytes)')


if __name__ == '__main__': main()
