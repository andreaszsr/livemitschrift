// Keep worker, fonts and decoders at local URLs in both deployment targets.
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const source = dirname(require.resolve("pdfjs-dist/package.json"));
const vendor = join(root, "packages/pdf/dist/vendor");
await mkdir(vendor, { recursive: true });
await cp(join(source, "LICENSE"), join(vendor, "LICENSE"));
await cp(join(root, 'node_modules/pdf-lib/dist/pdf-lib.esm.min.js'), join(vendor, 'pdf-lib.min.mjs'));
for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  await cp(join(source, "build", name), join(vendor, name));
}
for (const name of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(join(source, name), join(vendor, name), { recursive: true });
}
// Retain attribution for bundled runtime JavaScript, including export helpers.
const notices = join(vendor, "third-party");
await mkdir(notices, { recursive: true });
for (const name of ["pdfjs-dist", "pdf-lib", "@pdf-lib/standard-fonts", "@pdf-lib/upng", "pako", "tslib", "@tauri-apps/api"]) {
  const directory = join(root, "node_modules", name);
  const destination = join(notices, name.replaceAll("/", "_"));
  await mkdir(destination, { recursive: true });
  const metadata = require(join(directory, "package.json"));
  await writeFile(join(destination, "package.txt"), `${name} ${metadata.version}\nLicense: ${metadata.license}\n`);
  for (const file of await readdir(directory)) {
    if (/^(license|copying|copyright|notice)/i.test(file)) {
      await cp(join(directory, file), join(destination, file), { recursive: true });
    }
  }
}
await cp(vendor, join(root, "apps/desktop/public/pdfjs"), { recursive: true });
