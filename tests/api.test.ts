import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index.js";

describe("Hinan Map PostGIS API Tests", () => {
  it("GET /api/health should return 200 OK and database status", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("database", "connected");
  });

  it("GET /api/shelters with bbox should return a valid GeoJSON FeatureCollection", async () => {
    const res = await app.request(
      "/api/shelters?bbox=139.6,35.7,139.7,35.8&hazard=flood&limit=5"
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.type).toBe("FeatureCollection");
    expect(data.attribution).toContain("国土地理院");
    expect(Array.isArray(data.features)).toBe(true);

    if (data.features.length > 0) {
      const feature = data.features[0];
      expect(feature.type).toBe("Feature");
      expect(feature.geometry.type).toBe("Point");
      expect(feature.properties).toHaveProperty("id");
      expect(feature.properties).toHaveProperty("name");
      expect(feature.properties).toHaveProperty("hazards");
    }
  });

  it("GET /api/shelters with invalid bbox should return 400 Bad Request", async () => {
    const res = await app.request("/api/shelters?bbox=invalid,bbox,format,here");
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error", "Invalid query parameters");
  });

  it("GET /api/shelters/nearest should return nearest shelters sorted by distance_m", async () => {
    const res = await app.request(
      "/api/shelters/nearest?lng=139.6517&lat=35.7356&limit=3"
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.type).toBe("FeatureCollection");
    expect(data.features.length).toBeGreaterThan(0);

    const distances = data.features.map((f: any) => f.properties.distance_m);
    expect(distances[0]).toBeLessThanOrEqual(distances[1]);
    expect(distances[1]).toBeLessThanOrEqual(distances[2]);
  });

  it("GET /api/shelters/nearest with out-of-range coordinates should return 400 Bad Request", async () => {
    const res = await app.request("/api/shelters/nearest?lng=999&lat=35.7356");
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error", "Invalid coordinates or parameters");
  });
});
