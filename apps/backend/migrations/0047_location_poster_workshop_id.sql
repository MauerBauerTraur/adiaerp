-- Track which Poster workshop (цех) each ERP production location corresponds to.
-- Used to sync production_location_id on products when importing from Poster.
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS poster_workshop_id integer;

CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_poster_workshop
  ON locations (poster_workshop_id)
  WHERE poster_workshop_id IS NOT NULL;
