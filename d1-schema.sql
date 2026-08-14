-- D1 schema for the "TG Reply Threads" feature.
-- Run this ONCE in the Cloudflare Dashboard: D1 Database > inr-ticket-threads > Console tab.
-- Paste the whole thing and click "Execute".

CREATE TABLE IF NOT EXISTS threads (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL   -- the full thread record as JSON (same shape KV used to store)
);

CREATE TABLE IF NOT EXISTS message_index (
  chat_id    TEXT    NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id  TEXT    NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_index_thread ON message_index(thread_id);
