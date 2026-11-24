//! User-selected destinations only; writing a sibling temporary preserves old files on failure.
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
#[tauri::command]
pub async fn save_pdf_export(request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected PDF bytes.".into());
    };
    if bytes.len() > 120_000_000 || !bytes.starts_with(b"%PDF-") {
        return Err("Invalid PDF export (maximum 120 MB).".into());
    }
    save(bytes.clone(), "Mitschrift.pdf".into(), "pdf").await
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
