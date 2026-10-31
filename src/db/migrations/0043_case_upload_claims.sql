-- What an uploaded file claimed to be (D02 T04 §4): its own file name and the media type the member's browser submitted,
-- kept apart from the type its bytes were detected as, so the type-mismatch check can compare them. Null on an email
-- case, and on an upload stored before this, or one sent without either.
ALTER TABLE cases ADD COLUMN upload_name TEXT CHECK (upload_name IS NULL OR length(upload_name) BETWEEN 1 AND 255);
ALTER TABLE cases ADD COLUMN upload_media_type TEXT CHECK (upload_media_type IS NULL OR length(upload_media_type) BETWEEN 1 AND 255);
