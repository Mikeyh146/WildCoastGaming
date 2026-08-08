-- Wild Coast Gaming — booking system schema
-- Run this once against your D1 database (see SETUP.md)

DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS services;

-- The 4 bookable table types. allowed_sizes controls which physical table
-- pool (large / small) a service can draw from — 'large', 'small', or 'both'.
CREATE TABLE services (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  min_people INTEGER NOT NULL,
  max_people INTEGER NOT NULL,
  needs_points INTEGER NOT NULL DEFAULT 0,
  allowed_sizes TEXT NOT NULL
);

INSERT INTO services (key, name, min_people, max_people, needs_points, allowed_sizes) VALUES
  ('warhammer', 'Warhammer Table',        1, 2, 1, 'large'),
  ('tcg',       'Trading Card Games',     1, 8, 0, 'small'),
  ('casual',    'Casual Table',           1, 8, 0, 'small'),
  ('dnd',       'D&D / RPG Table',        1, 12, 0, 'both');

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  service_key TEXT NOT NULL REFERENCES services(key),
  table_size TEXT NOT NULL,              -- 'large' or 'small' — which pool this booking used
  date TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  start_time TEXT NOT NULL,              -- 'HH:MM' 24hr
  duration_hours REAL NOT NULL,
  end_time TEXT NOT NULL,                -- 'HH:MM' 24hr, derived
  party_size INTEGER NOT NULL,
  points_total TEXT,                     -- e.g. '2000' — only for Warhammer
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  price_pp REAL NOT NULL,
  price_total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed / cancelled / arrived
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bookings_date ON bookings(date);
CREATE INDEX idx_bookings_reference ON bookings(reference);
