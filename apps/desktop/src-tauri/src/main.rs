#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod tablet;
mod storage;
mod persistence;
mod browser;
mod pdf_assets;
mod image_assets;
mod notebook_commands;
mod file_commands;
mod publisher_credentials;
mod input_diagnostics;
#[cfg(all(feature = "storage-smoke-test", target_os = "macos"))]
mod storage_smoke_test;
#[cfg(all(feature = "workflow-smoke-test", target_os = "macos"))]
mod workflow_smoke_test;

use std::sync::atomic::Ordering;
use tauri::Manager;

fn main() {
    // Reject obsolete test overrides too: an old harness must never open user data.
    if (std::env::var_os("LIVEMITSCHRIFT_STORAGE_SMOKE_DIR").is_some() || std::env::var_os("LIVEINK_STORAGE_SMOKE_DIR").is_some()) && !cfg!(feature = "storage-smoke-test") {
        eprintln!("Storage smoke tests require a build with --features storage-smoke-test.");
        std::process::exit(2);
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tablet::init());
    #[cfg(all(feature = "storage-smoke-test", target_os = "macos"))]
    let builder = builder.plugin(storage_smoke_test::init());
    #[cfg(all(feature = "workflow-smoke-test", target_os = "macos"))]
    let builder = builder.plugin(workflow_smoke_test::init());
    builder
        .manage(persistence::PersistenceState::default())
        .manage(persistence::Lifecycle::default())
        .invoke_handler(tauri::generate_handler![
            persistence::close_app,
            persistence::toggle_fullscreen,
            browser::open_live_viewer,
            browser::open_link,
            persistence::store_pdf_asset,
            persistence::read_pdf_asset,
            persistence::store_image_asset,
            persistence::read_image_asset,
            notebook_commands::load_library,
            notebook_commands::load_notebook,
            notebook_commands::create_notebook,
            notebook_commands::create_topic,
            notebook_commands::insert_blank_page,
            notebook_commands::edit_page,
            notebook_commands::set_preference,
            notebook_commands::rename_item,
            notebook_commands::reorder_items,
            notebook_commands::delete_topic,
            notebook_commands::delete_notebook,
            notebook_commands::sync_checkpoint,
            notebook_commands::sync_status,
            notebook_commands::outgoing_changes,
            notebook_commands::acknowledge_changes,
            notebook_commands::sync_target,
            file_commands::choose_export_folder,
            file_commands::export_pdf_to_folder,
            file_commands::backup_notebook,
            file_commands::restore_notebook,
            publisher_credentials::load_publisher_key,
            publisher_credentials::save_publisher_key,
            publisher_credentials::forget_publisher_key,
            input_diagnostics::input_settings,
            input_diagnostics::save_input_profile,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<persistence::Lifecycle>();
                if state.frontend_ready.load(Ordering::Relaxed) && !state.allow_exit.load(Ordering::Relaxed) {
                    api.prevent_close();
                    persistence::request_close(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to start LiveMitschrift")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<persistence::Lifecycle>();
                if state.frontend_ready.load(Ordering::Relaxed) && !state.allow_exit.load(Ordering::Relaxed) {
                    api.prevent_exit();
                    persistence::request_close(app);
                }
            }
        });
}
