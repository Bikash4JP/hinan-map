// ------------------------------------------------------------
// i18n: UI text and hazard labels in 日本語 / English
// Shelter names and addresses are NOT translated: they come
// from the GSI data, and people need the real Japanese name to
// read local signs and ask for directions.
// ------------------------------------------------------------

// Keys match the JSONB keys written by the import script (Step 2)
// and accepted by the API (Step 3).
export const HAZARD_KEYS = [
  "earthquake",
  "flood",
  "tsunami",
  "landslide",
  "fire",
  "inland_flood",
  "storm_surge",
  "volcano",
] as const;

export type HazardKey = (typeof HAZARD_KEYS)[number];
export type HazardFilter = HazardKey | "all";

export const LANGS = [
  { code: "ja", label: "日本語" },
  { code: "en", label: "EN" },
] as const;

export type Lang = (typeof LANGS)[number]["code"];

// Japanese is the base dictionary. Its shape becomes the `Dict` type,
// so the other languages must have exactly the same keys.
const ja = {
  appSubtitle: "指定緊急避難場所マップ",
  currentLocation: "現在地",
  language: "言語",
  hazardFilterLabel: "災害の種類",
  all: "すべて",
  nearestTitle: "近くの避難場所",
  searching: "検索中…",
  noResults: "該当する避難場所が見つかりません。",
  zoomHint: "詳細な避難場所を表示するには地図を拡大してください。",
  straightLineDistance: "直線距離",
  straightLineNote: "※ 直線距離です。実際の道のりとは異なります。",
  close: "閉じる",
  geoUnsupported: "このブラウザは位置情報に対応していません。",
  geoFailed: "現在地を取得できませんでした",
  datasetName: "指定緊急避難場所データ",
  // Official names of the 8 hazard types in the GSI data
  hazards: {
    earthquake: "地震",
    flood: "洪水",
    tsunami: "津波",
    landslide: "崖崩れ・土石流・地滑り",
    fire: "大規模な火事",
    inland_flood: "内水氾濫",
    storm_surge: "高潮",
    volcano: "火山現象",
  } satisfies Record<HazardKey, string>,
};

export type Dict = typeof ja;

const en: Dict = {
  appSubtitle: "Emergency Evacuation Site Map",
  currentLocation: "My location",
  language: "Language",
  hazardFilterLabel: "Hazard type",
  all: "All",
  nearestTitle: "Nearest evacuation sites",
  searching: "Searching…",
  noResults: "No evacuation sites found.",
  zoomHint: "Zoom in on the map to view local evacuation sites.",
  straightLineDistance: "Straight-line",
  straightLineNote: "* Straight-line distance. The walking route may be longer.",
  close: "Close",
  geoUnsupported: "This browser does not support location services.",
  geoFailed: "Could not get your location",
  datasetName: "Designated Emergency Evacuation Sites data",
  hazards: {
    earthquake: "Earthquake",
    flood: "Flood",
    tsunami: "Tsunami",
    landslide: "Landslide / Debris flow",
    fire: "Large-scale fire",
    inland_flood: "Inland flooding",
    storm_surge: "Storm surge",
    volcano: "Volcano",
  },
};

export const translations: Record<Lang, Dict> = { ja, en };

// ---- Language choice: saved choice > browser language > English ----
const STORAGE_KEY = "hinan-map-lang";

function isLang(value: string): value is Lang {
  return LANGS.some((l) => l.code === value);
}

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isLang(saved)) return saved;
  } catch {
    // localStorage can throw in private browsing; just fall through
  }
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("ja")) return "ja";
  return "en"; // foreign residents: English is the safest default
}

export function saveLang(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}
