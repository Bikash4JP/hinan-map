import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { pool } from "./db.js";

const app = new Hono();

// Enable CORS for frontend integration
app.use("*", cors());

// Allowed hazard flag keys
const HAZARD_KEYS = [
  "flood",
  "landslide",
  "storm_surge",
  "earthquake",
  "tsunami",
  "fire",
  "inland_flood",
  "volcano",
] as const;

// 1. Health Check Endpoint
app.get("/api/health", async (c) => {
  try {
    const dbRes = await pool.query("SELECT NOW()");
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: "connected",
      dbTime: dbRes.rows[0].now,
    });
  } catch (err: any) {
    return c.json(
      { status: "error", message: "Database connection failed", error: err.message },
      500
    );
  }
});

// Zod Schema for Bounding Box Query Validation
const sheltersQuerySchema = z.object({
  bbox: z.string().refine((val) => {
    const parts = val.split(",").map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return false;
    const [minLng, minLat, maxLng, maxLat] = parts;
    return (
      minLng >= -180 &&
      maxLng <= 180 &&
      minLat >= -90 &&
      maxLat <= 90 &&
      minLng <= maxLng &&
      minLat <= maxLat
    );
  }, "bbox must be 'minLng,minLat,maxLng,maxLat' within valid coordinates (-180..180, -90..90)"),
  hazard: z.enum(HAZARD_KEYS).optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1000))
    .pipe(z.number().min(1).max(3000)),
});

// 2. Bounding Box Shelters Query Endpoint
app.get("/api/shelters", async (c) => {
  const parseResult = sheltersQuerySchema.safeParse(c.req.query());
  if (!parseResult.success) {
    return c.json(
      {
        error: "Invalid query parameters",
        details: parseResult.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { bbox, hazard, limit } = parseResult.data;
  const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);

  try {
    const query = `
      SELECT 
        id,
        name,
        address,
        hazards,
        ST_AsGeoJSON(geom)::json AS geometry
      FROM shelters
      WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography)
        AND ($5::text IS NULL OR (hazards->$5)::boolean = true)
      LIMIT $6;
    `;

    const result = await pool.query(query, [
      minLng,
      minLat,
      maxLng,
      maxLat,
      hazard || null,
      limit,
    ]);

    const features = result.rows.map((row) => ({
      type: "Feature",
      geometry: row.geometry,
      properties: {
        id: row.id,
        name: row.name,
        address: row.address,
        hazards: row.hazards,
      },
    }));

    return c.json({
      type: "FeatureCollection",
      attribution: "出典：国土地理院 指定緊急避難場所データ",
      features,
    });
  } catch (err: any) {
    console.error("Error executing bbox shelters query:", err);
    return c.json({ error: "Failed to fetch shelters", details: err.message }, 500);
  }
});

// Zod Schema for Nearest Shelters Query Validation
const nearestQuerySchema = z.object({
  lng: z
    .string()
    .transform(Number)
    .pipe(z.number().min(-180).max(180)),
  lat: z
    .string()
    .transform(Number)
    .pipe(z.number().min(-90).max(90)),
  hazard: z.enum(HAZARD_KEYS).optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 5))
    .pipe(z.number().min(1).max(50)),
});

// 3. Nearest Shelters Query Endpoint (KNN <-> operator + ST_Distance)
app.get("/api/shelters/nearest", async (c) => {
  const parseResult = nearestQuerySchema.safeParse(c.req.query());
  if (!parseResult.success) {
    return c.json(
      {
        error: "Invalid coordinates or parameters",
        details: parseResult.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { lng, lat, hazard, limit } = parseResult.data;

  try {
    const query = `
      SELECT 
        id,
        name,
        address,
        hazards,
        ST_AsGeoJSON(geom)::json AS geometry,
        ROUND(ST_Distance(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)::numeric, 1) AS distance_m
      FROM shelters
      WHERE ($3::text IS NULL OR (hazards->$3)::boolean = true)
      ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      LIMIT $4;
    `;

    const result = await pool.query(query, [lng, lat, hazard || null, limit]);

    const features = result.rows.map((row) => ({
      type: "Feature",
      geometry: row.geometry,
      properties: {
        id: row.id,
        name: row.name,
        address: row.address,
        hazards: row.hazards,
        distance_m: parseFloat(row.distance_m),
      },
    }));

    return c.json({
      type: "FeatureCollection",
      attribution: "出典：国土地理院 指定緊急避難場所データ",
      features,
    });
  } catch (err: any) {
    console.error("Error executing nearest shelters query:", err);
    return c.json({ error: "Failed to fetch nearest shelters", details: err.message }, 500);
  }
});

const port = parseInt(process.env.PORT || "3000", 10);

if (process.env.NODE_ENV !== "test") {
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Hono API listening on http://localhost:${info.port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Stop the other process, or run with a different PORT (e.g. PORT=3001).`
      );
      process.exit(1);
    }
    throw err;
  });
}

export default app;
