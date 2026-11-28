use super::*;
use std::{path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);
struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("livemitschrift-storage-{}-{}", std::process::id(), NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf { self.0.join("livemitschrift.sqlite3") }
}
impl Drop for TestDirectory {
    fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
}
fn stroke(id: &str) -> Stroke {
    Stroke { id: id.into(), color: "#243147".into(), width: 3.5, complete: true, order: None, highlighter: None,
        points: vec![Point { x: 20.123456789012344, y: 1599.875, pressure: 0.01 }, Point { x: 1200.0, y: 0.0, pressure: 0.9876543210987654 }] }
}

#[test]
fn outgoing_changes_commit_with_ink_and_survive_lost_acknowledgements() {
    let directory=TestDirectory::new();
    let mut db=Database::open(&directory.database()).unwrap();
    let mut ink=stroke("durable-ink");ink.order=Some(0);
    let edit=PageEdit{insert_images:vec![],remove_images:vec![],id:"durable-edit".into(),page_id:PAGE_ID.into(),insert:vec![ink],remove:vec![],height:1600.0};
    db.connection.execute_batch("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    assert!(db.edit_page(&edit).is_err());
    assert!(db.load().unwrap().strokes.is_empty());assert_eq!(db.sync_checkpoint(DOCUMENT_ID).unwrap().sequence,0);
    db.connection.execute_batch("DROP TRIGGER fail_outbox").unwrap();db.edit_page(&edit).unwrap();db.edit_page(&edit).unwrap();
    assert_eq!(db.sync_checkpoint(DOCUMENT_ID).unwrap().sequence,1);
    drop(db);
    let mut db=Database::open(&directory.database()).unwrap();let outgoing=db.outgoing_changes(DOCUMENT_ID,0).unwrap();
    assert_eq!(outgoing.len(),1);assert_eq!(outgoing[0].change["edit"]["id"],edit.id);
    assert!(db.acknowledge_changes(DOCUMENT_ID,2).is_err());
    db.acknowledge_changes(DOCUMENT_ID,1).unwrap();db.acknowledge_changes(DOCUMENT_ID,1).unwrap();
    assert!(db.outgoing_changes(DOCUMENT_ID,0).unwrap().is_empty());assert_eq!(db.load().unwrap().strokes.len(),1);
}

#[test]
fn portable_backup_restores_pdf_ink_order_and_new_private_identities() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();
    let asset=db.store_pdf(b"%PDF- immutable original").unwrap();
    let background=PdfBackground{asset_id:asset.clone(),name:"slide.pdf".into(),page_number:1,width:960.0,height:540.0,fit_height:None};
    let topic=db.create_topic(DOCUMENT_ID,"Slides",&[Some(background)]).unwrap();
    let loaded=db.notebook(DOCUMENT_ID).unwrap();let page=&loaded.notebook.topics[1].pages[0];
    let mut ink=stroke("backup-ink");ink.order=Some(7);
    db.edit_page(&PageEdit{insert_images:vec![],remove_images:vec![],id:"backup-edit".into(),page_id:page.id.clone(),insert:vec![ink.clone()],remove:vec![],height:6400.0}).unwrap();
    db.rename_item(DOCUMENT_ID,DOCUMENT_ID,"Teaching").unwrap();
    db.reorder_items(Some(DOCUMENT_ID),&[topic,"local-topic".into()]).unwrap();
    let original=db.notebook(DOCUMENT_ID).unwrap();let bytes=db.backup_notebook(DOCUMENT_ID).unwrap();
    let imported=db.restore_notebook(&bytes).unwrap();let copy=db.notebook(&imported).unwrap();
    assert_ne!(copy.secret,original.secret);assert_ne!(copy.notebook.id,original.notebook.id);
    assert_eq!(copy.notebook.title,"Teaching");assert_eq!(copy.notebook.topics[0].title,"Slides");
    let restored=&copy.notebook.topics[0].pages[0];assert_eq!(restored.height,6400.0);assert_eq!(restored.next_order,8);
    let mut imported_ink=restored.strokes[0].clone();assert_ne!(imported_ink.id,ink.id);imported_ink.id=ink.id.clone();assert_eq!(imported_ink,ink);
    assert_eq!(restored.background.as_ref().unwrap().asset_id,asset);assert_eq!(db.read_pdf(&asset).unwrap(),b"%PDF- immutable original");
    assert_eq!(serde_json::to_value(db.notebook(DOCUMENT_ID).unwrap().notebook).unwrap(),serde_json::to_value(original.notebook).unwrap());
    let count=db.library().unwrap().notebooks.len();assert!(db.restore_notebook(b"broken backup").is_err());assert_eq!(db.library().unwrap().notebooks.len(),count);
}

#[test]
fn sorting_validates_membership_and_metadata_failures_leave_both_state_and_outbox_unchanged() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();
    let book=db.create_notebook("Second").unwrap();
    db.reorder_items(None,&[book.clone(),DOCUMENT_ID.into()]).unwrap();assert_eq!(db.library().unwrap().notebooks[0].id,book);
    assert!(db.reorder_items(None,&[book.clone(),book]).is_err());
    let sequence=db.sync_checkpoint(DOCUMENT_ID).unwrap().sequence;
    assert!(db.rename_item(DOCUMENT_ID,"missing","Renamed").is_err());
    assert!(db.reorder_items(Some(DOCUMENT_ID),&["missing".into()]).is_err());
    assert_eq!(db.sync_checkpoint(DOCUMENT_ID).unwrap().sequence,sequence);
    db.sync_target(DOCUMENT_ID,"http://127.0.0.1:8000",true).unwrap();drop(db);
    let db=Database::open(&directory.database()).unwrap();assert_eq!(db.library().unwrap().sync_targets.len(),1);
}

#[test]
fn schema_and_completed_geometry_survive_reopening() {
    let directory = TestDirectory::new();
    let initial;
    {
        let mut database = Database::open(&directory.database()).unwrap();
        initial = database.load().unwrap();
        assert!(initial.strokes.is_empty());
        for id in ["z-first", "a-second"] { database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke(id)).unwrap(); }
    }
    let database = Database::open(&directory.database()).unwrap();
    let loaded = database.load().unwrap();
    assert_eq!(loaded.document_id, initial.document_id);
    assert_eq!(loaded.page_id, initial.page_id);
    assert_eq!(loaded.page, initial.page);
    assert_eq!(loaded.strokes, vec![stroke("z-first"), stroke("a-second")]);
    assert_eq!(database.connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
}

#[test]
fn retries_are_idempotent_and_cannot_replace_committed_ink() {
    let directory = TestDirectory::new();
    let mut database = Database::open(&directory.database()).unwrap();
    let saved = stroke("same");
    database.save_stroke(DOCUMENT_ID, PAGE_ID, &saved).unwrap();
    database.save_stroke(DOCUMENT_ID, PAGE_ID, &saved).unwrap();
    let mut different = saved.clone();
    different.points[0].x = 100.0;
    assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &different).is_err());
    assert_eq!(database.load().unwrap().strokes, vec![saved]);
}

#[test]
fn failed_write_rolls_back_and_can_be_retried_after_reopening() {
    let directory = TestDirectory::new();
    {
        let mut database = Database::open(&directory.database()).unwrap();
        database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("saved")).unwrap();
        database.connection.execute_batch("CREATE TRIGGER fail_write AFTER INSERT ON strokes BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;").unwrap();
        assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("retry")).is_err());
        assert_eq!(database.load().unwrap().strokes, vec![stroke("saved")]);
        database.connection.execute_batch("DROP TRIGGER fail_write").unwrap();
    }
    let mut database = Database::open(&directory.database()).unwrap();
    database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("retry")).unwrap();
    assert_eq!(database.load().unwrap().strokes, vec![stroke("saved"), stroke("retry")]);
}

#[test]
fn read_only_write_failure_keeps_existing_data() {
    let directory = TestDirectory::new();
    let mut database = Database::open(&directory.database()).unwrap();
    database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("saved")).unwrap();
    database.connection.pragma_update(None, "query_only", "ON").unwrap();
    assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("unsaved")).is_err());
    assert_eq!(database.load().unwrap().strokes, vec![stroke("saved")]);
    database.connection.pragma_update(None, "query_only", "OFF").unwrap();
    database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("unsaved")).unwrap();
}

#[test]
fn second_writer_is_rejected_until_first_connection_closes() {
    let directory = TestDirectory::new();
    let database = Database::open(&directory.database()).unwrap();
    assert!(Database::open(&directory.database()).is_err());
    drop(database);
    assert!(Database::open(&directory.database()).is_ok());
}

#[test]
fn newer_schema_is_preserved_and_never_reset() {
    let directory = TestDirectory::new();
    {
        let database = Database::open(&directory.database()).unwrap();
        database.connection.pragma_update(None, "user_version", 99).unwrap();
    }
    assert!(Database::open(&directory.database()).is_err());
    let connection = Connection::open(directory.database()).unwrap();
    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 99);
}

#[test]
fn initialization_failure_does_not_leave_partial_schema_or_claim_success() {
    let directory = TestDirectory::new();
    {
        let connection = Connection::open(directory.database()).unwrap();
        connection.execute_batch("CREATE TABLE pages (sentinel TEXT); INSERT INTO pages VALUES ('keep me');").unwrap();
    }
    assert!(Database::open(&directory.database()).is_err());
    let connection = Connection::open(directory.database()).unwrap();
    assert_eq!(connection.query_row("SELECT sentinel FROM pages", [], |row| row.get::<_, String>(0)).unwrap(), "keep me");
    assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_master WHERE name = 'documents'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn corrupted_or_inconsistent_strokes_fail_loading_instead_of_returning_empty_page() {
    let directory = TestDirectory::new();
    let mut database = Database::open(&directory.database()).unwrap();
    database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("saved")).unwrap();
    database.connection.execute("UPDATE strokes SET data = ?1", ["{invalid json"]).unwrap();
    assert!(database.load().is_err());
    database.connection.execute("UPDATE strokes SET data = ?1", [serde_json::to_string(&stroke("wrong-id")).unwrap()]).unwrap();
    assert!(database.load().is_err());
}

#[test]
fn invalid_geometry_incomplete_strokes_and_wrong_page_are_rejected() {
    let directory = TestDirectory::new();
    let mut database = Database::open(&directory.database()).unwrap();
    let mut invalid = stroke("invalid");
    invalid.complete = false;
    assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &invalid).is_err());
    invalid.complete = true;
    invalid.points[0].pressure = f64::NAN;
    assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &invalid).is_err());
    invalid.points[0].pressure = 1.1;
    assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &invalid).is_err());
    invalid.points[0].pressure = 0.5;
    invalid.points[0].x = 1201.0;
    assert!(database.save_stroke(DOCUMENT_ID, PAGE_ID, &invalid).is_err());
    assert!(database.save_stroke("other-document", PAGE_ID, &stroke("wrong")).is_err());
    assert!(database.save_stroke(DOCUMENT_ID, "other-page", &stroke("wrong")).is_err());
    assert!(database.load().unwrap().strokes.is_empty());
}

fn pdf_background(asset_id: String) -> PdfBackground {
    PdfBackground { asset_id, name: "slide.pdf".into(), page_number: 1, width: 960.0, height: 540.0, fit_height: None }
}


#[test]
fn pdf_copy_and_metadata_survive_reopen_independently_of_ink_and_source_file() {
    let directory = TestDirectory::new();
    let bytes = b"%PDF-1.7\nindependent asset test\n%%EOF";
    let background;
    {
        let mut database = Database::open(&directory.database()).unwrap();
        database.save_stroke(DOCUMENT_ID, PAGE_ID, &stroke("existing")).unwrap();
        let source = directory.0.join("source.pdf");
        fs::write(&source, bytes).unwrap();
        let identity = database.store_pdf(&fs::read(&source).unwrap()).unwrap();
        assert_eq!(database.store_pdf(bytes).unwrap(), identity);
        fs::remove_file(source).unwrap();
        background = pdf_background(identity);
        database.set_background(DOCUMENT_ID, PAGE_ID, Some(&background)).unwrap();
    }
    let mut database = Database::open(&directory.database()).unwrap();
    assert_eq!(database.load().unwrap().background, Some(background.clone()));
    assert_eq!(database.read_pdf(&background.asset_id).unwrap(), bytes);
    assert_eq!(database.load().unwrap().strokes, vec![stroke("existing")]);
    database.set_background(DOCUMENT_ID, PAGE_ID, None).unwrap();
    assert_eq!(database.load().unwrap().background, None);
    assert_eq!(database.load().unwrap().strokes, vec![stroke("existing")]);
    assert_eq!(database.read_pdf(&background.asset_id).unwrap(), bytes);
}

#[test]
fn failed_or_invalid_background_change_preserves_current_metadata_and_ink() {
    let directory = TestDirectory::new();
    let mut database = Database::open(&directory.database()).unwrap();
    let background = pdf_background(database.store_pdf(b"%PDF-1.7\noriginal\n%%EOF").unwrap());
    database.set_background(DOCUMENT_ID, PAGE_ID, Some(&background)).unwrap();
    assert!(database.set_background(DOCUMENT_ID, PAGE_ID, Some(&pdf_background("a".repeat(64)))).is_err());
    let mut invalid = background.clone();
    invalid.page_number = 2;
    assert!(database.set_background(DOCUMENT_ID, PAGE_ID, Some(&invalid)).is_err());
    database.connection.pragma_update(None, "query_only", "ON").unwrap();
    assert!(database.set_background(DOCUMENT_ID, PAGE_ID, None).is_err());
    assert_eq!(database.load().unwrap().background, Some(background));
}

#[test]
fn asset_reads_reject_traversal_and_corruption_without_overwriting_existing_bytes() {
    let directory = TestDirectory::new();
    let database = Database::open(&directory.database()).unwrap();
    let bytes = b"%PDF-1.7\noriginal\n%%EOF";
    let identity = database.store_pdf(bytes).unwrap();
    assert!(database.store_pdf(b"not a PDF").is_err());
    assert!(database.read_pdf("../../private").is_err());
    let path = database.asset_directory.join(format!("{identity}.pdf"));
    fs::write(&path, "damaged").unwrap();
    assert!(database.read_pdf(&identity).is_err());
    assert!(database.store_pdf(bytes).is_err());
    assert_eq!(fs::read(path).unwrap(), b"damaged");
}


#[test]
fn multi_page_topics_and_inserted_blank_pages_preserve_other_notebooks() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();
    let other=db.create_notebook("Numerik").unwrap();let asset=db.store_pdf(b"%PDF-1.7\nfixture\n%%EOF").unwrap();
    let first=pdf_background(asset);let second=PdfBackground{page_number:2,..first.clone()};
    let topic=db.create_topic(DOCUMENT_ID,"Vorlesung",&[Some(first),Some(second)]).unwrap();
    let loaded=db.notebook(DOCUMENT_ID).unwrap();let pages=&loaded.notebook.topics.iter().find(|t|t.id==topic).unwrap().pages;
    assert_eq!(pages.len(),2);let original=pages[0].id.clone();let final_page=pages[1].id.clone();
    let inserted=db.insert_blank_page(&original).unwrap();let loaded=db.notebook(DOCUMENT_ID).unwrap();let pages=&loaded.notebook.topics.iter().find(|t|t.id==topic).unwrap().pages;
    assert_eq!(pages.iter().map(|p|p.id.clone()).collect::<Vec<_>>(),vec![original,inserted,final_page]);
    assert_eq!(db.notebook(&other).unwrap().notebook.topics[0].pages.len(),1);
    assert!(db.create_topic(DOCUMENT_ID,"Broken",&[Some(pdf_background("f".repeat(64)))]).is_err());
    assert_eq!(db.notebook(DOCUMENT_ID).unwrap().notebook.topics.len(),2);
}

#[test]
fn completed_edits_erase_restore_and_retry_atomically_with_original_order() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();let mut first=stroke("first");first.order=Some(0);first.points[0].y=5000.0;
    let add=PageEdit{insert_images:vec![],remove_images:vec![],id:"add".into(),page_id:PAGE_ID.into(),insert:vec![first.clone()],remove:vec![],height:6400.0};
    db.edit_page(&add).unwrap();db.edit_page(&add).unwrap();assert_eq!(db.notebook(DOCUMENT_ID).unwrap().notebook.topics[0].pages[0].strokes.len(),1);
    let remove=PageEdit{insert_images:vec![],remove_images:vec![],id:"remove".into(),insert:vec![],remove:vec!["first".into()],..add.clone()};db.edit_page(&remove).unwrap();
    let mut second=stroke("second");second.order=Some(1);db.edit_page(&PageEdit{insert_images:vec![],remove_images:vec![],id:"second".into(),insert:vec![second.clone()],..add.clone()}).unwrap();
    db.edit_page(&PageEdit{insert_images:vec![],remove_images:vec![],id:"undo".into(),..add.clone()}).unwrap();let loaded=db.notebook(DOCUMENT_ID).unwrap();let page=&loaded.notebook.topics[0].pages[0];
    assert_eq!(page.strokes,vec![first,second]);assert_eq!(page.height,6400.0);assert_eq!(page.next_order,2);
    let mut conflict=add.clone();conflict.height=7000.0;assert!(db.edit_page(&conflict).is_err());
}

#[test]
fn failed_edit_does_not_delete_existing_ink_or_acknowledge_the_operation() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();db.save_stroke(DOCUMENT_ID,PAGE_ID,&stroke("saved")).unwrap();
    let mut insert=stroke("replacement");insert.order=Some(1);
    let edit=PageEdit{insert_images:vec![],remove_images:vec![],id:"atomic".into(),page_id:PAGE_ID.into(),insert:vec![insert],remove:vec!["saved".into()],height:6400.0};
    db.connection.execute_batch("CREATE TRIGGER fail_edit BEFORE INSERT ON strokes BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
    assert!(db.edit_page(&edit).is_err());assert_eq!(db.load().unwrap().strokes[0].id,"saved");
    assert_eq!(db.connection.query_row("SELECT count(*) FROM applied_edits",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    db.connection.execute_batch("DROP TRIGGER fail_edit").unwrap();db.edit_page(&edit).unwrap();assert_eq!(db.load().unwrap().strokes[0].id,"replacement");
}



#[test]
fn delta_status_is_stable_and_structure_operations_do_not_duplicate_ink() {
    let directory = TestDirectory::new();
    let mut db = Database::open(&directory.database()).unwrap();
    let first=db.sync_status(DOCUMENT_ID).unwrap();
    assert_eq!(first.head.len(),64);
    let mut ink=stroke("delta-ink");ink.order=Some(0);
    let edit=PageEdit{insert_images:vec![],remove_images:vec![],id:"delta-edit".into(),page_id:PAGE_ID.into(),insert:vec![ink],remove:vec![],height:1600.0};
    db.edit_page(&edit).unwrap();
    let status=db.sync_status(DOCUMENT_ID).unwrap();
    assert_ne!(first.head,status.head);assert_eq!(status.first_pending,Some(1));
    assert_eq!(db.outgoing_changes(DOCUMENT_ID,0).unwrap()[0].head,status.head);
    db.rename_item(DOCUMENT_ID,DOCUMENT_ID,"Renamed").unwrap();
    let outgoing=db.outgoing_changes(DOCUMENT_ID,1).unwrap();
    assert_eq!(outgoing[0].change["type"],"structure");
    assert_eq!(outgoing[0].change["notebook"]["topics"][0]["pages"][0]["strokes"],serde_json::json!([]));
    assert_eq!(db.load().unwrap().strokes.len(),1);
    let head=db.sync_status(DOCUMENT_ID).unwrap().head;
    drop(db);
    let mut db=Database::open(&directory.database()).unwrap();
    assert_eq!(head,db.sync_status(DOCUMENT_ID).unwrap().head);
    db.acknowledge_changes(DOCUMENT_ID,1).unwrap();
    assert_eq!(db.sync_status(DOCUMENT_ID).unwrap().first_pending,Some(2));
}

#[test]
fn deleting_topics_and_notebooks_removes_ink_queues_structure_and_keeps_one_of_each() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();
    let asset=db.store_pdf(b"%PDF-1.7\ndelete\n%%EOF").unwrap();
    let topic=db.create_topic(DOCUMENT_ID,"Folien",&[Some(pdf_background(asset.clone()))]).unwrap();
    let page=db.notebook(DOCUMENT_ID).unwrap().notebook.topics.iter().find(|t|t.id==topic).unwrap().pages[0].id.clone();
    let mut ink=stroke("ink");ink.order=Some(0);
    db.edit_page(&PageEdit{insert_images:vec![],remove_images:vec![],id:"ink".into(),page_id:page.clone(),insert:vec![ink],remove:vec![],height:1600.0}).unwrap();
    let before=db.sync_status(DOCUMENT_ID).unwrap().sequence;
    // The only remaining topic of a notebook cannot be deleted.
    db.delete_topic(DOCUMENT_ID,&topic).unwrap();
    let loaded=db.notebook(DOCUMENT_ID).unwrap();
    assert_eq!(loaded.notebook.topics.len(),1);assert!(loaded.notebook.topics.iter().all(|t|t.id!=topic));
    assert!(db.sync_status(DOCUMENT_ID).unwrap().sequence>before,"structure change is queued for a shared server copy");
    assert!(db.read_pdf(&asset).is_err(),"unreferenced PDF copy is removed");
    let last=loaded.notebook.topics[0].id.clone();
    assert!(db.delete_topic(DOCUMENT_ID,&last).is_err());
    assert!(db.delete_topic(DOCUMENT_ID,"missing").is_err());
    // Notebooks: another one can be deleted, the last one cannot.
    let other=db.create_notebook("Numerik").unwrap();
    db.sync_target(&other,"https://example.org",true).unwrap();
    db.delete_notebook(&other).unwrap();
    assert_eq!(db.library().unwrap().notebooks.iter().map(|b|b.id.clone()).collect::<Vec<_>>(),vec![DOCUMENT_ID.to_string()]);
    assert!(db.delete_notebook(DOCUMENT_ID).is_err());
    assert!(db.delete_notebook("missing").is_err());
}

#[test]
fn pdfs_still_used_by_another_topic_survive_deletion() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();
    let asset=db.store_pdf(b"%PDF-1.7\nshared\n%%EOF").unwrap();
    let first=db.create_topic(DOCUMENT_ID,"A",&[Some(pdf_background(asset.clone()))]).unwrap();
    db.create_topic(DOCUMENT_ID,"B",&[Some(pdf_background(asset.clone()))]).unwrap();
    db.delete_topic(DOCUMENT_ID,&first).unwrap();
    assert!(db.read_pdf(&asset).is_ok());
}

#[test]
fn the_initial_notebook_can_be_deleted_and_the_library_still_opens() {
    let directory=TestDirectory::new();
    let other={let mut db=Database::open(&directory.database()).unwrap();
        let other=db.create_notebook("Mathematik").unwrap();db.delete_notebook(DOCUMENT_ID).unwrap();other};
    // Reopening must not depend on the former default notebook "Meine Notizen".
    let db=Database::open(&directory.database()).unwrap();
    assert_eq!(db.library().unwrap().notebooks.iter().map(|b|b.id.clone()).collect::<Vec<_>>(),vec![other.clone()]);
    assert_eq!(db.notebook(&other).unwrap().notebook.topics.len(),1);
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes.extend([8, 6, 0, 0, 0]);
    bytes
}
fn image(id: &str, asset: &str, x: f64, order: i64) -> PageImage {
    PageImage { id: id.into(), asset_id: asset.into(), x, y: 100.0, width: 300.0, height: 200.0, order }
}
fn image_edit(id: &str, insert: Vec<PageImage>, remove: Vec<String>) -> PageEdit {
    PageEdit { id: id.into(), page_id: PAGE_ID.into(), insert: vec![], remove: vec![], insert_images: insert, remove_images: remove, height: 1600.0 }
}
fn stored_images(db: &Database) -> Vec<PageImage> {
    db.notebook(DOCUMENT_ID).unwrap().notebook.topics[0].pages[0].images.clone()
}

#[test]
fn a_release_one_database_migrates_to_images_without_touching_notes_or_outbox() {
    let directory = TestDirectory::new();
    {
        // Build a schema-1 database as release 0.2 left it: no images table.
        let connection = rusqlite::Connection::open(directory.database()).unwrap();
        let schema = include_str!("schema.sql").lines().filter(|line| !line.contains("images")).collect::<Vec<_>>().join("\n");
        connection.execute_batch(&schema).unwrap();
        connection.execute("INSERT INTO documents(id,title,secret,sequence,sync_head) VALUES(?1,'Alt',?2,3,'head')", params![DOCUMENT_ID, "7".repeat(64)]).unwrap();
        connection.execute("INSERT INTO topics VALUES('local-topic',?1,'Mitschrift',0)", [DOCUMENT_ID]).unwrap();
        connection.execute("INSERT INTO pages(id,document_id,width,height,topic_id,next_order) VALUES(?1,?2,1200,1600,'local-topic',1)", params![PAGE_ID, DOCUMENT_ID]).unwrap();
        let mut ink = stroke("old-ink"); ink.order = Some(0);
        connection.execute("INSERT INTO strokes VALUES('old-ink',?1,0,?2)", params![PAGE_ID, serde_json::to_string(&ink).unwrap()]).unwrap();
        connection.execute("INSERT INTO outbox VALUES(?1,3,'{}','head')", [DOCUMENT_ID]).unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
    }
    let mut db = Database::open(&directory.database()).unwrap();
    assert_eq!(db.connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 2);
    let page = &db.notebook(DOCUMENT_ID).unwrap().notebook.topics[0].pages[0];
    assert_eq!(page.strokes.len(), 1);
    assert!(page.images.is_empty());
    assert_eq!(db.sync_status(DOCUMENT_ID).unwrap().first_pending, Some(3));
    let asset = db.store_image(&png(4, 3)).unwrap();
    db.edit_page(&image_edit("first-image", vec![image("img", &asset, 10.0, 1)], vec![])).unwrap();
    drop(db);
    // Reopening a migrated database is a no-op.
    let db = Database::open(&directory.database()).unwrap();
    assert_eq!(stored_images(&db).len(), 1);
}

#[test]
fn image_edits_insert_move_remove_idempotently_and_keep_stroke_edits_unchanged() {
    let directory = TestDirectory::new();
    let mut db = Database::open(&directory.database()).unwrap();
    let missing = "b".repeat(64);
    assert!(db.edit_page(&image_edit("needs-file", vec![image("img", &missing, 10.0, 0)], vec![])).is_err(), "file must be stored first");
    let asset = db.store_image(&png(40, 30)).unwrap();
    let insert = image_edit("insert-image", vec![image("img", &asset, 10.0, 0)], vec![]);
    db.edit_page(&insert).unwrap();
    db.edit_page(&insert).unwrap();
    assert_eq!(stored_images(&db), vec![image("img", &asset, 10.0, 0)]);
    assert_eq!(db.notebook(DOCUMENT_ID).unwrap().notebook.topics[0].pages[0].next_order, 1);
    // A move is remove + insert under the same identity.
    db.edit_page(&image_edit("move-image", vec![image("img", &asset, 500.0, 0)], vec!["img".into()])).unwrap();
    assert_eq!(stored_images(&db)[0].x, 500.0);
    for bad in [image("bad", &asset, 1000.0, 1), PageImage { width: 5.0, ..image("bad", &asset, 10.0, 1) }, image("bad", "A", 10.0, 1)] {
        assert!(db.edit_page(&image_edit("bad-edit", vec![bad], vec![])).is_err());
    }
    db.edit_page(&image_edit("remove-image", vec![], vec!["img".into()])).unwrap();
    assert!(stored_images(&db).is_empty());
    // The outbox hands out one change at a time, after a given sequence.
    let first = db.outgoing_changes(DOCUMENT_ID, 0).unwrap().remove(0);
    assert_eq!(first.change["edit"]["insertImages"][0]["assetId"], asset);
    let removal = db.outgoing_changes(DOCUMENT_ID, first.sequence + 1).unwrap().remove(0);
    assert!(removal.change["edit"].get("insertImages").is_none(), "empty image lists are omitted");
    assert_eq!(removal.change["edit"]["removeImages"][0], "img");
    // Stroke-only edits serialize exactly as before images existed.
    let mut ink = stroke("plain"); ink.order = Some(3);
    let plain = PageEdit { id: "plain-edit".into(), page_id: PAGE_ID.into(), insert: vec![ink], remove: vec![], insert_images: vec![], remove_images: vec![], height: 1600.0 };
    let keys: Vec<String> = serde_json::to_value(&plain).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["height", "id", "insert", "pageId", "remove"]);
}

#[test]
fn a_page_holds_at_most_fifty_images() {
    let directory = TestDirectory::new();
    let mut db = Database::open(&directory.database()).unwrap();
    let asset = db.store_image(&png(10, 10)).unwrap();
    let images: Vec<PageImage> = (0..50).map(|index| image(&format!("i{index}"), &asset, 10.0, index)).collect();
    db.edit_page(&image_edit("fifty", images, vec![])).unwrap();
    assert!(db.edit_page(&image_edit("one-more", vec![image("extra", &asset, 10.0, 60)], vec![])).is_err());
    assert_eq!(stored_images(&db).len(), 50);
}

#[test]
fn backups_carry_images_as_version_two_and_stay_version_one_without_images() {
    let directory = TestDirectory::new();
    let mut db = Database::open(&directory.database()).unwrap();
    let manifest_version = |bytes: &[u8]| {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("notebook.json").unwrap(), &mut text).unwrap();
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["version"].as_u64().unwrap()
    };
    assert_eq!(manifest_version(&db.backup_notebook(DOCUMENT_ID).unwrap()), 1);
    let bytes = png(64, 48);
    let asset = db.store_image(&bytes).unwrap();
    db.edit_page(&image_edit("backup-image", vec![image("img", &asset, 10.0, 0)], vec![])).unwrap();
    let backup = db.backup_notebook(DOCUMENT_ID).unwrap();
    assert_eq!(manifest_version(&backup), 2);
    let copy = db.restore_notebook(&backup).unwrap();
    let restored = db.notebook(&copy).unwrap().notebook.topics[0].pages[0].images.clone();
    assert_eq!(restored.len(), 1);
    assert_ne!(restored[0].id, "img");
    assert_eq!(PageImage { id: "img".into(), ..restored[0].clone() }, image("img", &asset, 10.0, 0));
    assert_eq!(db.read_image(&asset).unwrap(), bytes);
}

#[test]
fn deleting_the_last_page_using_an_image_prunes_its_file() {
    let directory = TestDirectory::new();
    let mut db = Database::open(&directory.database()).unwrap();
    let topic = db.create_topic(DOCUMENT_ID, "Bilder", &[]).unwrap();
    let page = db.notebook(DOCUMENT_ID).unwrap().notebook.topics[1].pages[0].id.clone();
    let asset = db.store_image(&png(8, 8)).unwrap();
    db.edit_page(&PageEdit { page_id: page, ..image_edit("on-topic", vec![image("img", &asset, 10.0, 0)], vec![]) }).unwrap();
    db.delete_topic(DOCUMENT_ID, &topic).unwrap();
    assert!(db.read_image(&asset).is_err());
}
