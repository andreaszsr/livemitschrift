import { invoke, isTauri } from "@tauri-apps/api/core";
export const desktopStorageAvailable = isTauri;

export function closeApp(): Promise<void> {
  return invoke("close_app");
}

export function toggleFullscreen(): Promise<boolean> {
  return invoke("toggle_fullscreen");
}

export function openLiveViewer(url: string): Promise<void> {
  return invoke("open_live_viewer", { url });
}

/** Open an https or mailto link from a text box in the default app. */
export function openLink(url: string): Promise<void> {
  return invoke("open_link", { url });
}

export function storePdfAsset(bytes: Uint8Array): Promise<string> {
  return invoke("store_pdf_asset", bytes);
}

export async function readPdfAsset(assetId: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_pdf_asset", { assetId }));
}

export function storeImageAsset(bytes: Uint8Array): Promise<string> {
  return invoke("store_image_asset", bytes);
}

export async function readImageAsset(assetId: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_image_asset", { assetId }));
}
