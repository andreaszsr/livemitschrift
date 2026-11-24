//! Local performance diagnostics contain timing/counts, never handwriting geometry.
use serde::Serialize;
use tauri::AppHandle;
#[cfg(not(feature="storage-smoke-test"))]
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputSettings {
    native: bool,
    mouse_coalescing_enabled: bool,
}

#[tauri::command]
pub async fn input_settings(app: AppHandle, enabled: Option<bool>) -> Result<InputSettings, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let settings = InputSettings {native:true,mouse_coalescing_enabled:crate::tablet::coalescing(enabled)};
        #[cfg(not(target_os = "macos"))]
        let settings = {let _=enabled;InputSettings {native:false,mouse_coalescing_enabled:false}};
        let _ = sender.send(settings);
    }).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(std::time::Duration::from_secs(5)).map_err(|error|error.to_string()))
        .await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub async fn save_input_profile(app: AppHandle, report: serde_json::Value) -> Result<String, String> {
    #[cfg(feature="workflow-smoke-test")]
    let report = {
        let mut report = report;
        if std::env::var("LIVEMITSCHRIFT_STORAGE_SMOKE_MODE").as_deref()==Ok("workflow-input-bridge") {
            report["source"]="synthetic 240 Hz Rust-to-WebKit bridge producer; not physical Wacom input".into();
        }
        report
    };
    let data = serde_json::to_vec_pretty(&report).map_err(|error|error.to_string())?;
    if !report.is_object() || data.len()>65_536 {return Err("Invalid input profile.".into());}
    #[cfg(not(feature="storage-smoke-test"))]
    let directory = app.path().app_data_dir().map_err(|error|error.to_string())?;
    #[cfg(feature="storage-smoke-test")]
    let directory = {let _=app;std::path::PathBuf::from(std::env::var_os("LIVEMITSCHRIFT_STORAGE_SMOKE_DIR").ok_or("Missing isolated test directory")?)};
    let path=directory.join("diagnostics").join("input-profile.json");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(path.parent().ok_or("Missing diagnostic directory")?).map_err(|error|error.to_string())?;
        // Replace only our previous diagnostic report, never a note or resource.
        let temporary=path.with_extension("json.tmp");
        std::fs::write(&temporary, data).map_err(|error|error.to_string())?;
        std::fs::rename(temporary,&path).map_err(|error|error.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|error|error.to_string())?
}
