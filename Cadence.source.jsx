import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from "recharts";

/* ============================================================
   Cadence — a manual-entry cycle companion
   Signals: basal temperature (confirms ovulation after the fact)
   + cervical mucus (warns ovulation is approaching) + period logging.
   All data persists via window.storage under one key.
   ============================================================ */

const C = {
  ink: "#3A2A33",
  inkSoft: "#6E5A64",
  paper: "#FBF6F4",
  card: "#FFFFFF",
  line: "#EDE2DE",
  berry: "#8E3B46",   // period
  rose: "#C2506D",    // peak fertility
  blush: "#E9B3C1",   // fertile
  sage: "#8FAC88",    // low fertility
  mist: "#E6DcD7",    // unknown / future
  gold: "#C99A5B",    // ovulation marker
};

const STORAGE_KEY = "cadence-data";
const DEFAULT_DATA = { settings: { unit: "F", cycleLen: 28, tempSource: "oral" }, entries: {} };

/* Cervical mucus, driest → most fertile. Watery & egg-white are
   the fertile-quality types; egg-white is the classic peak sign. */
const MUCUS = [
  { key: "dry", label: "Dry", desc: "None, or just a dry feeling", rank: 0 },
  { key: "sticky", label: "Sticky", desc: "Tacky, crumbly, pasty", rank: 1 },
  { key: "creamy", label: "Creamy", desc: "Lotion-like, smooth, white", rank: 2 },
  { key: "watery", label: "Watery", desc: "Thin, wet, slippery — fertile", rank: 3 },
  { key: "eggwhite", label: "Egg white", desc: "Clear, stretchy, like raw egg white — peak", rank: 4 },
];
const MUCUS_RANK = Object.fromEntries(MUCUS.map((m) => [m.key, m.rank]));
const MUCUS_LABEL = Object.fromEntries(MUCUS.map((m) => [m.key, m.label]));
const FERTILE_MUCUS = 3; // rank at/above which mucus counts as fertile-quality

/* ---------------- date helpers ---------------- */
const fmt = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const parse = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return fmt(d);
};
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const todayStr = () => fmt(new Date());
const prettyDate = (s) => {
  if (!s) return "";
  return parse(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/* ---------------- temperature units ---------------- */
const fToC = (f) => ((f - 32) * 5) / 9;
const cToF = (c) => (c * 9) / 5 + 32;
// Deviations (Apple Watch wrist temp) are differences, so no 32° offset.
const dFtoC = (f) => (f * 5) / 9;
const dCtoF = (c) => (c * 9) / 5;
const displayTemp = (tempF, unit, source = "oral") => {
  if (tempF == null) return "";
  if (unit === "C") return (source === "wrist" ? dFtoC(tempF) : fToC(tempF)).toFixed(2);
  return tempF.toFixed(2);
};

/* ---------------- cycle analysis ---------------- */
function getCycleStarts(entries) {
  const dates = Object.keys(entries).sort();
  const starts = [];
  for (const d of dates) {
    if (entries[d]?.period && !entries[addDays(d, -1)]?.period) starts.push(d);
  }
  return starts;
}

function cycleStartFor(dateStr, starts) {
  let found = null;
  for (const s of starts) {
    if (s <= dateStr) found = s;
    else break;
  }
  return found;
}

/**
 * Analyze one cycle.
 * Temperature shift rule ("3 over 6"): three consecutive recorded temps,
 * each at least 0.2 °F above the highest of the previous six recorded temps.
 * Ovulation is estimated as the day before the first elevated temp.
 * Mucus "peak day": the last day of fertile-quality (watery / egg-white)
 * mucus, confirmed once a later day dries up. Ovulation falls on or right
 * after the peak day.
 * Priority for the ovulation estimate, strongest first:
 *   1. a day the user marked "ovulation confirmed" (e.g. Apple Watch estimate)
 *   2. temperature shift (three-over-six, retrospective)
 *   3. cervical-mucus peak day (ovulation ≈ peak day)
 *   4. calendar estimate (cycle length − 14)
 */
function analyzeCycle(start, entries, settings, nextStart) {
  const today = todayStr();
  const horizon = nextStart ? addDays(nextStart, -1) : null;

  const temps = [];
  const mucusDays = []; // { date, rank }
  const ovMarks = [];   // days flagged "ovulation confirmed"
  const span = 45;
  for (let i = 0; i < span; i++) {
    const d = addDays(start, i);
    if (horizon && d > horizon) break;
    const e = entries[d];
    if (d > today) continue;
    if (e?.temp != null) temps.push({ date: d, day: i + 1, tempF: e.temp });
    if (e?.mucus) mucusDays.push({ date: d, rank: MUCUS_RANK[e.mucus] });
    if (e?.ov) ovMarks.push(d);
  }

  let shift = null; // { firstRiseDate, coverlineF }
  for (let i = 6; i + 2 < temps.length; i++) {
    const prev6 = temps.slice(i - 6, i).map((t) => t.tempF);
    const base = Math.max(...prev6);
    if (
      temps[i].tempF >= base + 0.2 &&
      temps[i + 1].tempF >= base + 0.2 &&
      temps[i + 2].tempF >= base + 0.2
    ) {
      shift = { firstRiseDate: temps[i].date, coverlineF: base + 0.1 };
      break;
    }
  }

  // Mucus peak day = last fertile-quality day that is followed by a drier
  // recorded day (that's what confirms it was the peak). If the fertile
  // streak is still open, we hold off calling it.
  const fertileMucus = mucusDays.filter((m) => m.rank >= FERTILE_MUCUS);
  let peakDay = null;
  let fertileMucusOngoing = false;
  if (fertileMucus.length) {
    const lastFertile = fertileMucus[fertileMucus.length - 1].date;
    const driedAfter = mucusDays.some(
      (m) => m.date > lastFertile && m.rank < FERTILE_MUCUS
    );
    if (driedAfter) peakDay = lastFertile;
    else fertileMucusOngoing = true;
  }

  const ovConfirmed = ovMarks.length ? ovMarks[ovMarks.length - 1] : null;
  let ovulation, method;
  if (ovConfirmed) {
    ovulation = ovConfirmed;
    method = "confirmed";
  } else if (shift) {
    ovulation = addDays(shift.firstRiseDate, -1);
    method = "temp";
  } else if (peakDay) {
    ovulation = peakDay;
    method = "mucus";
  } else {
    ovulation = addDays(start, Math.max(settings.cycleLen - 14, 7));
    method = "calendar";
  }

  // Independent signs agreeing = the sympto-thermal cross-check.
  // Temperature axis = a computed shift or a watch-confirmed day; mucus axis = the peak day.
  const tempAxis = !!shift || !!ovConfirmed;
  const crossChecked = tempAxis && !!peakDay;

  // Fertile window: the calendar guess, widened by any real fertile mucus.
  let fertileStart = addDays(ovulation, -5);
  let fertileEnd = addDays(ovulation, 1);
  if (fertileMucus.length) {
    const firstFM = fertileMucus[0].date;
    const lastFM = fertileMucus[fertileMucus.length - 1].date;
    if (firstFM < fertileStart) fertileStart = firstFM;
    const closeFM = addDays(lastFM, 1);
    if (closeFM > fertileEnd) fertileEnd = closeFM;
  }

  return {
    start,
    nextStart: horizon,
    ovulation,
    method,
    crossChecked,
    ovConfirmed,
    shift,
    temps,
    peakDay,
    fertileMucusOngoing,
    hasFertileMucus: fertileMucus.length > 0,
    fertileStart,
    fertileEnd,
    peakStart: addDays(ovulation, -2),
    peakEnd: ovulation,
  };
}

const STATUS_RANK = { unknown: 0, low: 1, fertile: 2, peak: 3 };

/** Fertility status for a single day, given its cycle analysis. */
function dayStatus(dateStr, entries, analysis) {
  const e = entries[dateStr];
  if (e?.period) return "period";
  if (!analysis) return "unknown";
  if (analysis.nextStart && dateStr > analysis.nextStart) return "unknown";

  let base = "low";
  if (dateStr >= analysis.peakStart && dateStr <= analysis.peakEnd) base = "peak";
  else if (dateStr >= analysis.fertileStart && dateStr <= analysis.fertileEnd) base = "fertile";

  // A day's own fertile-quality mucus can only raise its status, never lower it.
  if (e?.mucus && dateStr <= todayStr()) {
    const r = MUCUS_RANK[e.mucus];
    const mucusStatus = r >= 4 ? "peak" : r >= FERTILE_MUCUS ? "fertile" : null;
    if (mucusStatus && STATUS_RANK[mucusStatus] > STATUS_RANK[base]) base = mucusStatus;
  }
  return base;
}

const STATUS_COLOR = {
  period: C.berry,
  peak: C.rose,
  fertile: C.blush,
  low: C.sage,
  unknown: C.mist,
};
const PHASE_LABEL = {
  period: "Menstrual",
  peak: "Peak fertility",
  fertile: "Fertile window",
  low: "Low fertility",
  unknown: "Learning",
};

/* ---------------- SVG ring helpers ---------------- */
function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/* ================= main component ================= */
export default function Cadence() {
  const [data, setData] = useState(DEFAULT_DATA);
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [selDate, setSelDate] = useState(todayStr());
  const [viewMonth, setViewMonth] = useState(() => {
    const t = new Date();
    return { y: t.getFullYear(), m: t.getMonth() };
  });
  const [savedTick, setSavedTick] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const saveTimer = useRef(null);

  /* ---- load once ---- */
  useEffect(() => {
    (async () => {
      try {
        if (typeof window !== "undefined" && window.storage) {
          const res = await window.storage.get(STORAGE_KEY);
          if (res?.value) {
            const parsed = JSON.parse(res.value);
            setData({
              settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
              entries: parsed.entries || {},
            });
          }
        } else {
          setStorageOk(false);
        }
      } catch (e) {
        /* no saved data yet — start fresh */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /* ---- debounced save ---- */
  const persist = useCallback((next) => {
    setData(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        if (window.storage) {
          await window.storage.set(STORAGE_KEY, JSON.stringify(next));
          setSavedTick(true);
          setTimeout(() => setSavedTick(false), 1600);
        }
      } catch (e) {
        setStorageOk(false);
      }
    }, 400);
  }, []);

  const updateEntry = (dateStr, patch) => {
    const cur = data.entries[dateStr] || { temp: null, mucus: null, period: false, ov: false, notes: "" };
    const merged = { ...cur, ...patch };
    const entries = { ...data.entries };
    const empty =
      merged.temp == null && !merged.mucus && !merged.period && !merged.ov && !(merged.notes || "").trim();
    if (empty) delete entries[dateStr];
    else entries[dateStr] = merged;
    persist({ ...data, entries });
  };

  const updateSettings = (patch) =>
    persist({ ...data, settings: { ...data.settings, ...patch } });

  /* ---- analysis ---- */
  const { entries, settings } = data;
  const starts = useMemo(() => getCycleStarts(entries), [entries]);

  const analysisCache = useMemo(() => {
    const cache = {};
    starts.forEach((s, i) => {
      cache[s] = analyzeCycle(s, entries, settings, starts[i + 1] || null);
    });
    return cache;
  }, [starts, entries, settings]);

  const analysisFor = (dateStr) => {
    const s = cycleStartFor(dateStr, starts);
    return s ? analysisCache[s] : null;
  };

  const today = todayStr();
  const todayAnalysis = analysisFor(today);
  const todayStatus = dayStatus(today, entries, todayAnalysis);
  const cycleDay = todayAnalysis ? diffDays(todayAnalysis.start, today) + 1 : null;

  /* ---- status message ---- */
  const todayMucus = entries[today]?.mucus;
  let message = "Log the first day of a period to begin tracking.";
  if (todayAnalysis) {
    const a = todayAnalysis;
    if (a.method === "confirmed") {
      message = a.crossChecked
        ? `Ovulation confirmed for ${prettyDate(a.ovulation)} — your watch estimate and the mucus peak agree. Now in the luteal phase.`
        : `Ovulation confirmed for ${prettyDate(a.ovulation)} from your Apple Watch estimate. Now in the luteal phase.`;
    } else if (a.method === "temp") {
      message = a.crossChecked
        ? `Ovulation confirmed — the temperature rise and mucus peak agree, estimated ${prettyDate(a.ovulation)}. Now in the luteal phase.`
        : `Ovulation confirmed by the temperature rise — estimated ${prettyDate(a.ovulation)}. Now in the luteal phase.`;
    } else if (todayMucus === "eggwhite") {
      message = `Egg-white mucus today — the clearest peak-fertility sign there is. One of the best days to try.`;
    } else if (a.fertileMucusOngoing && todayMucus && MUCUS_RANK[todayMucus] >= FERTILE_MUCUS) {
      message = `Fertile-quality mucus present — the fertile window is open. Keep watching for the peak (egg-white) day.`;
    } else if (today >= a.fertileStart && today <= a.fertileEnd) {
      message = `Inside the predicted fertile window (${prettyDate(a.fertileStart)} – ${prettyDate(a.fertileEnd)}). Watch for mucus turning watery or egg-white.`;
    } else if (today < a.fertileStart) {
      message = `Fertile window predicted ${prettyDate(a.fertileStart)} – ${prettyDate(a.fertileEnd)}. Mucus turning wetter is the earliest sign it's opening.`;
    } else {
      message = `Past the estimated fertile window. The temperature trend over the next days will confirm whether ovulation occurred.`;
    }
  }

  /* ---- chart data (current cycle) ---- */
  const chartData = useMemo(() => {
    if (!todayAnalysis) return [];
    const a = todayAnalysis;
    const len = Math.min(diffDays(a.start, today) + 1, 45);
    const rows = [];
    for (let i = 0; i < len; i++) {
      const d = addDays(a.start, i);
      const e = entries[d];
      rows.push({
        day: i + 1,
        date: d,
        temp: e?.temp != null ? Number(displayTemp(e.temp, settings.unit, settings.tempSource)) : null,
      });
    }
    return rows;
  }, [todayAnalysis, entries, settings.unit, settings.tempSource, today]);

  const coverlineDisplay =
    todayAnalysis?.shift != null
      ? Number(displayTemp(todayAnalysis.shift.coverlineF, settings.unit, settings.tempSource))
      : null;
  const ovulationDay =
    todayAnalysis ? diffDays(todayAnalysis.start, todayAnalysis.ovulation) + 1 : null;
  const peakMucusDay =
    todayAnalysis?.peakDay ? diffDays(todayAnalysis.start, todayAnalysis.peakDay) + 1 : null;

  /* ---- selected-day entry ---- */
  const sel = entries[selDate] || { temp: null, mucus: null, period: false, ov: false, notes: "" };
  const [tempDraft, setTempDraft] = useState("");
  useEffect(() => {
    setTempDraft(displayTemp(sel.temp, settings.unit, settings.tempSource));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDate, settings.unit, settings.tempSource, loaded]);

  const commitTemp = () => {
    const v = parseFloat(tempDraft);
    if (isNaN(v)) {
      if (tempDraft.trim() === "") updateEntry(selDate, { temp: null });
      return;
    }
    if (settings.tempSource === "wrist") {
      const f = settings.unit === "C" ? dCtoF(v) : v; // store deviation in °F
      if (f < -6 || f > 6) return; // ignore implausible deviations
      updateEntry(selDate, { temp: Math.round(f * 100) / 100 });
    } else {
      const f = settings.unit === "C" ? cToF(v) : v;
      if (f < 90 || f > 106) return; // ignore implausible absolute temps
      updateEntry(selDate, { temp: Math.round(f * 100) / 100 });
    }
  };

  /* ---- calendar grid ---- */
  const monthCells = useMemo(() => {
    const first = new Date(viewMonth.y, viewMonth.m, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(viewMonth.y, viewMonth.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(fmt(new Date(viewMonth.y, viewMonth.m, d)));
    return cells;
  }, [viewMonth]);

  /* ---- ring segments ---- */
  const ring = useMemo(() => {
    if (!todayAnalysis) return null;
    const a = todayAnalysis;
    const elapsed = diffDays(a.start, today) + 1;
    const total = Math.min(Math.max(settings.cycleLen, elapsed), 60);
    const segs = [];
    const gap = total > 34 ? 1.2 : 2;
    const per = 360 / total;
    for (let i = 0; i < total; i++) {
      const d = addDays(a.start, i);
      const inFuture = d > today;
      const st = dayStatus(d, entries, a);
      segs.push({
        path: arcPath(110, 110, 88, i * per + gap / 2, (i + 1) * per - gap / 2),
        color: STATUS_COLOR[st],
        faded: inFuture,
        isToday: d === today,
        date: d,
      });
    }
    return { segs, total };
  }, [todayAnalysis, entries, settings.cycleLen, today]);

  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", background: C.paper, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Karla, system-ui, sans-serif", color: C.inkSoft }}>
        Opening your cycle data…
      </div>
    );
  }

  const pill = (active, color) => ({
    padding: "8px 14px",
    borderRadius: 999,
    border: `1.5px solid ${active ? color : C.line}`,
    background: active ? color : "transparent",
    color: active ? "#fff" : C.inkSoft,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all .15s ease",
  });

  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: "Karla, 'Segoe UI', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Karla:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        input, textarea, button { font-family: inherit; }
        input:focus, textarea:focus, button:focus-visible { outline: 2px solid ${C.rose}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
        .cad-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .cad-hero { display: grid; grid-template-columns: 240px 1fr; gap: 24px; align-items: center; }
        @media (max-width: 720px) {
          .cad-grid { grid-template-columns: 1fr; }
          .cad-hero { grid-template-columns: 1fr; justify-items: center; text-align: center; }
        }
      `}</style>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "28px 20px 48px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22 }}>
          <div>
            <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 30, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Cadence
            </div>
            <div style={{ fontSize: 13, color: C.inkSoft, marginTop: 2 }}>
              mucus warns · temperature confirms · watch verifies
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: C.sage, fontWeight: 700, opacity: savedTick ? 1 : 0, transition: "opacity .3s" }}>
              Saved ✓
            </span>
            <button onClick={() => setShowSettings(!showSettings)} style={pill(showSettings, C.ink)}>
              Settings
            </button>
          </div>
        </div>

        {!storageOk && (
          <div style={{ background: "#FBEEE9", border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", fontSize: 13, color: C.berry, marginBottom: 16 }}>
            Persistent storage isn't available right now — entries will only last for this session.
          </div>
        )}

        {showSettings && (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 18, marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.inkSoft, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Temperature source</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={pill(settings.tempSource === "oral", C.rose)} onClick={() => updateSettings({ tempSource: "oral" })}>Oral basal</button>
                <button style={pill(settings.tempSource === "wrist", C.rose)} onClick={() => updateSettings({ tempSource: "wrist" })}>Apple Watch</button>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.inkSoft, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Temperature unit</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={pill(settings.unit === "F", C.rose)} onClick={() => updateSettings({ unit: "F" })}>°F</button>
                <button style={pill(settings.unit === "C", C.rose)} onClick={() => updateSettings({ unit: "C" })}>°C</button>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.inkSoft, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Typical cycle length</div>
              <input
                type="number" min={21} max={40} value={settings.cycleLen}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 21 && v <= 40) updateSettings({ cycleLen: v });
                }}
                style={{ width: 80, padding: "8px 10px", borderRadius: 10, border: `1.5px solid ${C.line}`, fontSize: 14, background: C.paper, color: C.ink }}
              />
              <span style={{ fontSize: 13, color: C.inkSoft, marginLeft: 8 }}>days</span>
            </div>
            <div style={{ fontSize: 12, color: C.inkSoft, maxWidth: 300 }}>
              Used only until mucus or a temperature shift gives the app something better than the calendar.
            </div>
          </div>
        )}

        {/* hero: ring + status */}
        <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 20, padding: 24, marginBottom: 20 }}>
          {todayAnalysis && ring ? (
            <div className="cad-hero">
              <svg width={220} height={220} viewBox="0 0 220 220" role="img" aria-label={`Cycle day ${cycleDay}`}>
                {ring.segs.map((s, i) => (
                  <path key={i} d={s.path} stroke={s.color} strokeWidth={s.isToday ? 17 : 12}
                    strokeLinecap="round" fill="none" opacity={s.faded && !s.isToday ? 0.35 : 1} />
                ))}
                <text x={110} y={104} textAnchor="middle" style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 44, fontWeight: 600, fill: C.ink }}>
                  {cycleDay}
                </text>
                <text x={110} y={126} textAnchor="middle" style={{ fontSize: 12, fill: C.inkSoft, letterSpacing: "0.08em" }}>
                  CYCLE DAY
                </text>
                <text x={110} y={146} textAnchor="middle" style={{ fontSize: 12, fontWeight: 700, fill: STATUS_COLOR[todayStatus] }}>
                  {PHASE_LABEL[todayStatus].toUpperCase()}
                </text>
              </svg>
              <div>
                <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 21, fontWeight: 600, marginBottom: 8, lineHeight: 1.35 }}>
                  {message}
                </div>
                <div style={{ fontSize: 14, color: C.inkSoft, lineHeight: 1.6 }}>
                  Estimated ovulation <b style={{ color: C.ink }}>{prettyDate(todayAnalysis.ovulation)}</b>{" "}
                  ({todayAnalysis.crossChecked
                    ? "cross-checked by temperature + mucus"
                    : todayAnalysis.method === "confirmed" ? "confirmed via Apple Watch estimate"
                    : todayAnalysis.method === "temp" ? "confirmed by temperature"
                    : todayAnalysis.method === "mucus" ? "based on the mucus peak"
                    : "calendar estimate"}).
                  Fertile window <b style={{ color: C.ink }}>{prettyDate(todayAnalysis.fertileStart)} – {prettyDate(todayAnalysis.fertileEnd)}</b>.
                </div>
                <div style={{ display: "flex", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
                  {[["period", "Period"], ["peak", "Peak"], ["fertile", "Fertile"], ["low", "Low"]].map(([k, label]) => (
                    <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.inkSoft }}>
                      <span style={{ width: 10, height: 10, borderRadius: 99, background: STATUS_COLOR[k], display: "inline-block" }} />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: "24px 12px" }}>
              <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
                Start with the first day of a period
              </div>
              <div style={{ fontSize: 14, color: C.inkSoft, marginBottom: 16, lineHeight: 1.6 }}>
                Everything is counted from cycle day 1. Once a period is logged, the ring, predictions and chart appear.
              </div>
              <button
                onClick={() => { updateEntry(today, { period: true }); setSelDate(today); }}
                style={{ ...pill(true, C.berry), fontSize: 14, padding: "10px 20px" }}
              >
                Her period started today
              </button>
              <div style={{ fontSize: 13, color: C.inkSoft, marginTop: 12 }}>
                Or pick a past date on the calendar below and mark it as a period day.
              </div>
            </div>
          )}
        </div>

        <div className="cad-grid">
          {/* daily entry */}
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 20, padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
              <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 19, fontWeight: 600 }}>
                {selDate === today ? "Today" : parse(selDate).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
              </div>
              {selDate !== today && (
                <button onClick={() => setSelDate(today)} style={{ ...pill(false, C.ink), padding: "5px 10px", fontSize: 12 }}>
                  Back to today
                </button>
              )}
            </div>

            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              {settings.tempSource === "wrist"
                ? `Wrist temp change (°${settings.unit} from baseline)`
                : `Waking temperature (°${settings.unit})`}
            </label>
            <input
              type="number" step="0.01" inputMode="decimal"
              placeholder={settings.tempSource === "wrist"
                ? (settings.unit === "F" ? "e.g. +0.35 or −0.20" : "e.g. +0.20 or −0.10")
                : (settings.unit === "F" ? "e.g. 97.60" : "e.g. 36.45")}
              value={tempDraft}
              onChange={(e) => setTempDraft(e.target.value)}
              onBlur={commitTemp}
              onKeyDown={(e) => { if (e.key === "Enter") { commitTemp(); e.currentTarget.blur(); } }}
              style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1.5px solid ${C.line}`, fontSize: 17, background: C.paper, color: C.ink, marginBottom: settings.tempSource === "wrist" ? 6 : 16 }}
            />
            {settings.tempSource === "wrist" && (
              <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 16 }}>
                From Health → Body Measurements → Wrist Temperature. Enter the nightly change from baseline; a sustained rise still marks ovulation.
              </div>
            )}

            <div style={{ fontSize: 12, fontWeight: 700, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Cervical mucus
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
              <button style={{ ...pill(!sel.mucus, C.ink), padding: "7px 11px" }} onClick={() => updateEntry(selDate, { mucus: null })}>—</button>
              {MUCUS.map((m) => (
                <button
                  key={m.key}
                  style={{ ...pill(sel.mucus === m.key, m.rank >= 4 ? C.rose : m.rank >= FERTILE_MUCUS ? C.blush : C.sage), padding: "7px 11px", ...(sel.mucus === m.key && m.rank === FERTILE_MUCUS ? { color: C.ink } : {}) }}
                  onClick={() => updateEntry(selDate, { mucus: m.key })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 16, minHeight: 16 }}>
              {sel.mucus ? MUCUS.find((m) => m.key === sel.mucus)?.desc : "Watery and egg-white are the fertile-quality types."}
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Ovulation confirmed
            </div>
            <div style={{ marginBottom: 6 }}>
              <button style={pill(sel.ov, C.gold)} onClick={() => updateEntry(selDate, { ov: !sel.ov })}>
                {sel.ov ? "Ovulation confirmed here ✓" : "Mark this as the ovulation day"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 16 }}>
              Use the day your Apple Watch estimates you ovulated — the light-purple oval in Health → Cycle Tracking. It's retrospective and appears after about two cycles. This overrides the other estimates.
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Period
            </div>
            <div style={{ marginBottom: 16 }}>
              <button style={pill(sel.period, C.berry)} onClick={() => updateEntry(selDate, { period: !sel.period })}>
                {sel.period ? "Period day ✓" : "Mark as period day"}
              </button>
            </div>

            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: C.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Notes
            </label>
            <textarea
              rows={2}
              value={sel.notes || ""}
              onChange={(e) => updateEntry(selDate, { notes: e.target.value })}
              placeholder="Sleep, symptoms, anything worth remembering"
              style={{ width: "100%", padding: "10px 14px", borderRadius: 12, border: `1.5px solid ${C.line}`, fontSize: 14, background: C.paper, color: C.ink, resize: "vertical" }}
            />
          </div>

          {/* calendar */}
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 20, padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <button style={pill(false, C.ink)} onClick={() => setViewMonth((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))} aria-label="Previous month">‹</button>
              <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 18, fontWeight: 600 }}>
                {new Date(viewMonth.y, viewMonth.m).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
              </div>
              <button style={pill(false, C.ink)} onClick={() => setViewMonth((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))} aria-label="Next month">›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, textAlign: "center" }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div key={i} style={{ fontSize: 11, fontWeight: 700, color: C.inkSoft, padding: "4px 0" }}>{d}</div>
              ))}
              {monthCells.map((d, i) => {
                if (!d) return <div key={i} />;
                const st = dayStatus(d, entries, analysisFor(d));
                const isFuture = d > today;
                const isSel = d === selDate;
                const isToday = d === today;
                const hasTemp = entries[d]?.temp != null;
                const mucusRank = entries[d]?.mucus ? MUCUS_RANK[entries[d].mucus] : -1;
                const isOv = !!entries[d]?.ov;
                return (
                  <button
                    key={i}
                    onClick={() => setSelDate(d)}
                    style={{
                      position: "relative",
                      aspectRatio: "1",
                      borderRadius: 12,
                      border: isSel ? `2px solid ${C.ink}` : isOv ? `2px solid ${C.gold}` : isToday ? `2px solid ${STATUS_COLOR[st]}` : "2px solid transparent",
                      background: STATUS_COLOR[st],
                      opacity: isFuture ? 0.4 : 1,
                      color: st === "unknown" || st === "fertile" ? C.ink : "#fff",
                      fontSize: 13,
                      fontWeight: isToday ? 800 : 600,
                      cursor: "pointer",
                      padding: 0,
                    }}
                    aria-label={`${d}, ${PHASE_LABEL[st]}${isOv ? ", ovulation confirmed" : ""}`}
                  >
                    {parseInt(d.slice(-2), 10)}
                    {(hasTemp || mucusRank >= FERTILE_MUCUS || isOv) && (
                      <span style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 2 }}>
                        {hasTemp && <span style={{ width: 4, height: 4, borderRadius: 9, background: "currentColor", opacity: 0.85 }} />}
                        {mucusRank >= FERTILE_MUCUS && <span style={{ width: 4, height: 4, borderRadius: 9, background: mucusRank >= 4 ? C.rose : C.card, border: mucusRank >= 4 ? "none" : `1px solid ${C.rose}` }} />}
                        {isOv && <span style={{ width: 4, height: 4, borderRadius: 9, background: C.gold }} />}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: C.inkSoft, marginTop: 12, lineHeight: 1.5 }}>
              Tap any day to edit it. Dots mark a logged temperature (dark), fertile mucus (rose — filled for egg-white), or confirmed ovulation (gold, ringed). Future days show the current prediction, faded.
            </div>
          </div>
        </div>

        {/* chart */}
        {chartData.some((r) => r.temp != null) && (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 20, padding: 22, marginTop: 20 }}>
            <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 19, fontWeight: 600, marginBottom: 4 }}>
              {settings.tempSource === "wrist" ? "This cycle's overnight wrist temperature" : "This cycle's temperatures"}
            </div>
            <div style={{ fontSize: 13, color: C.inkSoft, marginBottom: 14 }}>
              Look for a sustained rise of roughly 0.2 °F (0.1 °C) held for three days — that's the pattern that confirms ovulation happened.
              {settings.tempSource === "wrist" && " In wrist mode the values are changes from baseline, so the rise sits above the zero line."}
              {coverlineDisplay != null && " The dashed line is the coverline the shift cleared."}
            </div>
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.inkSoft }} tickLine={false} axisLine={{ stroke: C.line }}
                    label={{ value: "cycle day", position: "insideBottomRight", offset: -2, fontSize: 11, fill: C.inkSoft }} />
                  <YAxis domain={["dataMin - 0.2", "dataMax + 0.2"]} tick={{ fontSize: 11, fill: C.inkSoft }} tickLine={false} axisLine={false}
                    tickFormatter={(v) => v.toFixed(1)} />
                  <Tooltip
                    formatter={(v) => [`${settings.tempSource === "wrist" && v > 0 ? "+" : ""}${v} °${settings.unit}`, settings.tempSource === "wrist" ? "change" : "temp"]}
                    labelFormatter={(d) => `Cycle day ${d}`}
                    contentStyle={{ borderRadius: 12, border: `1px solid ${C.line}`, fontSize: 13, fontFamily: "inherit" }}
                  />
                  {settings.tempSource === "wrist" && (
                    <ReferenceLine y={0} stroke={C.line} strokeWidth={1.5} />
                  )}
                  {coverlineDisplay != null && (
                    <ReferenceLine y={coverlineDisplay} stroke={C.rose} strokeDasharray="5 4" strokeWidth={1.5} />
                  )}
                  {peakMucusDay != null && peakMucusDay !== ovulationDay && peakMucusDay <= chartData.length && (
                    <ReferenceLine x={peakMucusDay} stroke={C.rose} strokeWidth={1.5} strokeDasharray="3 3"
                      label={{ value: "mucus peak", fontSize: 11, fill: C.rose, position: "insideTopLeft" }} />
                  )}
                  {ovulationDay != null && ovulationDay <= chartData.length && (
                    <ReferenceLine x={ovulationDay} stroke={C.gold} strokeWidth={1.5}
                      label={{ value: todayAnalysis?.method === "confirmed" ? "ovulation" : "est. ovulation", fontSize: 11, fill: C.gold, position: "top" }} />
                  )}
                  <Line
                    type="monotone" dataKey="temp" connectNulls stroke={C.ink} strokeWidth={2}
                    dot={(p) => {
                      const { cx, cy, payload, index } = p;
                      if (payload.temp == null) return <g key={index} />;
                      return <circle key={index} cx={cx} cy={cy} r={3.5} fill={C.ink} />;
                    }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* method & sources */}
        <details style={{ marginTop: 24, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
          <summary style={{ fontSize: 13, fontWeight: 700, color: C.inkSoft, cursor: "pointer", listStyle: "none" }}>
            How Cadence estimates ovulation &amp; sources ›
          </summary>
          <div style={{ fontSize: 12.5, color: C.inkSoft, lineHeight: 1.7, marginTop: 10 }}>
            Cadence uses the two body signs of the <b style={{ color: C.ink }}>sympto-thermal method</b> of fertility awareness:
            <div style={{ margin: "8px 0 8px 0" }}>
              <div style={{ marginBottom: 5 }}>
                <b style={{ color: C.ink }}>Temperature — confirms ovulation afterward.</b> The "three-over-six" rule: three temperatures in a row at least 0.2 °F (0.1 °C) above the highest of the previous six days. Ovulation is marked the day before that rise. Temperatures can be an oral basal reading or the Apple Watch overnight wrist-temperature change from baseline — the rule works the same either way.
              </div>
              <div style={{ marginBottom: 5 }}>
                <b style={{ color: C.ink }}>Cervical mucus — warns ovulation is coming.</b> The "peak day" is the last day of egg-white or watery mucus before it dries; ovulation falls on or within a day of it.
              </div>
              <div style={{ marginBottom: 5 }}>
                <b style={{ color: C.ink }}>Apple Watch estimate — an optional cross-check.</b> If you mark a day "ovulation confirmed" using the Watch's retrospective estimate, Cadence uses it directly. That estimate is itself temperature-based, is available only after about two cycles, and can disagree with the other signs, so it's a confirmation — not a guarantee.
              </div>
              <div>
                <b style={{ color: C.ink }}>Calendar — used only until a sign appears.</b> Ovulation ≈ cycle length − 14, since the luteal phase averages about 14 days. The fertile window is the 5 days before ovulation plus ovulation day, because sperm can survive up to ~5 days.
              </div>
            </div>
            Sources: the sympto-thermal (Sensiplan) method rules for the temperature shift and mucus peak day; the American College of Obstetricians and Gynecologists (ACOG) for the ~14-day luteal phase and the fertile window; Weschler, <i>Taking Charge of Your Fertility</i>, for coverline charting; and Apple Support for how wrist temperature and retrospective ovulation estimates work. The three-over-six temperature rule has been evaluated in peer-reviewed research against urine-LH ovulation tests.
          </div>
        </details>

        {/* footer */}
        <div style={{ fontSize: 12, color: C.inkSoft, marginTop: 24, lineHeight: 1.6, borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
          Cadence is a homemade planning tool for trying to conceive. It is not a medical device and must not be relied on to prevent pregnancy.
          Predictions before the temperature rise are estimates — the day's actual mucus and temperature observations always outrank the forecast.
        </div>
      </div>
    </div>
  );
}
