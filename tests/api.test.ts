import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
import app from "../src/index.js";

// Three fixture sites in the open Pacific, over 900 km from the nearest real shelter.
// The tests query only this area, so they give the same result on an empty database (CI)
// and on a database that holds the full GSI import (local development).
const ORIGIN = { lng: 150, lat: 32 };
const FIXTURES = [
  { id: "TEST_1", name: "テスト避難場所1", lng: 150.001, hazards: { flood: true, tsunami: false } },
  { id: "TEST_2", name: "テスト避難場所2", lng: 150.002, hazards: { flood: false, tsunami: true } },
  { id: "TEST_3", name: "テスト避難場所3", lng: 150.003, hazards: { flood: true, tsunami: true } },
];
const BBOX = "149.99,31.99,150.01,32.01";

const names = (data: any): string[] => data.features.map((f: any) => f.properties.name);

beforeAll(async () => {
  for (const f of FIXTURES) {
    await pool.query(
      `INSERT INTO shelters (kyotsu_id, name, address, hazards, geom)
       VALUES ($1, $2, 'テスト住所', $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)
       ON CONFLICT (kyotsu_id) DO UPDATE SET hazards = EXCLUDED.hazards, geom = EXCLUDED.geom`,
      [f.id, f.name, JSON.stringify(f.hazards), f.lng, ORIGIN.lat]
    );
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM shelters WHERE kyotsu_id = ANY($1)", [FIXTURES.map((f) => f.id)]);
  await pool.end();
});

describe("GET /api/health", () => {
  it("reports the database connection", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", database: "connected" });
  });
});

describe("GET /api/shelters (bounding box)", () => {
  it("returns the sites inside the box as a GeoJSON FeatureCollection", async () => {
    const res = await app.request(`/api/shelters?bbox=${BBOX}`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.type).toBe("FeatureCollection");
    expect(data.attribution).toContain("国土地理院");
    expect(names(data).sort()).toEqual(FIXTURES.map((f) => f.name));
    expect(data.features[0]).toMatchObject({ type: "Feature", geometry: { type: "Point" } });
    expect(data.features[0].properties).toHaveProperty("hazards");
  });

  it("filters by hazard type", async () => {
    const res = await app.request(`/api/shelters?bbox=${BBOX}&hazard=tsunami`);
    expect(names(await res.json()).sort()).toEqual(["テスト避難場所2", "テスト避難場所3"]);
  });

  it("excludes sites outside the box", async () => {
    const res = await app.request("/api/shelters?bbox=149.99,31.99,150.0015,32.01");
    expect(names(await res.json())).toEqual(["テスト避難場所1"]);
  });

  it("rejects a malformed bbox with 400", async () => {
    const res = await app.request("/api/shelters?bbox=invalid,bbox,format,here");
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error", "Invalid query parameters");
  });

  it("rejects an unknown hazard type with 400", async () => {
    const res = await app.request(`/api/shelters?bbox=${BBOX}&hazard=meteor`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/shelters/nearest (k-NN)", () => {
  it("returns the nearest sites in order, with distances in metres", async () => {
    const res = await app.request(`/api/shelters/nearest?lng=${ORIGIN.lng}&lat=${ORIGIN.lat}&limit=3`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(names(data)).toEqual(FIXTURES.map((f) => f.name));

    // 0.001° of longitude at 32°N is about 94.5 m. A result near 0.001 would mean degrees, not metres.
    const distances = data.features.map((f: any) => f.properties.distance_m);
    expect(distances[0]).toBeGreaterThan(93);
    expect(distances[0]).toBeLessThan(96);
    expect(distances[1]).toBeCloseTo(distances[0] * 2, 0);
    expect(distances[2]).toBeCloseTo(distances[0] * 3, 0);
  });

  it("skips nearer sites that are not designated for the requested hazard", async () => {
    const res = await app.request(
      `/api/shelters/nearest?lng=${ORIGIN.lng}&lat=${ORIGIN.lat}&hazard=tsunami&limit=1`
    );
    expect(names(await res.json())).toEqual(["テスト避難場所2"]);
  });

  it("rejects out-of-range coordinates with 400", async () => {
    const res = await app.request("/api/shelters/nearest?lng=999&lat=35.7356");
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error", "Invalid coordinates or parameters");
  });
});
