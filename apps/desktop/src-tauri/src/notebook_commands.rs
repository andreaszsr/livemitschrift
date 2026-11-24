//! Typed IPC for the teaching workflow; all database work stays off the UI loop.
use crate::{persistence::{self, Lifecycle, PersistenceState}, storage::{Library, NotebookLoad, PageEdit, PdfBackground}};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn load_library(app: AppHandle, state: State<'_, PersistenceState>, lifecycle: State<'_, Lifecycle>) -> Result<Library,String> {
    let database=state.0.clone();
    persistence::open_database(app,state,lifecycle).await?;
    persistence::with_database(database,|db|db.library()).await
}
#[tauri::command]
pub async fn load_notebook(state: State<'_,PersistenceState>, notebook_id:String)->Result<NotebookLoad,String>{
    persistence::with_database(state.0.clone(),move|db|db.notebook(&notebook_id)).await
}
#[tauri::command]
pub async fn create_notebook(state: State<'_,PersistenceState>, title:String)->Result<String,String>{
    persistence::with_database(state.0.clone(),move|db|db.create_notebook(&title)).await
}
#[tauri::command]
pub async fn create_topic(state: State<'_,PersistenceState>, notebook_id:String,title:String,backgrounds:Vec<Option<PdfBackground>>)->Result<String,String>{
    persistence::with_database(state.0.clone(),move|db|db.create_topic(&notebook_id,&title,&backgrounds)).await
}
#[tauri::command]
pub async fn insert_blank_page(state: State<'_,PersistenceState>,after_page_id:String)->Result<String,String>{
    persistence::with_database(state.0.clone(),move|db|db.insert_blank_page(&after_page_id)).await
}
#[tauri::command]
pub async fn edit_page(state: State<'_,PersistenceState>,edit:PageEdit)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.edit_page(&edit)).await
}
#[tauri::command]
pub async fn set_preference(state: State<'_,PersistenceState>,key:String,value:String)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.preference(&key,&value)).await
}

#[tauri::command]
pub async fn rename_item(state:State<'_,PersistenceState>,notebook_id:String,item_id:String,title:String)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.rename_item(&notebook_id,&item_id,&title)).await
}
#[tauri::command]
pub async fn reorder_items(state:State<'_,PersistenceState>,notebook_id:Option<String>,ids:Vec<String>)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.reorder_items(notebook_id.as_deref(),&ids)).await
}
#[tauri::command]
pub async fn delete_topic(state:State<'_,PersistenceState>,notebook_id:String,topic_id:String)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.delete_topic(&notebook_id,&topic_id)).await
}
#[tauri::command]
pub async fn delete_notebook(state:State<'_,PersistenceState>,notebook_id:String)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.delete_notebook(&notebook_id)).await
}
#[tauri::command]
pub async fn sync_status(state:State<'_,PersistenceState>,notebook_id:String)->Result<crate::storage::SyncStatus,String>{
    persistence::with_database(state.0.clone(),move|db|db.sync_status(&notebook_id)).await
}
#[tauri::command]
pub async fn sync_checkpoint(state:State<'_,PersistenceState>,notebook_id:String)->Result<crate::storage::SyncCheckpoint,String>{
    persistence::with_database(state.0.clone(),move|db|db.sync_checkpoint(&notebook_id)).await
}
#[tauri::command]
pub async fn outgoing_changes(state:State<'_,PersistenceState>,notebook_id:String,after:i64)->Result<Vec<crate::storage::OutgoingChange>,String>{
    persistence::with_database(state.0.clone(),move|db|db.outgoing_changes(&notebook_id,after)).await
}
#[tauri::command]
pub async fn acknowledge_changes(state:State<'_,PersistenceState>,notebook_id:String,sequence:i64)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.acknowledge_changes(&notebook_id,sequence)).await
}
#[tauri::command]
pub async fn sync_target(state:State<'_,PersistenceState>,notebook_id:String,server:String,enabled:bool)->Result<(),String>{
    persistence::with_database(state.0.clone(),move|db|db.sync_target(&notebook_id,&server,enabled)).await
}
