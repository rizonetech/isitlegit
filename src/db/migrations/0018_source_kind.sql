-- What a case was made from (D01 T01 §3, D01 T03 §1): `mail` (a forward, or an uploaded .eml or .msg), `document` (a
-- PDF), `image` (PNG, JPEG, WebP) or `audio` (a voice note). The Workflow's parse step branches on it, and every case
-- made before this column existed came by email, so it is `mail`.
ALTER TABLE cases ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'mail' CHECK (source_kind IN ('mail', 'document', 'image', 'audio'));
