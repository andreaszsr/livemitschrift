//! Open only a validated HTTP(S) read link, with arguments passed without a shell.
fn viewer_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|error| error.to_string())?;
    let identity = url.path().strip_prefix("/notebook/").unwrap_or("");
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || identity.len() != 64 || !identity.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid live-view URL.".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn open_live_viewer(url: String) -> Result<(), String> {
    let url = viewer_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let program = if cfg!(target_os = "macos") { "open" }
            else if cfg!(target_os = "windows") { "explorer.exe" } else { "xdg-open" };
        let status = std::process::Command::new(program).arg(url.as_str())
            .status().map_err(|error| error.to_string())?;
        if status.success() { Ok(()) } else { Err("Cannot open the default browser.".into()) }
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::viewer_url;
    #[test]
    fn opens_only_http_read_links_and_rejects_other_schemes_or_commands() {
        assert!(viewer_url(&format!("http://127.0.0.1:8000/notebook/{}", "a".repeat(64))).is_ok());
        for url in ["file:///etc/passwd", "https://example.com/", "javascript:alert(1)", "http://example.com/notebook/a;open"] {
            assert!(viewer_url(url).is_err());
        }
    }
}
