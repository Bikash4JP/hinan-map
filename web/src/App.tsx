import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Locate, Navigation, ShieldAlert, X } from "lucide-react";
import {
  HAZARD_KEYS,
  LANGS,
  detectLang,
  saveLang,
  translations,
  type HazardFilter,
  type Lang,
} from "./i18n";

interface ShelterProperties {
  id: number;
  name: string;
  address: string;
  hazards: Record<string, boolean>;
  distance_m?: number;
}

interface ShelterFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: ShelterProperties;
}

// 練馬区役所 (Nerima City Office). Order is [lng, lat], the GeoJSON / MapLibre standard.
const NERIMA_CENTER: [number, number] = [139.6517, 35.7356];

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export default function App() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const bboxAbortRef = useRef<AbortController | null>(null);

  // ---- Language ----
  const [lang, setLang] = useState<Lang>(detectLang);
  // Map handlers are registered once, so they read the current language from a ref
  // (same reason as hazardRef below).
  const langRef = useRef<Lang>(lang);
  const t = translations[lang];

  const [selectedHazard, setSelectedHazard] = useState<HazardFilter>("all");
  const hazardRef = useRef<HazardFilter>("all");

  const [selectedLocation, setSelectedLocation] = useState<[number, number] | null>(null);
  const [nearestShelters, setNearestShelters] = useState<ShelterFeature[]>([]);
  const [selectedShelterId, setSelectedShelterId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isZoomedOut, setIsZoomedOut] = useState(false);

  const hazardQuery = () => (hazardRef.current !== "all" ? `&hazard=${hazardRef.current}` : "");

  // Only one popup at a time
  const openPopup = useCallback((coords: [number, number], html: string) => {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ offset: 12 }).setLngLat(coords).setHTML(html).addTo(map);
  }, []);

  // ---- Load shelters inside the current map view (bbox) ----
  const fetchBboxShelters = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    // If zoomed out too far, don't fetch heavy global points
    if (map.getZoom() < 8) {
      setIsZoomedOut(true);
      (map.getSource("shelters") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
      return;
    }
    setIsZoomedOut(false);

    const b = map.getBounds();
    const url = `/api/shelters?bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}${hazardQuery()}&limit=2000`;

    // Cancel the previous request so an old (slow) response can't overwrite a newer one.
    bboxAbortRef.current?.abort();
    const controller = new AbortController();
    bboxAbortRef.current = controller;

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json();
      (map.getSource("shelters") as maplibregl.GeoJSONSource | undefined)?.setData(data);
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.error("bbox fetch failed:", err);
    }
  }, []);

  // ---- KNN: 5 nearest shelters to a point ----
  const fetchNearestShelters = useCallback(async (coords: [number, number]) => {
    setIsLoading(true);
    const url = `/api/shelters/nearest?lng=${coords[0]}&lat=${coords[1]}${hazardQuery()}&limit=5`;

    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const features: ShelterFeature[] = data.features ?? [];
      setNearestShelters(features);

      // Straight dashed line from the clicked point to the #1 nearest shelter
      const lineSource = mapRef.current?.getSource("nearest-line") as
        | maplibregl.GeoJSONSource
        | undefined;
      lineSource?.setData(
        features.length > 0
          ? {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: {
                    type: "LineString",
                    coordinates: [coords, features[0].geometry.coordinates],
                  },
                  properties: {},
                },
              ],
            }
          : EMPTY_FC
      );
    } catch (err) {
      console.error("nearest fetch failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ---- Initialise the map once ----
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        // Font files are needed to draw text (the cluster counts) in a symbol layer
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          "gsi-pale": {
            type: "raster",
            tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
            tileSize: 256,
            minzoom: 2,
            maxzoom: 18,
            attribution:
              '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>',
          },
        },
        layers: [{ id: "gsi-pale-layer", type: "raster", source: "gsi-pale" }],
      },
      center: NERIMA_CENTER,
      zoom: 13.5,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      // Clustered GeoJSON source: MapLibre groups nearby points on the client
      map.addSource("shelters", {
        type: "geojson",
        data: EMPTY_FC,
        cluster: true,
        clusterMaxZoom: 14, // above zoom 14, show individual points
        clusterRadius: 50, // pixels
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "shelters",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#38bdf8", 20, "#f59e0b", 100, "#ef4444"],
          "circle-radius": ["step", ["get", "point_count"], 18, 20, 24, 100, 30],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "shelters",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Open Sans Semibold"],
          "text-size": 13,
        },
        paint: { "text-color": "#ffffff" },
      });

      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: "shelters",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#0284c7",
          "circle-radius": 7,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.addSource("nearest-line", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "nearest-line-layer",
        type: "line",
        source: "nearest-line",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#f43f5e", "line-width": 4, "line-dasharray": [2, 2] },
      });

      // Click a cluster -> zoom in until it splits
      map.on("click", "clusters", async (e) => {
        const feature = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
        if (!feature) return;
        const source = map.getSource("shelters") as maplibregl.GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(feature.properties?.cluster_id);
        map.easeTo({ center: (feature.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      });

      // Click a single shelter -> popup in the *current* language
      map.on("click", "unclustered-point", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const coords = (feature.geometry as GeoJSON.Point).coordinates.slice() as [number, number];
        const props = feature.properties as ShelterProperties;
        // MapLibre turns nested objects in feature properties into JSON strings
        const hazards = typeof props.hazards === "string" ? JSON.parse(props.hazards) : props.hazards;
        openPopup(coords, createPopupHTML(langRef.current, props.name, props.address, hazards));
      });

      for (const layer of ["clusters", "unclustered-point"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }

      // Click empty map -> use that point for the nearest-shelter search
      map.on("click", (e) => {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["clusters", "unclustered-point"] });
        if (hit.length > 0) return;
        setSelectedLocation([e.lngLat.lng, e.lngLat.lat]);
      });

      fetchBboxShelters();
    });

    // Reload the shelters every time the user stops panning / zooming
    map.on("moveend", fetchBboxShelters);

    mapRef.current = map;

    return () => {
      bboxAbortRef.current?.abort();
      map.remove();
      // Reset refs so React StrictMode's second mount creates a fresh map
      mapRef.current = null;
      userMarkerRef.current = null;
      popupRef.current = null;
    };
  }, [fetchBboxShelters, openPopup]);

  // ---- Language changed -> remember it, update <html lang>, close stale popup ----
  useEffect(() => {
    langRef.current = lang;
    saveLang(lang);
    // Screen readers use this to pick the right pronunciation
    document.documentElement.lang = lang;
    // An open popup was rendered in the old language; close it instead of showing mixed text
    popupRef.current?.remove();
    popupRef.current = null;
  }, [lang]);

  // ---- Hazard filter changed -> reload both layers ----
  useEffect(() => {
    hazardRef.current = selectedHazard;
    fetchBboxShelters();
    if (selectedLocation) fetchNearestShelters(selectedLocation);
    // selectedLocation deliberately omitted: the effect below handles location changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHazard]);

  // ---- Location chosen (map click or 現在地) -> marker + nearest search ----
  useEffect(() => {
    const map = mapRef.current;
    if (!selectedLocation || !map) return;

    if (userMarkerRef.current) {
      userMarkerRef.current.setLngLat(selectedLocation);
    } else {
      const el = document.createElement("div");
      el.className = "user-location-pin";
      userMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat(selectedLocation).addTo(map);
    }

    fetchNearestShelters(selectedLocation);
  }, [selectedLocation, fetchNearestShelters]);

  // ---- 現在地 button: browser Geolocation API ----
  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert(t.geoUnsupported);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        setSelectedLocation(coords);
        mapRef.current?.flyTo({ center: coords, zoom: 14.5 });
      },
      (err) => alert(`${t.geoFailed}: ${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSelectShelter = (s: ShelterFeature) => {
    setSelectedShelterId(s.properties.id);
    mapRef.current?.flyTo({ center: s.geometry.coordinates, zoom: 16 });
    openPopup(
      s.geometry.coordinates,
      createPopupHTML(lang, s.properties.name, s.properties.address, s.properties.hazards, s.properties.distance_m)
    );
  };

  const clearSelection = () => {
    setSelectedLocation(null);
    setNearestShelters([]);
    setSelectedShelterId(null);
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    (mapRef.current?.getSource("nearest-line") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
  };

  return (
    <div className="app">
      <div ref={mapContainer} className="map-container" />

      <header className="header-bar glass-panel">
        <div className="brand">
          <div className="brand-icon">
            <ShieldAlert size={20} />
          </div>
          <div>
            <h1 className="brand-title">Hinan Map</h1>
            <p className="brand-subtitle">{t.appSubtitle}</p>
          </div>
        </div>

        <div className="header-actions">
          <div className="lang-switch" role="group" aria-label={t.language}>
            {LANGS.map((l) => (
              <button
                key={l.code}
                id={`lang-${l.code}`}
                lang={l.code}
                className={`lang-btn ${lang === l.code ? "active" : ""}`}
                aria-pressed={lang === l.code}
                onClick={() => setLang(l.code)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <button id="btn-current-location" className="btn btn-primary" onClick={handleGetCurrentLocation}>
            <Locate size={16} />
            <span className="btn-label">{t.currentLocation}</span>
          </button>
        </div>
      </header>

      {/* Zoom Hint Banner when zoomed out */}
      {isZoomedOut && (
        <div className="zoom-hint-banner glass-panel">
          <span>{t.zoomHint}</span>
        </div>
      )}

      <nav className="filter-bar glass-panel" aria-label={t.hazardFilterLabel}>
        <button
          id="hazard-all"
          className={`hazard-chip ${selectedHazard === "all" ? "active" : ""}`}
          onClick={() => setSelectedHazard("all")}
        >
          {t.all}
        </button>
        {HAZARD_KEYS.map((key) => (
          <button
            key={key}
            id={`hazard-${key}`}
            className={`hazard-chip ${selectedHazard === key ? "active" : ""}`}
            onClick={() => setSelectedHazard(key)}
          >
            {t.hazards[key]}
          </button>
        ))}
      </nav>

      {selectedLocation && (
        <aside className="sidebar glass-panel">
          <div className="sidebar-header">
            <div className="sidebar-title-row">
              <Navigation size={18} color="#f43f5e" />
              <h2 className="sidebar-title">{t.nearestTitle}</h2>
            </div>
            <button id="btn-close-sidebar" className="btn btn-icon" onClick={clearSelection} aria-label={t.close}>
              <X size={16} />
            </button>
          </div>

          <div className="sidebar-list">
            {isLoading ? (
              <p className="sidebar-message">{t.searching}</p>
            ) : nearestShelters.length === 0 ? (
              <p className="sidebar-message">{t.noResults}</p>
            ) : (
              nearestShelters.map((s, idx) => (
                <div
                  key={s.properties.id}
                  className={`shelter-card ${selectedShelterId === s.properties.id ? "selected" : ""}`}
                  onClick={() => handleSelectShelter(s)}
                >
                  <div className="shelter-card-header">
                    {/* Shelter names stay in Japanese, matching local signs */}
                    <span className="shelter-name" lang="ja">
                      {idx + 1}. {s.properties.name}
                    </span>
                    <span className="distance-badge">{formatDistance(s.properties.distance_m)}</span>
                  </div>
                  <p className="shelter-address" lang="ja">
                    {s.properties.address}
                  </p>
                  <div className="badges-row">
                    {HAZARD_KEYS.filter((k) => s.properties.hazards[k]).map((k) => (
                      <span key={k} className="badge badge-yes">
                        {t.hazards[k]}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          <p className="sidebar-note">{t.straightLineNote}</p>
        </aside>
      )}

      {/* Required credit stays in Japanese; the dataset name is translated */}
      <footer className="attribution-credit">
        <span lang="ja">出典：</span>
        <a href="https://www.gsi.go.jp/bousaichiri/hinanbasho.html" target="_blank" rel="noopener noreferrer" lang="ja">
          国土地理院
        </a>
        （{t.datasetName}）
      </footer>
    </div>
  );
}

function formatDistance(meters?: number) {
  if (meters === undefined) return "";
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

// setHTML() inserts raw HTML, so data from the CSV must be escaped first
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function createPopupHTML(
  lang: Lang,
  name: string,
  address: string,
  hazards: Record<string, boolean>,
  distance_m?: number
) {
  const t = translations[lang];
  const badges = HAZARD_KEYS.map(
    (k) => `<span class="badge ${hazards[k] ? "badge-yes" : "badge-no"}">${t.hazards[k]}</span>`
  ).join("");

  const dist =
    distance_m !== undefined
      ? `<div class="popup-distance">${t.straightLineDistance} ${formatDistance(distance_m)}</div>`
      : "";

  return `
    <div class="popup" lang="${lang}">
      <h3 class="popup-title" lang="ja">${escapeHtml(name)}</h3>
      ${dist}
      <p class="popup-address" lang="ja">${escapeHtml(address ?? "")}</p>
      <div class="badges-row">${badges}</div>
    </div>`;
}
