//! Notebook metadata and idempotent, transactional page edits over release schema 1.
use super::*;
use std::collections::{BTreeMap, HashSet};

pub const MAX_PAGE_HEIGHT: f64 = 1_000_000_000.0;
pub const MAX_PAGE_IMAGES: usize = 50;
/// Smallest placed side in document units (matches packages/core).
const MIN_IMAGE_SIZE: f64 = 12.0;

/// An image placed on a page; the bytes are a content-addressed local asset.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageImage {
    pub id: String, pub asset_id: String, pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub order: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookInfo { pub id: String, pub title: String }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub notebooks: Vec<NotebookInfo>,
    pub preferences: BTreeMap<String, String>,
    #[serde(rename="syncTargets")] pub sync_targets: Vec<SyncTarget>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct SyncTarget { pub notebook_id:String, pub server:String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePage {
    pub id: String, pub title: String, pub width: f64, pub height: f64,
    pub background: Option<PdfBackground>, pub strokes: Vec<Stroke>,
    /// Omitted when empty, so pages without images keep their previous JSON form.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<PageImage>,
    pub next_order: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Topic { pub id: String, pub title: String, pub pages: Vec<NotePage> }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Notebook { pub id: String, pub title: String, pub topics: Vec<Topic> }
#[derive(Debug, Serialize)]
pub struct NotebookLoad { pub notebook: Notebook, pub secret: String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageEdit {
    pub id: String, pub page_id: String, pub insert: Vec<Stroke>, pub remove: Vec<String>,
    // Omitted when empty: stroke-only edits keep their digest and stay readable for older servers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub insert_images: Vec<PageImage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_images: Vec<String>,
    pub height: f64,
}

pub(super) fn random_hex(bytes: usize) -> StorageResult<String> {
    let mut data = vec![0u8; bytes];
    getrandom::fill(&mut data).map_err(|error| format!("Cannot generate a local identity: {error}"))?;
    Ok(data.iter().map(|byte| format!("{byte:02x}")).collect())
}
pub(super) fn new_id(prefix: &str) -> StorageResult<String> { Ok(format!("{prefix}-{}", random_hex(16)?)) }
pub(super) fn title(value: &str) -> StorageResult<()> {
    if value.trim().is_empty() || value.chars().count() > 200 { return Err("A title must contain 1 to 200 characters.".into()); } Ok(())
}
pub(super) fn identity(value: &str) -> bool { !value.is_empty() && value.len() <= 80 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') }


impl Database {
    pub fn library(&self) -> StorageResult<Library> {
        let notebooks = self.connection.prepare("SELECT id,title FROM documents ORDER BY position,rowid")?
            .query_map([], |row| Ok(NotebookInfo { id: row.get(0)?, title: row.get(1)? }))?.collect::<Result<Vec<_>, _>>()?;
        let preferences = self.connection.prepare("SELECT key,value FROM preferences")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<BTreeMap<_, _>, _>>()?;
        let sync_targets=self.connection.prepare("SELECT document_id,server FROM sync_targets WHERE enabled=1")?
            .query_map([],|r|Ok(SyncTarget{notebook_id:r.get(0)?,server:r.get(1)?}))?.collect::<Result<Vec<_>,_>>()?;
        Ok(Library { notebooks, preferences, sync_targets })
    }

    pub fn notebook(&self, id: &str) -> StorageResult<NotebookLoad> { read_notebook(&self.connection, id) }

    pub fn preference(&mut self, key: &str, value: &str) -> StorageResult<()> {
        if key.is_empty() || key.len()>100 || value.len()>65_536 { return Err("Invalid local preference.".into()); }
        self.connection.execute("INSERT INTO preferences VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])?;
        Ok(())
    }

    pub fn create_notebook(&mut self, name: &str) -> StorageResult<String> {
        title(name)?; let id=new_id("book")?; let topic=new_id("topic")?; let page=new_id("page")?;
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("INSERT INTO documents(id,title,secret,position) SELECT ?1,?2,?3,COALESCE(MAX(position)+1,0) FROM documents",params![id,name,random_hex(32)?])?;
        transaction.execute("INSERT INTO topics VALUES(?1,?2,'Mitschrift',0)",params![topic,id])?;
        transaction.execute("INSERT INTO pages(id,document_id,width,height,topic_id,title,position) VALUES(?1,?2,1200,1600,?3,'Seite 1',0)",params![page,id,topic])?;
        super::sync::queue_structure(&transaction, &id)?; transaction.commit()?; Ok(id)
    }

    pub fn create_topic(&mut self, notebook: &str, name: &str, backgrounds: &[Option<PdfBackground>]) -> StorageResult<String> {
        title(name)?; if backgrounds.len()>1000 {return Err("A topic supports at most 1000 pages.".into());}
        let mut assets=HashSet::new();
        for pdf in backgrounds.iter().flatten() {validate_notebook_background(pdf)?;if assets.insert(&pdf.asset_id){self.read_pdf(&pdf.asset_id)?;}}
        let id=new_id("topic")?; let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.query_row("SELECT id FROM documents WHERE id=?1",[notebook],|row|row.get::<_,String>(0))?;
        let existing:i64=transaction.query_row("SELECT count(*) FROM pages WHERE document_id=?1",[notebook],|row|row.get(0))?;
        if existing+backgrounds.len().max(1) as i64>1000{return Err("Notebook page limit reached (1000).".into());}
        transaction.execute("INSERT INTO topics SELECT ?1,?2,?3,COALESCE(MAX(position)+1,0) FROM topics WHERE document_id=?2",params![id,notebook,name])?;
        let empty=[None]; let pages=if backgrounds.is_empty(){&empty[..]}else{backgrounds};
        for (index,background) in pages.iter().enumerate(){
            let height=background.as_ref().map(|pdf|(1200.0*pdf.height/pdf.width+800.0).max(1600.0)).unwrap_or(1600.0);
            if height>MAX_PAGE_HEIGHT{return Err("PDF page dimensions are too large.".into());}
            transaction.execute("INSERT INTO pages(id,document_id,width,height,background,topic_id,title,position) VALUES(?1,?2,1200,?3,?4,?5,?6,?7)",
                params![new_id("page")?,notebook,height,background.as_ref().map(serde_json::to_string).transpose()?,id,format!("Seite {}",index+1),index as i64])?;
        }
        super::sync::queue_structure(&transaction, &notebook)?; transaction.commit()?; Ok(id)
    }

    pub fn insert_blank_page(&mut self, after: &str) -> StorageResult<String> {
        let (notebook,topic,position):(String,String,i64)=self.connection.query_row("SELECT document_id,topic_id,position FROM pages WHERE id=?1",[after],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let id=new_id("page")?; let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count:i64=transaction.query_row("SELECT count(*) FROM pages WHERE document_id=?1",[&notebook],|r|r.get(0))?;
        if count>=1000{return Err("Notebook page limit reached (1000).".into());}
        transaction.execute("UPDATE pages SET position=position+10000 WHERE topic_id=?1 AND position>?2",params![topic,position])?;
        transaction.execute("UPDATE pages SET position=position-9999 WHERE topic_id=?1 AND position>=10000",[&topic])?;
        transaction.execute("INSERT INTO pages(id,document_id,width,height,topic_id,title,position) VALUES(?1,?2,1200,1600,?3,'Leere Seite',?4)",params![id,notebook,topic,position+1])?;
        super::sync::queue_structure(&transaction, &notebook)?; transaction.commit()?; Ok(id)
    }

    pub fn edit_page(&mut self, edit: &PageEdit) -> StorageResult<()> {
        if !identity(&edit.id)||!identity(&edit.page_id)||!edit.height.is_finite()||edit.height<=0.0||edit.height>MAX_PAGE_HEIGHT
            ||edit.insert.len()>1000||edit.remove.len()>1000||edit.remove.iter().any(|id|!identity(id))
            ||edit.insert_images.len()>MAX_PAGE_IMAGES||edit.remove_images.len()>MAX_PAGE_IMAGES||edit.remove_images.iter().any(|id|!identity(id)) {return Err("Invalid page edit.".into());}
        let digest=crate::pdf_assets::sha256_hex(serde_json::to_vec(edit)?);
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing)=transaction.query_row("SELECT digest FROM applied_edits WHERE id=?1",[&edit.id],|row|row.get::<_,String>(0)).optional()?{
            if existing!=digest{return Err("A different edit uses the same identity.".into());}return Ok(());
        }
        let (width,height):(f64,f64)=transaction.query_row("SELECT width,height FROM pages WHERE id=?1",[&edit.page_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let height=height.max(edit.height);let page=PageSize{width,height};let mut ids=HashSet::new();
        for stroke in &edit.insert{
            validate_stroke(stroke,&page)?;
            if !identity(&stroke.id)||!ids.insert(&stroke.id)||stroke.order.is_none_or(|order|order<0||order>9_007_199_254_740_990){return Err("Invalid stroke order or identity.".into());}
        }
        for id in &edit.remove {transaction.execute("DELETE FROM strokes WHERE page_id=?1 AND id=?2",params![edit.page_id,id])?;}
        for stroke in &edit.insert{
            let order=stroke.order.unwrap();
            let existing:Option<(String,i64,String)>=transaction.query_row("SELECT page_id,position,data FROM strokes WHERE id=?1",[&stroke.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((page,position,data))=existing{
                let mut stored:Stroke=serde_json::from_str(&data)?;stored.order=Some(position);
                if page!=edit.page_id||stored!=*stroke{return Err("Conflicting stored stroke.".into());}
            }else{transaction.execute("INSERT INTO strokes VALUES(?1,?2,?3,?4)",params![stroke.id,edit.page_id,order,serde_json::to_string(stroke)?])?;}
            transaction.execute("UPDATE pages SET next_order=MAX(next_order,?1) WHERE id=?2",params![order+1,edit.page_id])?;
        }
        let mut image_ids=HashSet::new();
        for image in &edit.insert_images{
            validate_image(image,&page)?;
            if !image_ids.insert(&image.id){return Err("Duplicate image identity.".into());}
            // The file must be stored before the page references it.
            if !crate::image_assets::exists(&self.image_directory,&image.asset_id){return Err("The image file is missing locally.".into());}
        }
        for id in &edit.remove_images {transaction.execute("DELETE FROM images WHERE page_id=?1 AND id=?2",params![edit.page_id,id])?;}
        for image in &edit.insert_images{
            let existing:Option<(String,String)>=transaction.query_row("SELECT page_id,data FROM images WHERE id=?1",[&image.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((page,data))=existing{
                let stored:PageImage=serde_json::from_str(&data)?;
                if page!=edit.page_id||stored!=*image{return Err("Conflicting stored image.".into());}
            }else{transaction.execute("INSERT INTO images VALUES(?1,?2,?3,?4)",params![image.id,edit.page_id,image.order,serde_json::to_string(image)?])?;}
            transaction.execute("UPDATE pages SET next_order=MAX(next_order,?1) WHERE id=?2",params![image.order+1,edit.page_id])?;
        }
        let images:i64=transaction.query_row("SELECT count(*) FROM images WHERE page_id=?1",[&edit.page_id],|r|r.get(0))?;
        if images as usize>MAX_PAGE_IMAGES{return Err(format!("Höchstens {MAX_PAGE_IMAGES} Bilder pro Seite.").into());}
        transaction.execute("UPDATE pages SET height=?1 WHERE id=?2",params![height,edit.page_id])?;
        transaction.execute("INSERT INTO applied_edits VALUES(?1,?2,?3)",params![edit.id,edit.page_id,digest])?;
        let notebook:String=transaction.query_row("SELECT document_id FROM pages WHERE id=?1",[&edit.page_id],|r|r.get(0))?;
        super::sync::queue_change(&transaction,&notebook,&serde_json::json!({"type":"edit","edit":edit}))?;
        transaction.commit()?;Ok(())
    }
}

pub(super) fn validate_image(image:&PageImage,page:&PageSize)->StorageResult<()>{
    let finite=[image.x,image.y,image.width,image.height].iter().all(|v|v.is_finite());
    // A thousandth of a unit absorbs rounding at the page edge, as in packages/core.
    if !identity(&image.id)||image.asset_id.len()!=64||!image.asset_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))||!finite
        ||image.x<0.0||image.y<0.0||image.width<MIN_IMAGE_SIZE||image.height<MIN_IMAGE_SIZE
        ||image.x+image.width>page.width+1e-3||image.y+image.height>page.height+1e-3||image.order<0||image.order>9_007_199_254_740_990{
        return Err("Invalid image placement.".into());
    }
    Ok(())
}

pub(super) fn validate_notebook_background(pdf:&PdfBackground)->StorageResult<()>{
    if pdf.asset_id.len()!=64||!pdf.asset_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))||pdf.name.is_empty()||pdf.name.chars().count()>200
        ||pdf.fit_height.is_some_and(|height|!height.is_finite()||height<=0.0||height>MAX_PAGE_HEIGHT)||pdf.page_number==0||pdf.page_number>1000||!pdf.width.is_finite()||!pdf.height.is_finite()||pdf.width<=0.0||pdf.height<=0.0{return Err("Invalid PDF page metadata.".into());}Ok(())
}

pub(super) fn read_notebook(connection: &Connection, id: &str) -> StorageResult<NotebookLoad> {
    let (title, secret): (String, String) = connection.query_row("SELECT title,secret FROM documents WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?)))?;
    let topics: Vec<(String,String)> = connection.prepare("SELECT id,title FROM topics WHERE document_id=?1 ORDER BY position")?
        .query_map([id], |row| Ok((row.get(0)?,row.get(1)?)))?.collect::<Result<_, _>>()?;
    let mut loaded = Vec::new();
    for (topic_id,title) in topics {
        let ids = connection.prepare("SELECT id FROM pages WHERE topic_id=?1 ORDER BY position")?
            .query_map([&topic_id], |row| row.get(0))?.collect::<Result<Vec<String>, _>>()?;
        let pages = ids.iter().map(|id| read_page(connection, id)).collect::<StorageResult<Vec<_>>>()?;
        if pages.is_empty() { return Err("Stored topic has no pages.".into()); }
        loaded.push(Topic { id: topic_id, title, pages });
    }
    if loaded.is_empty() { return Err("Stored notebook has no topics.".into()); }
    Ok(NotebookLoad { notebook: Notebook { id: id.into(), title, topics: loaded }, secret })
}

fn read_page(connection: &Connection, id: &str) -> StorageResult<NotePage> {
    let (title,width,height,background,next_order): (String,f64,f64,Option<String>,i64) = connection.query_row(
        "SELECT title,width,height,background,next_order FROM pages WHERE id=?1", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
    if width != 1200.0 || !height.is_finite() || height <= 0.0 || height > MAX_PAGE_HEIGHT { return Err("Invalid stored page extent.".into()); }
    let rows = connection.prepare("SELECT id,position,data FROM strokes WHERE page_id=?1 ORDER BY position")?
        .query_map([id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut strokes = Vec::new(); let mut next = next_order;
    for (identity,position,data) in rows {
        let mut stroke: Stroke = serde_json::from_str(&data)?;
        validate_stroke(&stroke, &PageSize {width,height})?;
        if stroke.id != identity || position < 0 { return Err("Invalid stored stroke identity or order.".into()); }
        stroke.order = Some(position); next = next.max(position+1); strokes.push(stroke);
    }
    let image_rows = connection.prepare("SELECT id,data FROM images WHERE page_id=?1 ORDER BY position")?
        .query_map([id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut images = Vec::new();
    for (identity,data) in image_rows {
        let image: PageImage = serde_json::from_str(&data)?;
        validate_image(&image, &PageSize {width,height})?;
        if image.id != identity { return Err("Invalid stored image identity.".into()); }
        next = next.max(image.order+1); images.push(image);
    }
    let background: Option<PdfBackground> = background.map(|data| serde_json::from_str(&data)).transpose()?;
    if let Some(pdf)=&background { validate_notebook_background(pdf)?; }
    Ok(NotePage {id:id.into(),title,width,height,background,strokes,images,next_order:next})
}
