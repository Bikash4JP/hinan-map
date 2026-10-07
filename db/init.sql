-- Enable PostGIS spatial extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Create shelters table for Japanese evacuation sites (指定緊急避難場所)
CREATE TABLE IF NOT EXISTS shelters (
  id SERIAL PRIMARY KEY,
  kyotsu_id VARCHAR(50) UNIQUE,
  name VARCHAR(255) NOT NULL,
  address VARCHAR(500),
  hazards JSONB NOT NULL DEFAULT '{}',
  geom GEOGRAPHY(Point, 4326) NOT NULL
);

-- Spatial Index using GiST (Generalized Search Tree) for high-performance spatial queries
CREATE INDEX IF NOT EXISTS idx_shelters_geom ON shelters USING GIST (geom);
