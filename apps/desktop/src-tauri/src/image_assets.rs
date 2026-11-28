//! Immutable local image copies (PNG or JPEG), addressed by content hash.
//! The editor downscales and re-encodes images before storing them, which also
//! drops metadata such as GPS positions; this module only accepts the result.
use crate::pdf_assets::{sha256_hex, write_atomic};
use crate::storage::StorageResult;
use std::{fs, path::{Path, PathBuf}};

pub const MAX_IMAGE_BYTES: usize = 10_000_000;
/// Longest accepted side in pixels; the editor itself stores at most 2400 px.
pub const MAX_IMAGE_SIDE: u32 = 4096;
/// Images per notebook in backups; matches the server's limit.
pub const MAX_NOTEBOOK_IMAGES: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind { Png, Jpeg }

/// File type and pixel size from the file header, without decoding the image.
pub fn image_info(bytes: &[u8]) -> Option<(ImageKind, u32, u32)> {
    let be16 = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]) as u32);
    let be32 = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        // The first chunk must be IHDR: length 13, then width and height.
        if bytes.get(12..16)? != b"IHDR" { return None; }
        return Some((ImageKind::Png, be32(16)?, be32(20)?));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        // Walk the marker segments up to the first start-of-frame (SOF0..SOF15
        // except DHT C4, JPG C8 and DAC CC), which holds height and width.
        let mut at = 2;
        loop {
            if *bytes.get(at)? != 0xff { return None; }
            let marker = *bytes.get(at + 1)?;
            if marker == 0xff { at += 1; continue; }
            if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) { at += 2; continue; }
            if marker == 0xd9 || marker == 0xda { return None; }
            let length = be16(at + 2)? as usize;
            if length < 2 { return None; }
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                return Some((ImageKind::Jpeg, be16(at + 7)?, be16(at + 5)?));
            }
            at += 2 + length;
        }
    }
    None
}

pub fn validate(bytes: &[u8]) -> StorageResult<ImageKind> {
    if bytes.len() > MAX_IMAGE_BYTES { return Err("Images may be at most 10 MB.".into()); }
    match image_info(bytes) {
        Some((kind, width, height)) if width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE => Ok(kind),
        Some(_) => Err(format!("Images may be at most {MAX_IMAGE_SIDE} pixels wide and high.").into()),
        None => Err("Expected a PNG or JPEG image.".into()),
    }
}

fn asset_path(directory: &Path, identity: &str) -> StorageResult<PathBuf> {
    if identity.len() != 64 || !identity.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("Invalid image asset identity.".into());
    }
    Ok(directory.join(format!("{identity}.image")))
}

pub fn exists(directory: &Path, identity: &str) -> bool {
    asset_path(directory, identity).is_ok_and(|path| path.is_file())
}

pub fn read(directory: &Path, identity: &str) -> StorageResult<Vec<u8>> {
    let path = asset_path(directory, identity)?;
    if fs::metadata(&path)?.len() > MAX_IMAGE_BYTES as u64 { return Err("Image asset is too large.".into()); }
    let bytes = fs::read(path)?;
    if sha256_hex(&bytes) != identity { return Err("The local image copy is damaged.".into()); }
    Ok(bytes)
}

pub fn store(directory: &Path, bytes: &[u8]) -> StorageResult<String> {
    validate(bytes)?;
    let identity = sha256_hex(bytes);
    let destination = asset_path(directory, &identity)?;
    if destination.exists() { read(directory, &identity)?; return Ok(identity); }
    write_atomic(directory, &destination, &identity, bytes)?;
    Ok(identity)
}

/// Best effort: delete stored images whose identity is not in `used`.
pub fn prune(directory: &Path, used: &std::collections::HashSet<String>) {
    let Ok(entries) = fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".image") {
            if id.len() == 64 && !used.contains(id) { let _ = fs::remove_file(entry.path()); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0]);
        bytes
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0];
        bytes.extend([0xff, 0xc0, 0, 11, 8]);
        bytes.extend(height.to_be_bytes());
        bytes.extend(width.to_be_bytes());
        bytes.extend([1, 1, 0x11, 0]);
        bytes
    }

    #[test]
    fn headers_give_type_and_size() {
        assert_eq!(image_info(&png(640, 480)), Some((ImageKind::Png, 640, 480)));
        assert_eq!(image_info(&jpeg(800, 600)), Some((ImageKind::Jpeg, 800, 600)));
        assert_eq!(image_info(b"GIF89a"), None);
        assert_eq!(image_info(&[0xff, 0xd8, 0xff]), None);
        assert!(validate(&png(5000, 10)).is_err());
        assert!(validate(&png(0, 10)).is_err());
        assert_eq!(validate(&jpeg(4096, 4096)).unwrap(), ImageKind::Jpeg);
    }

    #[test]
    fn stored_images_are_content_addressed_and_checked() {
        let directory = std::env::temp_dir().join(format!("livemitschrift-images-{}", sha256_hex(format!("{:?}", std::time::SystemTime::now()))));
        let bytes = png(10, 10);
        let id = store(&directory, &bytes).unwrap();
        assert_eq!(id, sha256_hex(&bytes));
        assert!(exists(&directory, &id));
        assert_eq!(read(&directory, &id).unwrap(), bytes);
        assert!(store(&directory, b"not an image").is_err());
        fs::write(directory.join(format!("{id}.image")), b"tampered").unwrap();
        assert!(read(&directory, &id).is_err());
        prune(&directory, &Default::default());
        assert!(!exists(&directory, &id));
        fs::remove_dir_all(&directory).unwrap();
    }
}
