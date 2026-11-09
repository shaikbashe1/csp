CREATE TABLE users (
  id                bigserial PRIMARY KEY,
  uuid              uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  full_name         text NOT NULL,
  email             text NOT NULL,
  password_hash     text NOT NULL,
  phone             text,
  state             text NOT NULL,
  district          text NOT NULL,
  village_id        integer REFERENCES villages(id) ON DELETE SET NULL,
  role              text NOT NULL DEFAULT 'citizen' REFERENCES roles(name),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  email_verified    boolean NOT NULL DEFAULT false,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_login        timestamptz
);
-- case-insensitive UNIQUE email
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_role_idx ON users (role);
CREATE INDEX users_status_idx ON users (status);
