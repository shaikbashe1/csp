CREATE TABLE villages (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  district   text NOT NULL,
  state      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX villages_unique_idx ON villages (lower(name), lower(district), lower(state));
