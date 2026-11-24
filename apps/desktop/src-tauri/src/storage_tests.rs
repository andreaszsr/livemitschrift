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
    let edit=PageEdit{id:"durable-edit".into(),page_id:PAGE_ID.into(),insert:vec![ink],remove:vec![],height:1600.0};
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
    db.edit_page(&PageEdit{id:"backup-edit".into(),page_id:page.id.clone(),insert:vec![ink.clone()],remove:vec![],height:6400.0}).unwrap();
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
    let add=PageEdit{id:"add".into(),page_id:PAGE_ID.into(),insert:vec![first.clone()],remove:vec![],height:6400.0};
    db.edit_page(&add).unwrap();db.edit_page(&add).unwrap();assert_eq!(db.notebook(DOCUMENT_ID).unwrap().notebook.topics[0].pages[0].strokes.len(),1);
    let remove=PageEdit{id:"remove".into(),insert:vec![],remove:vec!["first".into()],..add.clone()};db.edit_page(&remove).unwrap();
    let mut second=stroke("second");second.order=Some(1);db.edit_page(&PageEdit{id:"second".into(),insert:vec![second.clone()],..add.clone()}).unwrap();
    db.edit_page(&PageEdit{id:"undo".into(),..add.clone()}).unwrap();let loaded=db.notebook(DOCUMENT_ID).unwrap();let page=&loaded.notebook.topics[0].pages[0];
    assert_eq!(page.strokes,vec![first,second]);assert_eq!(page.height,6400.0);assert_eq!(page.next_order,2);
    let mut conflict=add.clone();conflict.height=7000.0;assert!(db.edit_page(&conflict).is_err());
}

#[test]
fn failed_edit_does_not_delete_existing_ink_or_acknowledge_the_operation() {
    let directory=TestDirectory::new();let mut db=Database::open(&directory.database()).unwrap();db.save_stroke(DOCUMENT_ID,PAGE_ID,&stroke("saved")).unwrap();
    let mut insert=stroke("replacement");insert.order=Some(1);
    let edit=PageEdit{id:"atomic".into(),page_id:PAGE_ID.into(),insert:vec![insert],remove:vec!["saved".into()],height:6400.0};
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
    let edit=PageEdit{id:"delta-edit".into(),page_id:PAGE_ID.into(),insert:vec![ink],remove:vec![],height:1600.0};
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
    db.edit_page(&PageEdit{id:"ink".into(),page_id:page.clone(),insert:vec![ink],remove:vec![],height:1600.0}).unwrap();
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
