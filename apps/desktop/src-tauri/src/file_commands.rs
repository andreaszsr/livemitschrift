//! User-selected destinations only (PDF exports: a remembered, user-chosen folder); writing a sibling temporary preserves old files on failure.
use crate::persistence::{with_database, PersistenceState};
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};
use tauri::State;

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let temporary = path.with_file_name(format!(".livemitschrift-{name}.tmp"));
    let result = (|| {
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(path.parent().unwrap())?.sync_all()?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

async fn save(bytes: Vec<u8>, name: String, extension: &str) -> Result<bool, String> {
    #[cfg(feature = "workflow-smoke-test")]
    if let Some(directory) = std::env::var_os("LIVEMITSCHRIFT_EXPORT_TEST_DIR") {
        let path = std::path::PathBuf::from(directory).join(format!("export.{extension}"));
        write_atomic(&path, &bytes)?;
        return Ok(true);
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("LiveMitschrift speichern")
        .set_file_name(name)
        .add_filter("LiveMitschrift", &[extension])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || write_atomic(file.path(), &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(true)
}
/// Folder for PDF exports, chosen by the user; the app remembers it per notebook.
#[tauri::command]
pub async fn choose_export_folder(current: Option<String>) -> Result<Option<String>, String> {
    #[cfg(feature = "workflow-smoke-test")]
    if let Some(directory) = std::env::var_os("LIVEMITSCHRIFT_EXPORT_TEST_DIR") {
        return Ok(Some(directory.to_string_lossy().into_owned()));
    }
    let mut dialog = rfd::AsyncFileDialog::new().set_title("Exportordner wählen");
    if let Some(current) = current.filter(|path| Path::new(path).is_dir()) {
        dialog = dialog.set_directory(current);
    }
    let Some(folder) = dialog.pick_folder().await else {
        return Ok(None);
    };
    folder.path().to_str().map(|path| Some(path.to_owned())).ok_or_else(|| "Der Ordnername wird nicht unterstützt.".into())
}

#[derive(serde::Deserialize)]
struct ExportTarget {
    folder: String,
    name: String,
    replace: bool,
}

/// A plain file name without extension; never a path, hidden file or control character.
fn valid_export_name(name: &str) -> bool {
    !name.is_empty() && name.chars().count() <= 200 && name.trim() == name && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// The body is a 4-byte big-endian length, the JSON target and then the PDF,
/// so large exports stay binary. Returns "saved", or "exists" if the file is
/// present and `replace` is false.
#[tauri::command]
pub async fn export_pdf_to_folder(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("Expected export bytes.".into());
    };
    let length = body.get(..4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or("Invalid export request.")?;
    let header = body.get(4..4 + length.min(64 * 1024)).filter(|h| h.len() == length).ok_or("Invalid export request.")?;
    let target: ExportTarget = serde_json::from_slice(header).map_err(|_| "Invalid export request.")?;
    let bytes = body[4 + length..].to_vec();
    if bytes.len() > 120_000_000 || !bytes.starts_with(b"%PDF-") {
        return Err("Invalid PDF export (maximum 120 MB).".into());
    }
    let folder = Path::new(&target.folder);
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("Der Exportordner ist nicht verfügbar.".into());
    }
    if !valid_export_name(&target.name) {
        return Err("Ungültiger Dateiname.".into());
    }
    let path = folder.join(format!("{}.pdf", target.name));
    if path.exists() && !target.replace {
        return Ok("exists".into());
    }
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok("saved".into())
}
#[tauri::command]
pub async fn backup_notebook(
    state: State<'_, PersistenceState>,
    notebook_id: String,
) -> Result<bool, String> {
    let bytes = with_database(state.0.clone(), move |db| db.backup_notebook(&notebook_id)).await?;
    save(bytes, "Notizbuch.livemitschrift".into(), "livemitschrift").await
}
#[tauri::command]
pub async fn restore_notebook(
    state: State<'_, PersistenceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected backup bytes.".into());
    };
    if bytes.len() as u64 > crate::storage::archive::MAX_ARCHIVE {
        return Err("Backup exceeds 520 MB.".into());
    }
    let bytes = bytes.clone();
    with_database(state.0.clone(), move |db| db.restore_notebook(&bytes)).await
}

#[cfg(test)]
mod tests {
    use super::valid_export_name;

    #[test]
    fn export_names_are_plain_file_names() {
        for name in ["Mathe 1_Kapitel 3-2026-11-26", "Übung", "a.b"] {
            assert!(valid_export_name(name), "{name}");
        }
        for name in ["", ".hidden", "../x", "a/b", "a\\b", "a:b", " x", "x ", "a\nb", &"x".repeat(201)] {
            assert!(!valid_export_name(name), "{name:?}");
        }
    }
}
