//! Portable, versioned ZIP backups. Import always creates a separate notebook.
use super::notebooks::{identity, new_id, random_hex, title, validate_notebook_background};
use super::*;
use std::{
    collections::HashSet,
    io::{Cursor, Read, Write},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::pdf_assets::{MAX_NOTEBOOK_PDFS, MAX_NOTEBOOK_PDF_BYTES, MAX_PDF_BYTES};

const MAX_MANIFEST: u64 = 16_000_000;
/// Manifest plus all PDFs; ZIP entries are stored uncompressed.
pub const MAX_ARCHIVE: u64 = MAX_MANIFEST + MAX_NOTEBOOK_PDF_BYTES as u64 + 4_000_000;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    notebook: Notebook,
}

fn validate(notebook: &Notebook) -> StorageResult<HashSet<String>> {
    title(&notebook.title)?;
    let mut ids = HashSet::new();
    let mut assets = HashSet::new();
    let mut pages = 0;
    let mut points = 0;
    if notebook.topics.is_empty() || notebook.topics.len() > 1000 {
        return Err("Invalid backup topic count.".into());
    }
    for topic in &notebook.topics {
        title(&topic.title)?;
        if !identity(&topic.id) || !ids.insert(topic.id.clone()) || topic.pages.is_empty() {
            return Err("Invalid backup topic identity/pages.".into());
        }
        for page in &topic.pages {
            pages += 1;
            title(&page.title)?;
            if pages > 1000
                || !identity(&page.id)
                || !ids.insert(page.id.clone())
                || page.width != 1200.0
                || !page.height.is_finite()
                || page.height <= 0.0
                || page.height > MAX_PAGE_HEIGHT
                || page.next_order < 0
                || page.next_order > 9_007_199_254_740_991
                || page.strokes.len() > 50000
            {
                return Err("Invalid backup page.".into());
            }
            if let Some(pdf) = &page.background {
                validate_notebook_background(pdf)?;
                assets.insert(pdf.asset_id.clone());
            }
            let mut orders = HashSet::new();
            for stroke in &page.strokes {
                validate_stroke(
                    stroke,
                    &PageSize {
                        width: page.width,
                        height: page.height,
                    },
                )?;
                points += stroke.points.len();
                if !identity(&stroke.id)
                    || !ids.insert(stroke.id.clone())
                    || stroke.order.is_none_or(|order| {
                        order < 0 || order >= page.next_order || !orders.insert(order)
                    })
                    || points > 2_000_000
                {
                    return Err("Invalid backup stroke identity/order/count.".into());
                }
            }
        }
    }
    if assets.len() > MAX_NOTEBOOK_PDFS {
        return Err(format!("Backup exceeds PDF resource limit ({MAX_NOTEBOOK_PDFS}).").into());
    }
    Ok(assets)
}

impl Database {
    pub fn backup_notebook(&self, id: &str) -> StorageResult<Vec<u8>> {
        let notebook = self.notebook(id)?.notebook;
        let assets = validate(&notebook)?;
        let manifest = serde_json::to_vec(&Manifest {
            format: "LiveMitschrift".into(),
            version: 1,
            notebook,
        })?;
        if manifest.len() as u64 > MAX_MANIFEST {
            return Err("Notebook exceeds backup limit (16 MB).".into());
        }
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive.start_file("notebook.json", options)?;
        archive.write_all(&manifest)?;
        let mut total = 0;
        for asset in assets {
            let bytes = self.read_pdf(&asset)?;
            total += bytes.len();
            if total > MAX_NOTEBOOK_PDF_BYTES {
                return Err("Notebook PDFs exceed 500 MB.".into());
            }
            archive.start_file(format!("pdf/{asset}.pdf"), options)?;
            archive.write_all(&bytes)?;
        }
        Ok(archive.finish()?.into_inner())
    }
    pub fn restore_notebook(&mut self, bytes: &[u8]) -> StorageResult<String> {
        if bytes.len() as u64 > MAX_ARCHIVE {
            return Err("Backup exceeds 520 MB.".into());
        }
        let mut archive = ZipArchive::new(Cursor::new(bytes))?;
        if archive.len() > MAX_NOTEBOOK_PDFS + 1 {
            return Err("Too many backup entries.".into());
        }
        let mut names = HashSet::new();
        let mut total = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index(index)?;
            total += entry.size();
            let limit = if entry.name() == "notebook.json" { MAX_MANIFEST } else { MAX_PDF_BYTES as u64 };
            if !names.insert(entry.name().to_owned())
                || entry.size() > limit
                || total > MAX_MANIFEST + MAX_NOTEBOOK_PDF_BYTES as u64
            {
                return Err("Invalid backup entry/size.".into());
            }
        }
        let mut data = Vec::new();
        archive
            .by_name("notebook.json")?
            .take(MAX_MANIFEST + 1)
            .read_to_end(&mut data)?;
        if data.len() as u64 > MAX_MANIFEST {
            return Err("Backup manifest is too large.".into());
        }
        let Manifest {
            format,
            version,
            mut notebook,
        } = serde_json::from_slice(&data)?;
        if format != "LiveMitschrift" || version != 1 {
            return Err("Unsupported LiveMitschrift backup version.".into());
        }
        let assets = validate(&notebook)?;
        let expected: HashSet<_> = std::iter::once("notebook.json".to_owned())
            .chain(assets.iter().map(|id| format!("pdf/{id}.pdf")))
            .collect();
        if names != expected {
            return Err("Backup resources do not match its manifest.".into());
        }
        // No extraction paths are used. Verify every hash before creating references.
        let mut resources = Vec::new();
        for asset in assets {
            let mut bytes = Vec::new();
            archive
                .by_name(&format!("pdf/{asset}.pdf"))?
                .take(MAX_PDF_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > MAX_PDF_BYTES
                || !bytes.starts_with(b"%PDF-")
                || format!("{:x}", sha2::Sha256::digest(&bytes)) != asset
            {
                return Err("Damaged backup PDF.".into());
            }
            resources.push(bytes);
        }
        for bytes in resources {
            self.store_pdf(&bytes)?;
        }
        notebook.id = new_id("book")?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO documents(id,title,secret,position) SELECT ?1,?2,?3,COALESCE(MAX(position)+1,0) FROM documents",params![notebook.id,notebook.title,random_hex(32)?])?;
        for (position, topic) in notebook.topics.iter_mut().enumerate() {
            topic.id = new_id("topic")?;
            tx.execute(
                "INSERT INTO topics VALUES(?1,?2,?3,?4)",
                params![topic.id, notebook.id, topic.title, position as i64],
            )?;
            for (position, page) in topic.pages.iter_mut().enumerate() {
                page.id = new_id("page")?;
                tx.execute("INSERT INTO pages(id,document_id,width,height,background,topic_id,title,position,next_order) VALUES(?1,?2,1200,?3,?4,?5,?6,?7,?8)",params![page.id,notebook.id,page.height,page.background.as_ref().map(serde_json::to_string).transpose()?,topic.id,page.title,position as i64,page.next_order])?;
                for stroke in &mut page.strokes {
                    stroke.id = new_id("stroke")?;
                    tx.execute(
                        "INSERT INTO strokes VALUES(?1,?2,?3,?4)",
                        params![
                            stroke.id,
                            page.id,
                            stroke.order,
                            serde_json::to_string(stroke)?
                        ],
                    )?;
                }
            }
        }
        super::sync::queue_structure(&tx, &notebook.id)?;
        tx.commit()?;
        Ok(notebook.id)
    }
}

use sha2::Digest;
