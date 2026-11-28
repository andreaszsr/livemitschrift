//! One authoritative local document. Only completed vector strokes are durable.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs::{self, File},
    path::{Path, PathBuf},
    time::Duration,
};

pub type StorageResult<T> = Result<T, Box<dyn Error + Send + Sync>>;
/// 1: release 0.1/0.2; 2: adds `images` (release 0.3).
const SCHEMA_VERSION: i64 = 2;
pub const DOCUMENT_ID: &str = "local-document";
pub const PAGE_ID: &str = "local-page";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    x: f64,
    y: f64,
    pressure: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    id: String,
    color: String,
    width: f64,
    points: Vec<Point>,
    complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
    /// Semi-transparent marker ink; absent for normal pen strokes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    highlighter: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfBackground {
    pub asset_id: String,
    pub name: String,
    pub page_number: u32,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit_height: Option<f64>,
}

/// Legacy single-page view of the initial notebook, kept for storage tests only.
#[cfg(test)]
#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDocument {
    pub document_id: String,
    pub page_id: String,
    pub page: PageSize,
    pub strokes: Vec<Stroke>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<PdfBackground>,
}

pub struct Database {
    connection: Connection,
    // Dropped after the connection. The OS releases the lock even after a crash;
    // a second app instance must not edit a stale in-memory copy of this page.
    _writer_lock: File,
    asset_directory: PathBuf,
    image_directory: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> StorageResult<Self> {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        let writer_lock = File::options().read(true).write(true).create(true)
            .truncate(false).open(path.with_extension("sqlite3.lock"))?;
        writer_lock.try_lock().map_err(|error|
            format!("Cannot open the local page. Another LiveMitschrift instance may be using it: {error}"))?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(1))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let parent = path.parent().ok_or("Database has no parent directory.")?;
        let (asset_directory, image_directory) = (parent.join("pdf"), parent.join("image"));
        let mut database = Self { connection, _writer_lock: writer_lock, asset_directory, image_directory };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&mut self) -> StorageResult<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            transaction.execute_batch(include_str!("schema.sql"))?;
            transaction.execute("INSERT INTO documents(id,title,secret,sync_head) VALUES(?1,'Meine Notizen',?2,?3)",params![DOCUMENT_ID,notebooks::random_hex(32)?,notebooks::random_hex(32)?])?;
            transaction.execute("INSERT INTO topics VALUES('local-topic',?1,'Mitschrift',0)",[DOCUMENT_ID])?;
            transaction.execute("INSERT INTO pages(id,document_id,width,height,topic_id) VALUES(?1,?2,1200,1600,'local-topic')",params![PAGE_ID,DOCUMENT_ID])?;
        } else if version == 1 {
            // Additive step: existing notebooks, outbox and acknowledgements stay untouched.
            transaction.execute_batch("CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),position INTEGER NOT NULL CHECK(position>=0),data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS image_page ON images(page_id);")?;
        } else if version != SCHEMA_VERSION {
            return Err(format!("Unsupported database version {version}; this release supports up to {SCHEMA_VERSION}. Please update LiveMitschrift.").into());
        }
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        Ok(())
    }

    #[cfg(test)] // legacy single-page API, exercised by storage tests
    fn page(&self, document_id: &str, page_id: &str) -> StorageResult<PageSize> {
        let page = self.connection.query_row(
            "SELECT width, height FROM pages WHERE id = ?1 AND document_id = ?2",
            params![page_id, document_id],
            |row| Ok(PageSize { width: row.get(0)?, height: row.get(1)? }),
        )?;
        if !page.width.is_finite() || !page.height.is_finite() || page.width <= 0.0 || page.height <= 0.0 {
            return Err("Invalid stored page dimensions.".into());
        }
        Ok(page)
    }

    #[cfg(test)]
    pub fn load(&self) -> StorageResult<LocalDocument> {
        let page = self.page(DOCUMENT_ID, PAGE_ID)?;
        let mut statement = self.connection.prepare("SELECT id, data FROM strokes WHERE page_id = ?1 ORDER BY position")?;
        let rows = statement.query_map([PAGE_ID], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        let mut strokes = Vec::new();
        for row in rows {
            let (id, data) = row?;
            let stroke: Stroke = serde_json::from_str(&data)?;
            validate_stroke(&stroke, &page)?;
            if stroke.id != id { return Err("Stored stroke identity does not match its data.".into()); }
            strokes.push(stroke);
        }
        let background_json: Option<String> = self.connection.query_row(
            "SELECT background FROM pages WHERE id = ?1", [PAGE_ID], |row| row.get(0))?;
        let background: Option<PdfBackground> = background_json.map(|data| serde_json::from_str(&data)).transpose()?;
        if let Some(pdf) = &background { validate_background(pdf)?; }
        Ok(LocalDocument { document_id: DOCUMENT_ID.into(), page_id: PAGE_ID.into(), page, strokes, background })
    }

    pub fn store_pdf(&self, bytes: &[u8]) -> StorageResult<String> {
        crate::pdf_assets::store(&self.asset_directory, bytes)
    }

    pub fn read_pdf(&self, identity: &str) -> StorageResult<Vec<u8>> {
        crate::pdf_assets::read(&self.asset_directory, identity)
    }

    pub fn store_image(&self, bytes: &[u8]) -> StorageResult<String> {
        crate::image_assets::store(&self.image_directory, bytes)
    }

    pub fn read_image(&self, identity: &str) -> StorageResult<Vec<u8>> {
        crate::image_assets::read(&self.image_directory, identity)
    }

    #[cfg(test)] // legacy single-page API, exercised by storage tests
    pub fn set_background(&mut self, document_id: &str, page_id: &str, background: Option<&PdfBackground>) -> StorageResult<()> {
        self.page(document_id, page_id)?;
        if let Some(pdf) = background {
            validate_background(pdf)?;
            self.read_pdf(&pdf.asset_id)?;
        }
        let data = background.map(serde_json::to_string).transpose()?;
        let transaction = self.connection.transaction()?;
        transaction.execute("UPDATE pages SET background = ?1 WHERE id = ?2 AND document_id = ?3", params![data, page_id, document_id])?;
        sync::queue_structure(&transaction,document_id)?;
        transaction.commit()?;
        Ok(())
    }

    #[cfg(test)] // legacy single-page API, exercised by storage tests
    pub fn save_stroke(
        &mut self,
        document_id: &str,
        page_id: &str,
        stroke: &Stroke,
    ) -> StorageResult<()> {
        let page = self.page(document_id, page_id)?;
        validate_stroke(stroke, &page)?;
        let data = serde_json::to_string(stroke)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String)> = transaction.query_row(
            "SELECT page_id, data FROM strokes WHERE id = ?1", [&stroke.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((existing_page, existing_data)) = existing {
            // A lost acknowledgement can retry the same stroke, but may never
            // replace different geometry under an already committed identity.
            if existing_page != page_id || existing_data != data {
                return Err("A different stroke already uses this identity.".into());
            }
        } else {
            transaction.execute(
                "INSERT INTO strokes (id, page_id, position, data)
                 SELECT ?1, ?2, COALESCE(MAX(position) + 1, 0), ?3 FROM strokes WHERE page_id = ?2",
                params![stroke.id, page_id, data],
            )?;
            let position:i64=transaction.query_row("SELECT position FROM strokes WHERE id=?1",[&stroke.id],|r|r.get(0))?;
            let mut outgoing=stroke.clone();outgoing.order=Some(position);
            transaction.execute("UPDATE pages SET next_order=MAX(next_order,?1) WHERE id=?2",params![position+1,page_id])?;
            sync::queue_change(&transaction,document_id,&serde_json::json!({"type":"edit","edit":{
                "id":notebooks::new_id("edit")?,"pageId":page_id,"insert":[outgoing],"remove":[],"height":page.height
            }}))?;
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)] // legacy single-page API, exercised by storage tests
fn validate_background(pdf: &PdfBackground) -> StorageResult<()> {
    if pdf.asset_id.len() != 64 || !pdf.asset_id.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || pdf.name.is_empty() || pdf.name.chars().count() > 200 || pdf.page_number != 1
        || !pdf.width.is_finite() || !pdf.height.is_finite() || pdf.width <= 0.0 || pdf.height <= 0.0 {
        return Err("Invalid PDF background metadata.".into());
    }
    Ok(())
}

fn validate_stroke(stroke: &Stroke, page: &PageSize) -> StorageResult<()> {
    // `highlighter` is either absent or true, matching the server's wire format.
    if stroke.id.is_empty() || stroke.id.len() > 128 || !stroke.complete || stroke.points.is_empty()
        || stroke.highlighter == Some(false)
        || !stroke.width.is_finite() || stroke.width <= 0.0
        || stroke.color.len() != 7 || !stroke.color.starts_with('#')
        || !stroke.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        || stroke.points.iter().any(|point| !point.x.is_finite() || !point.y.is_finite()
            || !point.pressure.is_finite() || !(0.0..=page.width).contains(&point.x)
            || !(0.0..=page.height).contains(&point.y) || !(0.0..=1.0).contains(&point.pressure))
    {
        return Err("Invalid completed stroke.".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;

#[path = "notebook_storage.rs"]
mod notebooks;
pub use notebooks::*;

#[path="sync_storage.rs"]
mod sync;
pub use sync::*;
#[path="archive.rs"]
pub mod archive;
