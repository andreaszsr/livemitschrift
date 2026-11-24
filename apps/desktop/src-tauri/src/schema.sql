CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,secret TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,sync_head TEXT NOT NULL DEFAULT '');
CREATE TABLE topics(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),title TEXT NOT NULL,position INTEGER NOT NULL,UNIQUE(document_id,position));
CREATE TABLE pages(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),width REAL NOT NULL CHECK(width>0),height REAL NOT NULL CHECK(height>0),background TEXT,topic_id TEXT NOT NULL REFERENCES topics(id),title TEXT NOT NULL DEFAULT 'Seite 1',position INTEGER NOT NULL DEFAULT 0,next_order INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX page_order ON pages(topic_id,position);
CREATE TABLE strokes(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),position INTEGER NOT NULL CHECK(position>=0),data TEXT NOT NULL,UNIQUE(page_id,position));
CREATE TABLE preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE applied_edits(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES pages(id),digest TEXT NOT NULL);
CREATE TABLE outbox(document_id TEXT NOT NULL REFERENCES documents(id),sequence INTEGER NOT NULL,payload TEXT NOT NULL,head TEXT NOT NULL,PRIMARY KEY(document_id,sequence));
CREATE TABLE sync_targets(document_id TEXT NOT NULL REFERENCES documents(id),server TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(document_id));
