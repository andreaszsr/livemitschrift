import { invoke } from "@tauri-apps/api/core";
import type { Notebook, PageEdit, PdfBackground } from "@livemitschrift/core";
export interface Library {
    notebooks: {
        id: string;
        title: string;
    }[];
    preferences: Record<string, string>;
    syncTargets?: {notebookId:string;server:string}[];
}
export interface NotebookLoad {
    notebook: Notebook;
    secret: string;
}
export const loadLibrary = (): Promise<Library> => invoke("load_library");
export const loadNotebook = (notebookId: string): Promise<NotebookLoad> => invoke("load_notebook", { notebookId });
export const createNotebook = (title: string): Promise<string> => invoke("create_notebook", { title });
export const createTopic = (notebookId: string, title: string, backgrounds: (PdfBackground | null)[]): Promise<string> => invoke("create_topic", { notebookId, title, backgrounds });
export const insertBlankPage = (afterPageId: string): Promise<string> => invoke("insert_blank_page", { afterPageId });
export const editPage = (edit: PageEdit): Promise<void> => invoke("edit_page", { edit });
export const setPreference = (key: string, value: string): Promise<void> => invoke("set_preference", { key, value });

export const renameItem = (notebookId:string,itemId:string,title:string):Promise<void> => invoke('rename_item',{notebookId,itemId,title});
export const reorderItems = (notebookId:string|null,ids:string[]):Promise<void> => invoke('reorder_items',{notebookId,ids});
export const deleteTopic = (notebookId:string,topicId:string):Promise<void> => invoke('delete_topic',{notebookId,topicId});
export const deleteNotebook = (notebookId:string):Promise<void> => invoke('delete_notebook',{notebookId});
export const syncStatus = (notebookId:string):Promise<{sequence:number;head:string;firstPending:number|null}> => invoke('sync_status',{notebookId});
export const syncCheckpoint = (notebookId:string):Promise<{sequence:number;head:string;notebook:Notebook;pending:number}> => invoke('sync_checkpoint',{notebookId});
export const outgoingChanges = (notebookId:string,after:number):Promise<{sequence:number;head:string;change:unknown}[]> => invoke('outgoing_changes',{notebookId,after});
export const acknowledgeChanges = (notebookId:string,sequence:number):Promise<void> => invoke('acknowledge_changes',{notebookId,sequence});
export const syncTarget = (notebookId:string,server:string,enabled:boolean):Promise<void> => invoke('sync_target',{notebookId,server,enabled});
export const savePdfExport = (bytes:Uint8Array):Promise<boolean> => invoke('save_pdf_export',bytes);
export const backupNotebook = (notebookId:string):Promise<boolean> => invoke('backup_notebook',{notebookId});
export const restoreNotebook = (bytes:Uint8Array):Promise<string> => invoke('restore_notebook',bytes);

export const loadPublisherKey = (server:string,interactive=false):Promise<string|null> => invoke('load_publisher_key',{server,interactive});
export const savePublisherKey = (server:string,key:string):Promise<void> => invoke('save_publisher_key',{server,key});
export const forgetPublisherKey = (server:string):Promise<void> => invoke('forget_publisher_key',{server});
