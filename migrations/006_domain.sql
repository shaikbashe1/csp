CREATE TABLE facilities (
  id         serial PRIMARY KEY,
  uuid       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('phc','chc','hospital','sub_centre','pharmacy','clinic')),
  village_id integer REFERENCES villages(id) ON DELETE SET NULL,
  district   text NOT NULL,
  state      text NOT NULL,
  latitude   numeric(9,6),
  longitude  numeric(9,6),
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE healthcare_assessments (
  id         bigserial PRIMARY KEY,
  uuid       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  village_id integer REFERENCES villages(id) ON DELETE SET NULL,
  answers    jsonb NOT NULL,
  gap_score  smallint NOT NULL CHECK (gap_score BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX healthcare_user_idx ON healthcare_assessments (user_id, created_at DESC);
CREATE TABLE antibiotic_assessments (
  id         bigserial PRIMARY KEY,
  uuid       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  village_id integer REFERENCES villages(id) ON DELETE SET NULL,
  answers    jsonb NOT NULL,
  risk_score smallint NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_level text NOT NULL CHECK (risk_level IN ('Low','Moderate','High')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX antibiotic_user_idx ON antibiotic_assessments (user_id, created_at DESC);
CREATE TABLE community_surveys (
  id         bigserial PRIMARY KEY,
  uuid       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  village_id integer NOT NULL REFERENCES villages(id) ON DELETE CASCADE,
  worker_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  households integer NOT NULL CHECK (households >= 0),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE worker_villages (
  user_id    bigint  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  village_id integer NOT NULL REFERENCES villages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, village_id)
);
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES ('public_registration_enabled', 'true'::jsonb);
