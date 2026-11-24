import test from "node:test";
import assert from "node:assert/strict";
import { fitPdfToPage, PAGE_SIZE, validPdfBackground } from "../dist/index.js";

test("landscape slide fits the top of the document with unchanged annotation coordinates", () => {
  const fit = fitPdfToPage(PAGE_SIZE, { width: 960, height: 540 });
  assert.deepEqual(fit, { x: 0, y: 0, width: 1200, height: 675, scale: 1.25 });
  assert.equal(fit.x + 480 * fit.scale, 600);
  assert.equal(fit.y + 270 * fit.scale, 337.5);
});

test("tall PDF fits within the page, is centered horizontally, and rejects invalid sizes", () => {
  const fit = fitPdfToPage(PAGE_SIZE, { width: 960, height: 2000 });
  assert.equal(fit.height, 1600);
  assert.equal(fit.width, 768);
  assert.equal(fit.x, 216);
  for (const width of [0, -1, Infinity, NaN]) assert.throws(() => fitPdfToPage(PAGE_SIZE, { width, height: 540 }));
});

test("PDF references are validated independently of vector ink and remain optional for blank pages", () => {
  const background = { assetId: "a".repeat(64), name: "slide.pdf", pageNumber: 1, width: 960, height: 540 };
  assert.equal(validPdfBackground(background), true);
  assert.equal(validPdfBackground({ ...background, name: "😀".repeat(200) }), true);
  for (const change of [{ assetId: "../private" }, { pageNumber: 2 }, { width: NaN }, { height: 0 }, { name: "" }]) {
    assert.equal(validPdfBackground({ ...background, ...change }), false);
  }
});

test('height-limited portrait backgrounds retain their original geometry on growing notebook pages', async () => {
  const { notebookPdfPlacement } = await import('../dist/index.js');
  const pdf = {assetId: 'a'.repeat(64), name: 'portrait.pdf', pageNumber: 1, width: 400, height: 800, fitHeight: 1600};
  assert.equal(validPdfBackground(pdf), true);
  assert.deepEqual(notebookPdfPlacement(pdf), {x: 200, y: 0, width: 800, height: 1600, scale: 2});
  const {fitHeight, ...fresh} = pdf;
  assert.equal(notebookPdfPlacement(fresh).width, 1200);
});
