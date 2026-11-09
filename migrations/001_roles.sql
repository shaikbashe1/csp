CREATE TABLE roles (
  name        text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO roles (name, description) VALUES
  ('citizen',      'Community member: own assessments and profile'),
  ('field_worker', 'Field worker: assigned villages, surveys, assessments'),
  ('researcher',   'Researcher: aggregate analytics and exports'),
  ('admin',        'Administrator: full system management');
