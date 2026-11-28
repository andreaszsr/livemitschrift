//! A sequence and outgoing change commit in the same transaction as local data.
use super::notebooks::{random_hex, title};
use super::*;
use serde_json::{json, Value};

pub(super) fn queue_change(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    change: &Value,
) -> StorageResult<()> {
    let payload = serde_json::to_string(change)?;
    let head = random_hex(32)?;
    tx.execute(
        "UPDATE documents SET sequence=sequence+1,sync_head=?2 WHERE id=?1",
        params![id, head],
    )?;
    tx.execute(
        "INSERT INTO outbox(document_id,sequence,payload,head) SELECT id,sequence,?2,?3 FROM documents WHERE id=?1",
        params![id, payload,head],
    )?;
    Ok(())
}
pub(super) fn queue_structure(tx: &rusqlite::Transaction<'_>, id: &str) -> StorageResult<()> {
    queue_change(
        tx,
        id,
        &json!({"type":"structure","notebook":structure(tx,id)?}),
    )
}

#[derive(Serialize)]
pub struct SyncCheckpoint {
    pub sequence: i64,
    pub notebook: Notebook,
    pub pending: i64,
    pub head: String,
}
#[derive(Serialize)]
pub struct OutgoingChange {
    pub sequence: i64,
    pub change: Value,
    pub head: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub sequence: i64,
    pub head: String,
    pub first_pending: Option<i64>,
}

/// Read only metadata. A rename must not duplicate all ink in the durable outbox.
fn structure(db: &Connection, id: &str) -> StorageResult<Value> {
    let name: String = db.query_row("SELECT title FROM documents WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let topics = db
        .prepare("SELECT id,title FROM topics WHERE document_id=?1 ORDER BY position")?
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = Vec::new();
    for (topic, title) in topics {
        let pages=db.prepare("SELECT id,title,width,height,background,next_order FROM pages WHERE topic_id=?1 ORDER BY position")?
            .query_map([&topic],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,f64>(2)?,r.get::<_,f64>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,i64>(5)?)))?.collect::<Result<Vec<_>,_>>()?;
        let pages=pages.into_iter().map(|(id,title,width,height,background,next)|Ok(json!({"id":id,"title":title,"width":width,"height":height,"background":background.map(|v|serde_json::from_str::<Value>(&v)).transpose()?,"nextOrder":next,"strokes":[]}))).collect::<StorageResult<Vec<_>>>()?;
        result.push(json!({"id":topic,"title":title,"pages":pages}));
    }
    Ok(json!({"id":id,"title":name,"topics":result}))
}

impl Database {
    pub fn sync_status(&self, id: &str) -> StorageResult<SyncStatus> {
        Ok(self.connection.query_row("SELECT sequence,sync_head,(SELECT min(sequence) FROM outbox WHERE document_id=?1) FROM documents WHERE id=?1",[id],|r|Ok(SyncStatus{sequence:r.get(0)?,head:r.get(1)?,first_pending:r.get(2)?}))?)
    }
    pub fn sync_checkpoint(&self, id: &str) -> StorageResult<SyncCheckpoint> {
        let notebook = self.notebook(id)?.notebook;
        let sequence =
            self.connection
                .query_row("SELECT sequence FROM documents WHERE id=?1", [id], |r| {
                    r.get(0)
                })?;
        let pending = self.connection.query_row(
            "SELECT count(*) FROM outbox WHERE document_id=?1",
            [id],
            |r| r.get(0),
        )?;
        Ok(SyncCheckpoint {
            sequence,
            notebook,
            pending,
            head: self.sync_status(id)?.head,
        })
    }
    pub fn outgoing_changes(&self, id: &str, after: i64) -> StorageResult<Vec<OutgoingChange>> {
        let rows=self.connection.prepare("SELECT sequence,payload,head FROM outbox WHERE document_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 1")?
            .query_map(params![id,after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
        rows.into_iter()
            .map(|(sequence, payload, head)| {
                Ok(OutgoingChange {
                    sequence,
                    change: serde_json::from_str(&payload)?,
                    head,
                })
            })
            .collect()
    }
    pub fn acknowledge_changes(&mut self, id: &str, sequence: i64) -> StorageResult<()> {
        let latest: i64 =
            self.connection
                .query_row("SELECT sequence FROM documents WHERE id=?1", [id], |r| {
                    r.get(0)
                })?;
        if sequence < 0 || sequence > latest {
            return Err("Invalid synchronization acknowledgement.".into());
        }
        self.connection.execute(
            "DELETE FROM outbox WHERE document_id=?1 AND sequence<=?2",
            params![id, sequence],
        )?;
        Ok(())
    }
    pub fn sync_target(&mut self, id: &str, server: &str, enabled: bool) -> StorageResult<()> {
        if server.len() > 2000 {
            return Err("Invalid server address.".into());
        }
        self.connection.execute("INSERT INTO sync_targets VALUES(?1,?2,?3) ON CONFLICT(document_id) DO UPDATE SET server=excluded.server,enabled=excluded.enabled",params![id,server,enabled])?;
        Ok(())
    }
    pub fn rename_item(&mut self, book: &str, item: &str, name: &str) -> StorageResult<()> {
        title(name)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = if item == book {
            tx.execute(
                "UPDATE documents SET title=?1 WHERE id=?2",
                params![name, book],
            )?
        } else {
            tx.execute(
                "UPDATE topics SET title=?1 WHERE id=?2 AND document_id=?3",
                params![name, item, book],
            )?
        };
        if changed != 1 {
            return Err("Unknown notebook or topic.".into());
        }
        queue_structure(&tx, book)?;
        tx.commit()?;
        Ok(())
    }
    /// Delete one topic with its pages and ink. A notebook keeps at least one topic.
    /// The structure change is queued, so a shared server copy drops the pages too.
    pub fn delete_topic(&mut self, book: &str, topic: &str) -> StorageResult<()> {
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let topics: i64 = tx.query_row("SELECT count(*) FROM topics WHERE document_id=?1", [book], |r| r.get(0))?;
        let exists: i64 = tx.query_row("SELECT count(*) FROM topics WHERE id=?1 AND document_id=?2", params![topic, book], |r| r.get(0))?;
        if exists != 1 {
            return Err("Unknown topic.".into());
        }
        if topics <= 1 {
            return Err("Ein Notizbuch braucht mindestens ein Thema.".into());
        }
        tx.execute("DELETE FROM applied_edits WHERE page_id IN (SELECT id FROM pages WHERE topic_id=?1)", [topic])?;
        tx.execute("DELETE FROM strokes WHERE page_id IN (SELECT id FROM pages WHERE topic_id=?1)", [topic])?;
        tx.execute("DELETE FROM texts WHERE page_id IN (SELECT id FROM pages WHERE topic_id=?1)", [topic])?;
        tx.execute("DELETE FROM images WHERE page_id IN (SELECT id FROM pages WHERE topic_id=?1)", [topic])?;
        tx.execute("DELETE FROM pages WHERE topic_id=?1", [topic])?;
        tx.execute("DELETE FROM topics WHERE id=?1", [topic])?;
        queue_structure(&tx, book)?;
        tx.commit()?;
        self.prune_pdfs();
        Ok(())
    }
    /// Delete a whole local notebook, including its outbox. The last notebook stays.
    /// A server copy is not touched here; withdrawing it is a separate, explicit step.
    pub fn delete_notebook(&mut self, book: &str) -> StorageResult<()> {
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let books: i64 = tx.query_row("SELECT count(*) FROM documents", [], |r| r.get(0))?;
        let exists: i64 = tx.query_row("SELECT count(*) FROM documents WHERE id=?1", [book], |r| r.get(0))?;
        if exists != 1 {
            return Err("Unknown notebook.".into());
        }
        if books <= 1 {
            return Err("Das letzte Notizbuch kann nicht gelöscht werden.".into());
        }
        tx.execute("DELETE FROM applied_edits WHERE page_id IN (SELECT id FROM pages WHERE document_id=?1)", [book])?;
        tx.execute("DELETE FROM strokes WHERE page_id IN (SELECT id FROM pages WHERE document_id=?1)", [book])?;
        tx.execute("DELETE FROM texts WHERE page_id IN (SELECT id FROM pages WHERE document_id=?1)", [book])?;
        tx.execute("DELETE FROM images WHERE page_id IN (SELECT id FROM pages WHERE document_id=?1)", [book])?;
        for table in ["pages", "topics", "outbox", "sync_targets"] {
            tx.execute(&format!("DELETE FROM {table} WHERE document_id=?1"), [book])?;
        }
        tx.execute("DELETE FROM documents WHERE id=?1", [book])?;
        tx.commit()?;
        self.prune_pdfs();
        Ok(())
    }
    /// Best effort: remove local PDF and image copies nothing references any more.
    /// Assets are content-addressed and may be shared by several pages.
    fn prune_pdfs(&self) {
        self.prune_images();
        let Ok(mut statement) = self.connection.prepare("SELECT background FROM pages WHERE background IS NOT NULL") else { return };
        let Ok(rows) = statement.query_map([], |r| r.get::<_, String>(0)) else { return };
        let used: std::collections::HashSet<String> = rows.flatten()
            .filter_map(|json| serde_json::from_str::<Value>(&json).ok())
            .filter_map(|value| value.get("assetId").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let Ok(entries) = std::fs::read_dir(&self.asset_directory) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".pdf") {
                if id.len() == 64 && !used.contains(id) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    fn prune_images(&self) {
        let Ok(mut statement) = self.connection.prepare("SELECT data FROM images") else { return };
        let Ok(rows) = statement.query_map([], |r| r.get::<_, String>(0)) else { return };
        // A database error must never look like "nothing is used".
        let Ok(rows) = rows.collect::<Result<Vec<_>, _>>() else { return };
        let used = rows.iter().filter_map(|json| serde_json::from_str::<Value>(json).ok())
            .filter_map(|value| value.get("assetId").and_then(Value::as_str).map(str::to_owned)).collect();
        crate::image_assets::prune(&self.image_directory, &used);
    }
    pub fn reorder_items(&mut self, book: Option<&str>, ids: &[String]) -> StorageResult<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Vec<String> = if let Some(book) = book {
            tx.prepare("SELECT id FROM topics WHERE document_id=?1")?
                .query_map([book], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        } else {
            tx.prepare("SELECT id FROM documents")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        let supplied: std::collections::HashSet<_> = ids.iter().collect();
        if supplied.len() != ids.len()
            || ids.len() != existing.len()
            || existing.iter().any(|id| !supplied.contains(id))
        {
            return Err("Order must contain every item exactly once.".into());
        }
        // Temporarily move all topic positions beyond the bounded page range.
        if let Some(book) = book {
            tx.execute(
                "UPDATE topics SET position=position+100000 WHERE document_id=?1",
                [book],
            )?;
        }
        for (position, id) in ids.iter().enumerate() {
            let sql = if book.is_some() {
                "UPDATE topics SET position=?1 WHERE id=?2"
            } else {
                "UPDATE documents SET position=?1 WHERE id=?2"
            };
            tx.execute(sql, params![position as i64, id])?;
        }
        if let Some(book) = book {
            queue_structure(&tx, book)?;
        }
        tx.commit()?;
        Ok(())
    }
}
