import { parse } from "csv-parse";
import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

const GSI_CSV_URL =
  process.env.GSI_CSV_URL ||
  "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/mergeFromCity_2.csv";

const BATCH_SIZE = 1000;

interface ShelterRow {
  kyotsuId: string;
  name: string;
  address: string;
  hazards: {
    flood: boolean;
    landslide: boolean;
    storm_surge: boolean;
    earthquake: boolean;
    tsunami: boolean;
    fire: boolean;
    inland_flood: boolean;
    volcano: boolean;
  };
  lat: number;
  lng: number;
}

async function runImport() {
  console.log("--------------------------------------------------");
  console.log("Hinan Map - Step 2: PostGIS Shelter Import Script");
  console.log("--------------------------------------------------");
  console.log(`Fetching CSV dataset from: ${GSI_CSV_URL}`);

  const client = new Client({
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "postgres",
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "54320", 10),
    database: process.env.POSTGRES_DB || "hinan_map",
  });

  await client.connect();
  console.log("Connected to PostGIS database successfully.");

  const response = await fetch(GSI_CSV_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download GSI CSV: ${response.statusText}`);
  }

  // Convert web stream to Node readable stream
  const reader = response.body.getReader();
  const nodeStream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.close();
    },
  });

  // Convert Web ReadableStream to Node stream for csv-parse
  const parser = parse({
    bom: true, // Handle UTF-8 with BOM automatically
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  let totalProcessed = 0;
  let totalInserted = 0;
  let batch: ShelterRow[] = [];

  const flushBatch = async (rows: ShelterRow[]) => {
    if (rows.length === 0) return;

    const kyotsuIds: string[] = [];
    const names: string[] = [];
    const addresses: string[] = [];
    const hazardsList: string[] = [];
    const lngs: number[] = [];
    const lats: number[] = [];

    for (const r of rows) {
      kyotsuIds.push(r.kyotsuId);
      names.push(r.name);
      addresses.push(r.address);
      hazardsList.push(JSON.stringify(r.hazards));
      lngs.push(r.lng);
      lats.push(r.lat);
    }

    const query = `
      INSERT INTO shelters (kyotsu_id, name, address, hazards, geom)
      SELECT 
        val.kyotsu_id,
        val.name,
        val.address,
        val.hazards::jsonb,
        ST_SetSRID(ST_MakePoint(val.lng, val.lat), 4326)::geography
      FROM UNNEST($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::float8[], $6::float8[]) 
        AS val(kyotsu_id, name, address, hazards, lng, lat)
      ON CONFLICT (kyotsu_id) DO UPDATE SET
        name = EXCLUDED.name,
        address = EXCLUDED.address,
        hazards = EXCLUDED.hazards,
        geom = EXCLUDED.geom;
    `;

    await client.query(query, [
      kyotsuIds,
      names,
      addresses,
      hazardsList,
      lngs,
      lats,
    ]);

    totalInserted += rows.length;
  };

  // Process stream
  const nodeReadable = (async function* () {
    const r = nodeStream.getReader();
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      yield value;
    }
  })();

  for await (const chunk of nodeReadable) {
    parser.write(chunk);
  }
  parser.end();

  console.log("Parsing CSV and importing into PostGIS...");

  for await (const record of parser) {
    totalProcessed++;

    const lat = parseFloat(record["緯度"]);
    const lng = parseFloat(record["経度"]);

    // Skip invalid coordinates
    if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) {
      continue;
    }

    const kyotsuId = record["共通ID"] || `SYS_${totalProcessed}`;
    const name = record["施設・場所名"] || "名称不明";

    // Combine prefecture/municipality name + address if address is partial
    const prefCity = record["都道府県名及び市町村名"] || "";
    const rawAddress = record["住所"] || "";
    const address = rawAddress.startsWith(prefCity)
      ? rawAddress
      : `${prefCity}${rawAddress}`;

    const hazards = {
      flood: record["洪水"] === "1",
      landslide: record["崖崩れ、土石流及び地滑り"] === "1",
      storm_surge: record["高潮"] === "1",
      earthquake: record["地震"] === "1",
      tsunami: record["津波"] === "1",
      fire: record["大規模な火事"] === "1",
      inland_flood: record["内水氾濫"] === "1",
      volcano: record["火山現象"] === "1",
    };

    batch.push({ kyotsuId, name, address, hazards, lat, lng });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(batch);
      batch = [];
      process.stdout.write(
        `\rProcessed: ${totalProcessed} rows | Imported: ${totalInserted} shelters`
      );
    }
  }

  if (batch.length > 0) {
    await flushBatch(batch);
    batch = [];
  }

  console.log(
    `\nSuccess! Total CSV rows processed: ${totalProcessed}, Total shelters in PostGIS: ${totalInserted}`
  );

  const countRes = await client.query("SELECT COUNT(*) FROM shelters");
  console.log(`Database shelters count query result: ${countRes.rows[0].count}`);

  await client.end();
}

runImport().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
