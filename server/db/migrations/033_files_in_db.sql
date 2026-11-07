-- 033_files_in_db.sql — Ticket photos and invoice files are kept in PostgreSQL (decided 7 Nov 2026). Idempotent.
-- New uploads go into `data` (bytea) in the same transaction as the row: no folder, no file permissions.
-- Rows uploaded before this have data = NULL until `node ../sync/import-files-to-db.js --commit` copies
-- them in from ATTACHMENT_DIR; until then they are still read from that folder.
-- Photos are WebP ≤ ~300 KB; invoices ≤ 10 MB. Lists never select `data`.
ALTER TABLE request_attachments ADD COLUMN IF NOT EXISTS data bytea;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS data bytea;
-- Keep the big values out of line (TOAST) without trying to compress already-compressed images / PDFs.
ALTER TABLE request_attachments ALTER COLUMN data SET STORAGE EXTERNAL;
ALTER TABLE invoices ALTER COLUMN data SET STORAGE EXTERNAL;
