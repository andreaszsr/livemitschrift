//! Tauri boundary: SQLite work runs on blocking workers, never the AppKit loop.
use crate::storage::Database;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct PersistenceState(pub Arc<Mutex<Option<Database>>>);

#[derive(Default)]
pub struct Lifecycle {
    pub frontend_ready: AtomicBool,
    pub allow_exit: AtomicBool,
}

/// Open the local database once. It does not read any particular notebook:
/// every notebook, including the initial "Meine Notizen", may be deleted.
pub async fn open_database(
    app: AppHandle,
    state: State<'_, PersistenceState>,
    lifecycle: State<'_, Lifecycle>,
) -> Result<(), String> {
    lifecycle.frontend_ready.store(true, Ordering::Relaxed);
    #[cfg(not(feature = "storage-smoke-test"))]
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("release-v1");
    // Feature-gated test builds require an isolated directory and can never
    // silently fall back to the user's real database.
    #[cfg(feature = "storage-smoke-test")]
    let directory = std::path::PathBuf::from(
        std::env::var_os("LIVEMITSCHRIFT_STORAGE_SMOKE_DIR")
            .ok_or("An isolated smoke-test directory is required.")?,
    );
    #[cfg(feature = "storage-smoke-test")]
    let _ = app;
    let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = state.lock().map_err(|_| "Local storage worker failed.".to_string())?;
        if slot.is_none() {
            let path=directory.join("livemitschrift.sqlite3");
            *slot = Some(Database::open(&path).map_err(|error| error.to_string())?);
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn store_pdf_asset(state: State<'_, PersistenceState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected PDF bytes.".into()); };
    if bytes.len() > crate::pdf_assets::MAX_PDF_BYTES { return Err("PDF exceeds 50 MB.".into()); }
    let bytes = bytes.clone();
    let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let slot = state.lock().map_err(|_| "Local storage worker failed.")?;
        slot.as_ref().ok_or("Load the local document first.")?.store_pdf(&bytes).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_pdf_asset(state: State<'_, PersistenceState>, asset_id: String) -> Result<tauri::ipc::Response, String> {
    let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let slot = state.lock().map_err(|_| "Local storage worker failed.")?;
        let bytes = slot.as_ref().ok_or("Load the local document first.")?.read_pdf(&asset_id).map_err(|error| error.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn store_image_asset(state: State<'_, PersistenceState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected image bytes.".into()); };
    if bytes.len() > crate::image_assets::MAX_IMAGE_BYTES { return Err("Images may be at most 10 MB.".into()); }
    let bytes = bytes.clone();
    with_database(state.0.clone(), move |database| database.store_image(&bytes)).await
}

#[tauri::command]
pub async fn read_image_asset(state: State<'_, PersistenceState>, asset_id: String) -> Result<tauri::ipc::Response, String> {
    let bytes = with_database(state.0.clone(), move |database| database.read_image(&asset_id)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn close_app(app: AppHandle, state: State<'_, Lifecycle>) {
    state.allow_exit.store(true, Ordering::Relaxed);
    app.exit(0);
}

/// Toggle native fullscreen for projector use; returns the new state.
#[tauri::command]
pub fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|error| error.to_string())?;
    window.set_fullscreen(next).map_err(|error| error.to_string())?;
    Ok(next)
}

pub fn request_close(app: &AppHandle) {
    if let Some(webview) = app.get_webview_window("main") {
        if let Err(error) = webview.eval("window.dispatchEvent(new Event('livemitschrift-close-request'));") {
            eprintln!("Cannot request save before closing: {error}");
        }
    }
}

pub async fn with_database<T, F>(database: Arc<Mutex<Option<Database>>>, action: F) -> Result<T, String>
where T: Send + 'static, F: FnOnce(&mut Database) -> crate::storage::StorageResult<T> + Send + 'static {
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = database.lock().map_err(|_| "Local storage worker failed.".to_string())?;
        action(slot.as_mut().ok_or("Load the local library first.")?).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}
