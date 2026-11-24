//! Server credentials stay out of SQLite, portable backups and general preferences.

// Keychain interaction is process-wide. Serialize every credential operation so
// a background read cannot suppress a concurrent explicit save/load prompt.
static CREDENTIAL_ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn credential_access<T>(interactive: bool, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _access = CREDENTIAL_ACCESS.lock().map_err(|_| "Credential access is unavailable.".to_string())?;
    #[cfg(all(target_os = "macos", not(feature = "storage-smoke-test")))]
    let _interaction = {
        use security_framework::os::macos::keychain::SecKeychain;
        if !interactive && SecKeychain::user_interaction_allowed().map_err(|e| e.to_string())? {
            Some(SecKeychain::disable_user_interaction().map_err(|e| e.to_string())?)
        } else {None}
    };
    #[cfg(any(not(target_os = "macos"), feature = "storage-smoke-test"))]
    let _ = interactive;
    action()
}

fn origin(server: &str) -> Result<String, String> {
    let url = tauri::Url::parse(server).map_err(|_| "Invalid server address.")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use HTTPS, or HTTP with a loopback address for local tests.".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(not(feature = "storage-smoke-test"))]
fn read_key(server: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("de.livemitschrift.desktop.publisher", server)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Cannot access the operating system credential store: {error}"
        )),
    }
}
#[cfg(not(feature = "storage-smoke-test"))]
fn write_key(server: &str, key: &str) -> Result<(), String> {
    keyring::Entry::new("de.livemitschrift.desktop.publisher", server)
        .map_err(|e| e.to_string())?
        .set_password(key)
        .map_err(|e| {
            format!("Cannot save the publisher key in the operating system credential store: {e}")
        })
}

#[cfg(not(feature = "storage-smoke-test"))]
fn forget_key(server: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("de.livemitschrift.desktop.publisher", server)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Cannot remove the stored publisher key: {error}")),
    }
}
#[cfg(feature = "storage-smoke-test")]
fn forget_key(server: &str) -> Result<(), String> {
    match std::fs::remove_file(test_path(server)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

// Native integration tests never access the real user's credential store.
#[cfg(feature = "storage-smoke-test")]
fn test_path(server: &str) -> Result<std::path::PathBuf, String> {
    let directory = std::env::var_os("LIVEMITSCHRIFT_STORAGE_SMOKE_DIR")
        .ok_or("An isolated credential test directory is required.")?;
    Ok(std::path::PathBuf::from(directory).join(format!(
        "publisher-{}.key",
        crate::pdf_assets::sha256_hex(server)
    )))
}
#[cfg(feature = "storage-smoke-test")]
fn read_key(server: &str) -> Result<Option<String>, String> {
    let path = test_path(server)?;
    if path.exists() {
        return std::fs::read_to_string(path)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    Ok(std::env::var("LIVEMITSCHRIFT_TEST_PUBLISHER_KEY").ok())
}
#[cfg(feature = "storage-smoke-test")]
fn write_key(server: &str, key: &str) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(test_path(server)?)
        .map_err(|e| e.to_string())?;
    file.write_all(key.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_publisher_key(server: String, interactive: Option<bool>) -> Result<Option<String>, String> {
    let server = origin(&server)?;
    let interactive = interactive.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "storage-smoke-test")]
        if !interactive && std::env::var("LIVEMITSCHRIFT_TEST_KEYCHAIN_LOCKED").as_deref() == Ok("1") {return Ok(None);}
        let result = credential_access(interactive, || read_key(&server));
        // Locked/unauthorized stores pause automatic publishing. Only an explicit
        // user action may ask macOS to grant access or report its detailed error.
        if interactive {result} else {Ok(result.unwrap_or(None))}
    })
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_publisher_key(server: String, key: String) -> Result<(), String> {
    let server = origin(&server)?;
    if !valid_key(&key) {
        return Err("The server key must contain 64 lowercase hexadecimal characters.".into());
    }
    tauri::async_runtime::spawn_blocking(move || credential_access(true, || write_key(&server, &key)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn forget_publisher_key(server: String) -> Result<(), String> {
    let server = origin(&server)?;
    tauri::async_runtime::spawn_blocking(move || credential_access(true, || forget_key(&server)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_bound_to_a_secure_exact_server_origin() {
        assert_eq!(
            origin("https://example.org:443").unwrap(),
            "https://example.org"
        );
        assert!(origin("http://127.0.0.1:8000").is_ok());
        assert!(origin("http://[::1]:8000").is_ok());
        for value in [
            "http://example.org",
            "http://127.0.0.1.example.org",
            "https://user:key@example.org",
            "https://example.org/path",
            "https://example.org/?key=secret",
        ] {
            assert!(origin(value).is_err());
        }
        assert!(valid_key(&"a".repeat(64)));
        assert!(!valid_key("password"));
    }
}
