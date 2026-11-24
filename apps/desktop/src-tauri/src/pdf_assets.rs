//! Immutable local PDF copies, addressed by content hash rather than user paths.
use crate::storage::StorageResult;
use sha2::{Digest, Sha256};
use std::{fs::{self, File}, io::Write, path::{Path, PathBuf}};

pub const MAX_PDF_BYTES: usize = 50_000_000;
/// One notebook usually holds a whole semester of slide decks.
pub const MAX_NOTEBOOK_PDFS: usize = 128;
pub const MAX_NOTEBOOK_PDF_BYTES: usize = 500_000_000;

fn asset_path(directory: &Path, identity: &str) -> StorageResult<PathBuf> {
    if identity.len() != 64 || !identity.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("Invalid PDF asset identity.".into());
    }
    Ok(directory.join(format!("{identity}.pdf")))
}

pub fn read(directory: &Path, identity: &str) -> StorageResult<Vec<u8>> {
    let path = asset_path(directory, identity)?;
    if fs::metadata(&path)?.len() > MAX_PDF_BYTES as u64 { return Err("PDF asset is too large.".into()); }
    let bytes = fs::read(path)?;
    if format!("{:x}", Sha256::digest(&bytes)) != identity { return Err("The local PDF copy is damaged.".into()); }
    Ok(bytes)
}

pub fn store(directory: &Path, bytes: &[u8]) -> StorageResult<String> {
    if bytes.len() > MAX_PDF_BYTES || !bytes.starts_with(b"%PDF-") {
        return Err("Expected a PDF file of at most 50 MB.".into());
    }
    let identity = format!("{:x}", Sha256::digest(bytes));
    let destination = asset_path(directory, &identity)?;
    if destination.exists() { read(directory, &identity)?; return Ok(identity); }
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".{identity}.{}.tmp", std::process::id()));
    let mut file = File::options().write(true).create_new(true).open(&temporary)?;
    let result = (|| -> StorageResult<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &destination)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result?;
    Ok(identity)
}
