import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* ============================================================
   ISC HOUR TRACKER — hosted edition
   Accounts + MongoDB persistence via /api
   ============================================================ */

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORT = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const MAX_WEEK = 40;
const TOKEN_KEY = "isc-token";
const HES_URL =
  "https://age.hes-so.ch/imoniteur_AGEP/!farforms.htm?ww_i_for=2812109249&ww_i_util_form=12629336182&ww_x_sessionId=";

const PETALS = ["#6EC5E9", "#B08BC9", "#F096B4", "#8FD4C1", "#E8D96E", "#6EC5E9", "#B08BC9"];
const MAGENTA = "#E5137D";

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- date helpers ---------- */
function mondayOf(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return date;
}
function keyOf(monday) {
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(
    monday.getDate()
  ).padStart(2, "0")}`;
}
function parseKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function isoWeek(monday) {
  const t = new Date(monday);
  t.setDate(t.getDate() + 3);
  const jan1 = new Date(t.getFullYear(), 0, 1);
  return Math.ceil(((t - jan1) / 86400000 + 1) / 7);
}
function fmtDay(d) {
  return d.toLocaleDateString("en-CH", { day: "numeric", month: "short" });
}
function fmtRange(monday) {
  const sun = addDays(monday, 6);
  return `${fmtDay(monday)} — ${fmtDay(sun)} ${sun.getFullYear()}`;
}
function monthLabel(mk) {
  const [y, m] = mk.split("-").map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString("fr-CH", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const emptyWeek = () => ({ days: Array.from({ length: 7 }, () => ({ h: 0, note: "" })) });
const chf = (n) =>
  "CHF " + n.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const trimH = (n) => n.toFixed(2).replace(/\.?0+$/, "") || "0";
const hhmm = (h) => {
  const a = Math.abs(h);
  const hh = Math.floor(a);
  const mm = Math.round((a - hh) * 60);
  return `${h < 0 ? "-" : ""}${hh}:${String(mm).padStart(2, "0")}`;
};

/* ---------- animated number ---------- */
function useCountUp(value, duration = 500) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const reduced = useRef(false);
  useEffect(() => {
    try {
      reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}
  }, []);
  useEffect(() => {
    if (reduced.current || prev.current === value) {
      setDisplay(value);
      prev.current = value;
      return;
    }
    const from = prev.current;
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

/* ---------- pdf download ---------- */
function downloadPdf(filename, pdfString) {
  const bytes = Uint8Array.from(pdfString, (c) => c.charCodeAt(0) & 0xff);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ============================================================
   Minimal PDF writer — A4 fiche de paie
   ============================================================ */
function pdfEsc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function latin1(s) {
  let out = "";
  for (const ch of s) out += ch.charCodeAt(0) <= 255 ? ch : "?";
  return out;
}
function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    .map((v) => v.toFixed(3))
    .join(" ");
}
function makeFichePdf({ monthKey, entries, weeksSummary, totalHours, rate, email }) {
  const W = 595.28;
  const c = [];
  const text = (x, y, size, str, { bold = false, color = "#1D1D1B" } = {}) => {
    c.push(
      `${hexRGB(color)} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${pdfEsc(latin1(str))}) Tj ET`
    );
  };
  const rect = (x, y, w, h, color) => c.push(`${hexRGB(color)} rg ${x} ${y} ${w} ${h} re f`);
  const line = (x1, y1, x2, y2, color = "#DDDDD8", lw = 0.8) =>
    c.push(`${hexRGB(color)} RG ${lw} w ${x1} ${y1} m ${x2} ${y2} l S`);

  const petals = ["#6EC5E9", "#B08BC9", "#F096B4", "#8FD4C1", "#E8D96E"];
  petals.forEach((p, i) => rect(40 + i * 20, 790, 16, 16, p));
  rect(W - 66, 788, 20, 20, MAGENTA);
  text(W - 60.5, 793.5, 12, "p", { bold: true, color: "#FFFFFF" });
  text(40, 762, 20, "ISC HOUR TRACKER", { bold: true });
  text(40, 742, 13, `Fiche de paie — ${monthLabel(monthKey)}`, { color: MAGENTA, bold: true });
  text(40, 726, 9, `Informatique et systèmes de communication · ${email}`, { color: "#8A8A86" });
  line(40, 714, W - 40, 714, "#1D1D1B", 1.4);

  text(40, 696, 10, `Taux horaire : ${chf(rate)} / h`);
  text(230, 696, 10, `Limite légale : 40 h / semaine`);
  text(420, 696, 10, `Généré le ${new Date().toLocaleDateString("fr-CH")}`);

  let y = 672;
  text(40, y, 11, "Semaines", { bold: true });
  y -= 16;
  weeksSummary.forEach((w) => {
    text(48, y, 9.5, `Semaine ${w.wk} (${w.range})`);
    text(400, y, 9.5, `${trimH(w.hours)} h`, { bold: true });
    text(470, y, 9.5, chf(w.hours * rate));
    y -= 14;
  });
  y -= 8;
  line(40, y, W - 40, y);
  y -= 20;

  text(40, y, 11, "Détail des jours", { bold: true });
  y -= 16;
  text(48, y, 8.5, "DATE", { color: "#8A8A86", bold: true });
  text(140, y, 8.5, "HEURES", { color: "#8A8A86", bold: true });
  text(210, y, 8.5, "ACTIVITÉ", { color: "#8A8A86", bold: true });
  y -= 6;
  line(40, y, W - 40, y);
  y -= 14;
  entries.forEach((e, i) => {
    if (i % 2 === 0) rect(40, y - 3.5, W - 80, 13.5, "#F7F7F4");
    const d = e.date;
    text(
      48,
      y,
      9,
      `${DAY_FR[(d.getDay() + 6) % 7]} ${String(d.getDate()).padStart(2, "0")}.${String(
        d.getMonth() + 1
      ).padStart(2, "0")}`
    );
    text(140, y, 9, `${trimH(e.h)} h`, { bold: true });
    text(210, y, 9, (e.note || "—").slice(0, 62));
    y -= 14;
  });
  y -= 10;

  rect(40, y - 46, W - 80, 52, "#1D1D1B");
  text(52, y - 12, 10, "Total heures", { color: "#FFFFFF" });
  text(52, y - 32, 10, "Salaire brut", { color: "#FFFFFF" });
  text(430, y - 12, 12, `${trimH(totalHours)} h`, { color: "#FFFFFF", bold: true });
  text(430, y - 32, 12, chf(totalHours * rate), { color: "#FFB4D9", bold: true });
  y -= 84;

  line(40, y, 220, y, "#1D1D1B", 1);
  line(340, y, 520, y, "#1D1D1B", 1);
  text(40, y - 12, 8.5, "Signature employé-e", { color: "#8A8A86" });
  text(340, y - 12, 8.5, "Signature responsable", { color: "#8A8A86" });
  text(40, 40, 7.5, "Saisie officielle des heures : age.hes-so.ch (formulaire AGE / HES-SO)", {
    color: "#8A8A86",
  });

  const content = c.join("\n");
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>";
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 6; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

/* ============================================================
   AUTH SCREEN
   ============================================================ */
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api(`/api/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      onAuthed(data.email);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="isc-auth">
      <div className="isc-auth-card">
        <Flower />
        <div className="isc-wordmark" style={{ justifyContent: "center", marginTop: 10 }}>
          ISC hour tracker <span className="pi">π</span>
        </div>
        <div className="isc-sub" style={{ textAlign: "center", marginBottom: 22 }}>
          Informatique et systèmes de communication
        </div>
        <div className="isc-auth-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>
            Log in
          </button>
          <button className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(""); }}>
            Create account
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@hes-so.ch"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={8}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "At least 8 characters" : "Your password"}
            />
          </label>
          {error && <div className="isc-auth-error">{error}</div>}
          <button className="isc-btn magenta solid" type="submit" disabled={busy}>
            {busy ? "One moment…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ============================================================ */
export default function App() {
  const [stage, setStage] = useState("checking"); // checking | anon | ready
  const [email, setEmail] = useState("");
  const [rate, setRate] = useState(28);
  const [weeks, setWeeks] = useState({});
  const [currentKey, setCurrentKey] = useState(keyOf(mondayOf(new Date())));
  const [view, setView] = useState("week");
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [burst, setBurst] = useState(false);
  const saveTimer = useRef(null);
  const firstLoad = useRef(true);
  const wasBelowMax = useRef(true);

  /* ---- session check ---- */
  useEffect(() => {
    (async () => {
      if (!localStorage.getItem(TOKEN_KEY)) return setStage("anon");
      try {
        const me = await api("/api/me");
        setEmail(me.email);
        setRate(me.rate ?? 28);
        setWeeks(me.weeks || {});
        firstLoad.current = true;
        setStage("ready");
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        setStage("anon");
      }
    })();
  }, []);

  const onAuthed = async (mail) => {
    setEmail(mail);
    try {
      const me = await api("/api/me");
      setRate(me.rate ?? 28);
      setWeeks(me.weeks || {});
    } catch (e) {}
    firstLoad.current = true;
    setStage("ready");
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setWeeks({});
    setStage("anon");
  };

  /* ---- debounced save to server ---- */
  useEffect(() => {
    if (stage !== "ready") return;
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api("/api/data", { method: "PUT", body: JSON.stringify({ rate, weeks }) });
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1500);
      } catch (err) {
        if (err.status === 401) logout();
        else setSaveState("error");
      }
    }, 700);
    return () => clearTimeout(saveTimer.current);
  }, [rate, weeks, stage]);

  const monday = parseKey(currentKey);
  const week = weeks[currentKey] || emptyWeek();
  const total = week.days.reduce((s, d) => s + (d.h || 0), 0);
  const pay = total * rate;
  const remaining = MAX_WEEK - total;

  const totalAnim = useCountUp(total);
  const payAnim = useCountUp(pay);

  useEffect(() => {
    if (total >= MAX_WEEK && wasBelowMax.current) {
      setBurst(true);
      setTimeout(() => setBurst(false), 1400);
    }
    wasBelowMax.current = total < MAX_WEEK;
  }, [total]);

  const todayKey = keyOf(mondayOf(new Date()));
  const todayIdx = currentKey === todayKey ? (new Date().getDay() + 6) % 7 : -1;

  const setDay = useCallback(
    (idx, patch) => {
      setWeeks((w) => {
        const wk = w[currentKey]
          ? { days: w[currentKey].days.map((d) => ({ ...d })) }
          : emptyWeek();
        wk.days[idx] = { ...wk.days[idx], ...patch };
        return { ...w, [currentKey]: wk };
      });
    },
    [currentKey]
  );
  const bump = (idx, delta) => {
    const h = Math.max(0, Math.min(24, Math.round(((week.days[idx].h || 0) + delta) * 4) / 4));
    setDay(idx, { h });
  };
  const nav = (dir) => setCurrentKey(keyOf(addDays(monday, dir * 7)));

  const allWeeks = useMemo(() => {
    return Object.entries(weeks)
      .map(([k, w]) => {
        const t = w.days.reduce((s, d) => s + (d.h || 0), 0);
        return { key: k, total: t, pay: t * rate };
      })
      .filter((w) => w.total > 0)
      .sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [weeks, rate]);
  const grandHours = allWeeks.reduce((s, w) => s + w.total, 0);
  const grandPay = grandHours * rate;
  const grandPayAnim = useCountUp(grandPay);

  const months = useMemo(() => {
    const map = {};
    for (const [k, w] of Object.entries(weeks)) {
      const mon = parseKey(k);
      w.days.forEach((d, i) => {
        if (!d.h && !d.note) return;
        const date = addDays(mon, i);
        const mk = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        if (!map[mk]) map[mk] = { key: mk, hours: 0, entries: [], weekMap: {} };
        map[mk].hours += d.h || 0;
        map[mk].entries.push({ date, h: d.h || 0, note: d.note || "" });
        const wm = map[mk].weekMap;
        if (!wm[k]) wm[k] = { wk: isoWeek(mon), range: fmtRange(mon), hours: 0 };
        wm[k].hours += d.h || 0;
      });
    }
    return Object.values(map)
      .map((m) => ({
        ...m,
        entries: m.entries.sort((a, b) => a.date - b.date),
        weeksSummary: Object.entries(m.weekMap)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, v]) => v),
      }))
      .sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [weeks]);
  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

  const exportFiche = (m) => {
    downloadPdf(
      `fiche-de-paie-${m.key}.pdf`,
      makeFichePdf({
        monthKey: m.key,
        entries: m.entries.filter((e) => e.h > 0),
        weeksSummary: m.weeksSummary,
        totalHours: m.hours,
        rate,
        email,
      })
    );
  };

  if (stage === "checking") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#FDFDFB" }}>
        <style>{CSS}</style>
        <Flower />
      </div>
    );
  }

  if (stage === "anon") {
    return (
      <>
        <style>{CSS}</style>
        <AuthScreen onAuthed={onAuthed} />
      </>
    );
  }

  return (
    <div className="isc-root">
      <style>{CSS}</style>

      <div className="isc-bg" aria-hidden="true">
        {PETALS.slice(0, 5).map((p, i) => (
          <span key={i} className={`bgp bgp${i}`} style={{ background: p }} />
        ))}
      </div>

      {burst && (
        <div className="isc-burst" aria-hidden="true">
          {Array.from({ length: 14 }).map((_, i) => (
            <span
              key={i}
              style={{
                background: PETALS[i % 5],
                "--tx": `${(Math.random() - 0.5) * 320}px`,
                "--ty": `${-80 - Math.random() * 220}px`,
                animationDelay: `${Math.random() * 0.15}s`,
              }}
            />
          ))}
        </div>
      )}

      <header className="isc-header">
        <div className="isc-brand">
          <Flower />
          <div>
            <div className="isc-wordmark">
              ISC hour tracker <span className="pi">π</span>
            </div>
            <div className="isc-sub">Informatique et systèmes de communication · 40 h max / week</div>
          </div>
        </div>

        <div className="isc-settings">
          <label className="isc-rate">
            <span>Hourly rate</span>
            <div className="isc-rate-box">
              <span className="chf">CHF</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={rate}
                onChange={(e) => setRate(Math.max(0, parseFloat(e.target.value) || 0))}
              />
            </div>
          </label>
          <div className="isc-actions">
            <a className="isc-btn ghost" href={HES_URL} target="_blank" rel="noopener noreferrer">
              Saisie HES-SO ↗
            </a>
            <span className="isc-account" title={email}>
              {email}
            </span>
            <button className="isc-btn ghost" onClick={logout}>Log out</button>
          </div>
          <div className={"isc-save " + saveState}>
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
              ? "✓ Saved"
              : saveState === "error"
              ? "⚠ Not saved — check connection"
              : ""}
          </div>
        </div>
      </header>

      <nav className="isc-tabs">
        {[
          ["week", "Week"],
          ["months", "Months"],
          ["all", "All weeks"],
        ].map(([id, label]) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
            {label}
            {id === "months" && months.length > 0 && <em>{months.length}</em>}
            {id === "all" && allWeeks.length > 0 && <em>{allWeeks.length}</em>}
          </button>
        ))}
      </nav>

      {view === "week" && (
        <main className="isc-main" key={currentKey}>
          <div className="isc-weeknav">
            <button className="isc-arrow" onClick={() => nav(-1)} aria-label="Previous week">←</button>
            <div className="isc-weektitle">
              <span className="wk">Week {String(isoWeek(monday)).padStart(2, "0")}</span>
              <span className="range">{fmtRange(monday)}</span>
              {currentKey !== todayKey && (
                <button className="isc-today" onClick={() => setCurrentKey(todayKey)}>
                  Back to this week
                </button>
              )}
            </div>
            <button className="isc-arrow" onClick={() => nav(1)} aria-label="Next week">→</button>
          </div>

          <section className="isc-summary">
            <Ring total={total} />
            <div className="isc-numbers">
              <div className="pair">
                <div className="big">
                  {trimH(totalAnim)}
                  <span className="unit"> h</span>
                </div>
                <div className="small">logged this week</div>
              </div>
              <div className="pair">
                <div className={"big " + (remaining <= 0 ? "max" : "")}>
                  {remaining > 0 ? hhmm(remaining) : "0:00"}
                </div>
                <div className="small">
                  {remaining > 0 ? (
                    "remaining until 40 h max"
                  ) : (
                    <span className="max">
                      40 h limit reached{total > MAX_WEEK ? ` (+${hhmm(total - MAX_WEEK)} over)` : ""}
                    </span>
                  )}
                </div>
              </div>
              <div className="pair">
                <div className="big pay">{chf(payAnim)}</div>
                <div className="small">estimated pay · flat rate</div>
              </div>
            </div>
          </section>

          <section className="isc-gauge-wrap">
            <Gauge days={week.days} />
            <div className="isc-ticks">
              {[0, 8, 16, 24, 32, 40].map((t) => (
                <span key={t} style={{ left: `${(t / MAX_WEEK) * 100}%` }} className={t === 40 ? "limit" : ""}>
                  {t}
                </span>
              ))}
            </div>
          </section>

          <section className="isc-days">
            {week.days.map((d, i) => {
              const date = addDays(monday, i);
              const weekend = i >= 5;
              return (
                <div
                  className={"isc-day " + (weekend ? "weekend " : "") + (i === todayIdx ? "today" : "")}
                  key={i}
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <span className="petal-dot" style={{ background: PETALS[i] }} />
                  <div className="isc-day-id">
                    <span className="dname">{DAY_SHORT[i]}</span>
                    <span className="ddate">{fmtDay(date)}</span>
                    {i === todayIdx && <span className="today-pill">Today</span>}
                  </div>
                  <div className="isc-stepper">
                    <button onClick={() => bump(i, -0.5)} disabled={!d.h} aria-label={`Remove 30 min on ${DAY_NAMES[i]}`}>−</button>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="24"
                      step="0.25"
                      value={d.h || ""}
                      placeholder="0"
                      onChange={(e) => {
                        const v = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
                        setDay(i, { h: v });
                      }}
                    />
                    <button onClick={() => bump(i, 0.5)} aria-label={`Add 30 min on ${DAY_NAMES[i]}`}>+</button>
                    <button className="chip" onClick={() => setDay(i, { h: d.h === 8 ? 0 : 8 })}>8h</button>
                  </div>
                  <input
                    className="isc-note"
                    value={d.note}
                    maxLength={500}
                    placeholder={weekend ? "Weekend — anything to log?" : "What did you work on?"}
                    onChange={(e) => setDay(i, { note: e.target.value })}
                  />
                  <div className="isc-day-bar">
                    <div
                      className="fill"
                      style={{
                        width: `${Math.min((d.h / 12) * 100, 100)}%`,
                        background: d.h > 8.5 ? MAGENTA : PETALS[i],
                      }}
                    />
                  </div>
                  <div className="isc-day-h">{d.h ? trimH(d.h) + " h" : "—"}</div>
                </div>
              );
            })}
          </section>
        </main>
      )}

      {view === "months" && (
        <main className="isc-main">
          {months.length === 0 ? (
            <div className="isc-empty">
              Nothing tracked yet. Head to <button onClick={() => setView("week")}>Week</button> to log your first hours.
            </div>
          ) : (
            <section className="isc-months">
              {months.map((m, idx) => {
                const completed = m.key < currentMonthKey;
                const daysWorked = m.entries.filter((e) => e.h > 0).length;
                return (
                  <div className="isc-month-card" key={m.key} style={{ animationDelay: `${idx * 60}ms` }}>
                    <div className="mc-head">
                      <div>
                        <div className="mc-title">{monthLabel(m.key)}</div>
                        <div className="mc-sub">
                          {daysWorked} day{daysWorked === 1 ? "" : "s"} · {m.weeksSummary.length} week
                          {m.weeksSummary.length === 1 ? "" : "s"}
                          {completed ? <span className="mc-done">completed</span> : <span className="mc-live">in progress</span>}
                        </div>
                      </div>
                      <div className="mc-figures">
                        <div className="mc-h">{trimH(m.hours)} h</div>
                        <div className="mc-pay">{chf(m.hours * rate)}</div>
                      </div>
                    </div>
                    <div className="mc-weeks">
                      {m.weeksSummary.map((w, wi) => (
                        <div className="mc-week" key={wi}>
                          <span className="mc-wk">W{String(w.wk).padStart(2, "0")}</span>
                          <span className="mc-bar">
                            <span
                              className="mc-fill"
                              style={{
                                width: `${Math.min(w.hours / MAX_WEEK, 1) * 100}%`,
                                background: w.hours > MAX_WEEK ? MAGENTA : PETALS[wi % 5],
                              }}
                            />
                          </span>
                          <span className="mc-wh">{trimH(w.hours)} h</span>
                        </div>
                      ))}
                    </div>
                    <button className="isc-btn magenta" onClick={() => exportFiche(m)}>
                      ⤓ Fiche de paie (PDF)
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </main>
      )}

      {view === "all" && (
        <main className="isc-main">
          <section className="isc-grand">
            <div>
              <div className="big">
                {trimH(grandHours)}
                <span className="unit"> h</span>
              </div>
              <div className="small">tracked across {allWeeks.length} week{allWeeks.length === 1 ? "" : "s"}</div>
            </div>
            <div className="right">
              <div className="big pay">{chf(grandPayAnim)}</div>
              <div className="small">total earned</div>
            </div>
          </section>
          {allWeeks.length === 0 ? (
            <div className="isc-empty">
              No hours logged yet. Switch to <button onClick={() => setView("week")}>Week</button> and add your first entry.
            </div>
          ) : (
            <section className="isc-all">
              {allWeeks.map((w, idx) => {
                const m = parseKey(w.key);
                const over = w.total > MAX_WEEK;
                return (
                  <button
                    className="isc-week-row"
                    key={w.key}
                    style={{ animationDelay: `${idx * 40}ms` }}
                    onClick={() => {
                      setCurrentKey(w.key);
                      setView("week");
                    }}
                  >
                    <span className="wk">W{String(isoWeek(m)).padStart(2, "0")}</span>
                    <span className="range">{fmtRange(m)}</span>
                    <span className="mini">
                      <span
                        className="mini-fill"
                        style={{
                          width: `${Math.min(w.total / MAX_WEEK, 1) * 100}%`,
                          background: over ? MAGENTA : "#1D1D1B",
                        }}
                      />
                    </span>
                    <span className={"hours " + (over ? "max" : "")}>{trimH(w.total)} h</span>
                    <span className="money">{chf(w.pay)}</span>
                  </button>
                );
              })}
            </section>
          )}
        </main>
      )}

      <footer className="isc-footer">
        <span>ISC Hour Tracker · 40 h legal max (CH), no overtime pay</span>
        <a href={HES_URL} target="_blank" rel="noopener noreferrer">Official HES-SO time entry ↗</a>
      </footer>
    </div>
  );
}

/* ---------- logo flower ---------- */
function Flower() {
  const pos = [
    { c: "#E8D96E", x: 0, y: 22 },
    { c: "#6EC5E9", x: 4, y: 6 },
    { c: "#B08BC9", x: 20, y: 0 },
    { c: "#F096B4", x: 34, y: 8 },
    { c: "#8FD4C1", x: 36, y: 24 },
  ];
  return (
    <div className="isc-flower" aria-hidden="true">
      {pos.map((p, i) => (
        <span
          key={i}
          className="petal"
          style={{ background: p.c, left: p.x, top: p.y, animationDelay: `${0.08 * i}s` }}
        />
      ))}
      <span className="core" />
    </div>
  );
}

/* ---------- countdown ring ---------- */
function Ring({ total }) {
  const pct = Math.max(0, Math.min(1, total / MAX_WEEK));
  const R = 42;
  const C = 2 * Math.PI * R;
  const remaining = MAX_WEEK - total;
  const done = remaining <= 0;
  return (
    <div className={"isc-ring " + (done ? "done" : "")}>
      <svg viewBox="0 0 100 100" width="112" height="112">
        <defs>
          <linearGradient id="petalgrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6EC5E9" />
            <stop offset="35%" stopColor="#B08BC9" />
            <stop offset="70%" stopColor="#F096B4" />
            <stop offset="100%" stopColor="#8FD4C1" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={R} fill="none" stroke="#EFEFEA" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={done ? MAGENTA : "url(#petalgrad)"}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          transform="rotate(-90 50 50)"
          className="ring-fg"
        />
      </svg>
      <div className="ring-center">
        <span className="ring-val">{done ? "MAX" : hhmm(remaining)}</span>
        <span className="ring-lbl">{done ? "40 h reached" : "left"}</span>
      </div>
    </div>
  );
}

/* ---------- 40h gauge ---------- */
function Gauge({ days }) {
  const total = days.reduce((s, d) => s + (d.h || 0), 0);
  const scale = Math.max(total, MAX_WEEK);
  let acc = 0;
  const segs = days.map((d, i) => {
    const start = acc;
    acc += d.h || 0;
    return { i, start, h: d.h || 0 };
  });
  return (
    <div className="isc-gauge">
      {segs.map((s) => {
        if (!s.h) return null;
        const overStart = Math.max(s.start, MAX_WEEK);
        const regPart = Math.max(Math.min(s.start + s.h, MAX_WEEK) - s.start, 0);
        const otPart = Math.max(s.start + s.h - overStart, 0);
        return (
          <span key={s.i}>
            {regPart > 0 && (
              <div
                className="seg"
                title={`${DAY_NAMES[s.i]} · ${s.h} h`}
                style={{
                  left: `${(s.start / scale) * 100}%`,
                  width: `calc(${(regPart / scale) * 100}% - 3px)`,
                  background: PETALS[s.i],
                  animationDelay: `${s.i * 60}ms`,
                }}
              >
                {regPart / scale > 0.05 && <span>{DAY_SHORT[s.i][0]}</span>}
              </div>
            )}
            {otPart > 0 && (
              <div
                className="seg over"
                title={`${DAY_NAMES[s.i]} · beyond 40 h`}
                style={{
                  left: `${(overStart / scale) * 100}%`,
                  width: `calc(${(otPart / scale) * 100}% - 3px)`,
                }}
              />
            )}
          </span>
        );
      })}
      <div className="isc-limit" style={{ left: `${(MAX_WEEK / scale) * 100}%` }}>
        <span>40</span>
      </div>
    </div>
  );
}

/* ============================================================ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@500;600;700;800&display=swap');

:root{
  --paper:#FDFDFB;
  --ink:#1D1D1B;
  --magenta:#E5137D;
  --rail:#EFEFEA;
  --mid:#8A8A86;
  --line:#E4E4DE;
  --blue:#6EC5E9; --purple:#B08BC9; --pink:#F096B4; --mint:#8FD4C1; --yellow:#E8D96E;
}
*{box-sizing:border-box;margin:0}
html,body{background:#FDFDFB}
.isc-root{
  min-height:100vh;background:var(--paper);color:var(--ink);
  font-family:'Nunito',system-ui,sans-serif;font-size:14px;
  max-width:880px;margin:0 auto;padding:28px 20px 60px;position:relative;
}
button{font-family:inherit;cursor:pointer}
input{font-family:inherit;color:var(--ink)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2.5px solid var(--magenta);outline-offset:2px;border-radius:6px}

/* auth */
.isc-auth{min-height:100vh;display:grid;place-items:center;padding:20px;font-family:'Nunito',system-ui,sans-serif;color:var(--ink);position:relative}
.isc-auth-card{width:100%;max-width:400px;background:#fff;border:1.5px solid var(--line);border-radius:24px;padding:32px 28px;display:flex;flex-direction:column;align-items:center;animation:cardIn .5s cubic-bezier(.2,1.1,.3,1) both;box-shadow:0 20px 50px rgba(29,29,27,.06)}
.isc-auth-tabs{display:flex;gap:6px;background:var(--rail);border-radius:999px;padding:5px;margin-bottom:20px}
.isc-auth-tabs button{background:none;border:0;padding:7px 18px;font-weight:800;font-size:13px;color:var(--mid);border-radius:999px;transition:all .25s}
.isc-auth-tabs button.active{color:var(--ink);background:#fff;box-shadow:0 2px 8px rgba(29,29,27,.10)}
.isc-auth-card form{width:100%;display:flex;flex-direction:column;gap:14px}
.isc-auth-card label{display:flex;flex-direction:column;gap:5px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--mid)}
.isc-auth-card input{border:2px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px;font-weight:600;transition:border-color .2s}
.isc-auth-card input:focus{border-color:var(--magenta);outline:none}
.isc-auth-error{background:#FDECF4;color:var(--magenta);font-weight:700;font-size:12.5px;padding:9px 12px;border-radius:10px;animation:shake .35s ease}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
.isc-btn.solid{background:var(--magenta);color:#fff;border-color:var(--magenta);justify-content:center;padding:11px;font-size:14px}
.isc-btn.solid:hover{background:#C90F6C;border-color:#C90F6C;color:#fff}
.isc-btn.solid:disabled{opacity:.6;cursor:default;transform:none}

/* floating background petals */
.isc-bg{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0}
.isc-bg .bgp{position:absolute;width:220px;height:220px;border-radius:50%;opacity:.10;filter:blur(30px);animation:drift 26s ease-in-out infinite alternate}
.bgp0{top:-60px;left:-40px}
.bgp1{top:20%;right:-80px;animation-delay:-6s}
.bgp2{bottom:10%;left:10%;animation-delay:-12s}
.bgp3{bottom:-70px;right:20%;animation-delay:-18s}
.bgp4{top:45%;left:40%;animation-delay:-9s;width:160px;height:160px}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(40px,-50px) scale(1.15)}}
.isc-header,.isc-tabs,.isc-main,.isc-footer{position:relative;z-index:1}

/* petal burst */
.isc-burst{position:fixed;left:50%;top:45%;z-index:50;pointer-events:none}
.isc-burst span{position:absolute;width:14px;height:14px;border-radius:50% 50% 50% 0;animation:burst 1.2s cubic-bezier(.2,.8,.4,1) forwards}
@keyframes burst{from{transform:translate(0,0) rotate(0) scale(1);opacity:1}to{transform:translate(var(--tx),var(--ty)) rotate(300deg) scale(.4);opacity:0}}

/* header */
.isc-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.isc-brand{display:flex;gap:14px;align-items:center}
.isc-flower{position:relative;width:60px;height:52px;flex:none}
.isc-flower .petal{position:absolute;width:26px;height:26px;border-radius:50%;opacity:.88;animation:bloom .7s cubic-bezier(.2,1.5,.4,1) both;transition:transform .35s}
.isc-flower:hover .petal{transform:scale(1.12) rotate(10deg)}
.isc-flower .core{position:absolute;left:19px;top:20px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.04);animation:bloom .7s .35s cubic-bezier(.2,1.5,.4,1) both}
@keyframes bloom{from{transform:scale(0) rotate(-120deg)}to{transform:scale(1) rotate(0)}}
.isc-wordmark{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:22px;letter-spacing:-.01em;line-height:1;display:flex;align-items:center;gap:8px}
.isc-wordmark .pi{display:inline-grid;place-items:center;width:24px;height:24px;background:var(--magenta);color:#fff;border-radius:6px;font-size:15px;animation:piIn .5s .4s cubic-bezier(.2,1.6,.4,1) both;transition:transform .25s}
.isc-wordmark:hover .pi{transform:rotate(180deg)}
@keyframes piIn{from{transform:scale(0) rotate(90deg)}to{transform:scale(1) rotate(0)}}
.isc-sub{color:var(--mid);font-size:12px;margin-top:4px;font-weight:600}
.isc-settings{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.isc-rate{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.isc-rate-box{display:flex;align-items:center;border:2px solid var(--ink);border-radius:12px;background:#fff;overflow:hidden}
.isc-rate-box .chf{font-size:11px;font-weight:800;padding:0 8px;background:var(--ink);color:#fff;align-self:stretch;display:flex;align-items:center}
.isc-rate-box input{border:0;width:64px;padding:7px 8px;font-weight:800;font-size:14px;background:transparent}
.isc-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center}
.isc-account{font-size:12px;font-weight:700;color:var(--mid);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isc-btn{border:2px solid var(--ink);background:#fff;border-radius:999px;padding:7px 14px;font-size:12px;font-weight:800;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;gap:5px;transition:transform .15s cubic-bezier(.2,1.5,.4,1), background .15s, color .15s, box-shadow .15s}
.isc-btn:hover{background:var(--ink);color:#fff;transform:translateY(-2px);box-shadow:0 4px 0 rgba(29,29,27,.15)}
.isc-btn:active{transform:translateY(0) scale(.96)}
.isc-btn.magenta{border-color:var(--magenta);color:var(--magenta)}
.isc-btn.magenta:hover{background:var(--magenta);color:#fff;box-shadow:0 4px 0 rgba(229,19,125,.2)}
.isc-save{font-size:12px;color:var(--magenta);font-weight:800;margin-top:22px;min-width:64px;opacity:0;transition:opacity .3s}
.isc-save.saving{opacity:.5;color:var(--mid)}
.isc-save.saved{opacity:1}
.isc-save.error{opacity:1;color:#C0392B}

/* tabs */
.isc-tabs{display:flex;gap:6px;background:var(--rail);border-radius:999px;padding:5px;width:fit-content;margin-bottom:24px}
.isc-tabs button{background:none;border:0;padding:8px 18px;font-weight:800;font-size:13px;color:var(--mid);border-radius:999px;transition:color .2s, background .25s cubic-bezier(.2,1.2,.4,1), transform .2s}
.isc-tabs button em{font-style:normal;font-size:11px;color:var(--magenta);margin-left:5px}
.isc-tabs button:hover{color:var(--ink)}
.isc-tabs button.active{color:var(--ink);background:#fff;box-shadow:0 2px 8px rgba(29,29,27,.10);transform:scale(1.03)}

/* main */
.isc-main{animation:fadeUp .4s cubic-bezier(.2,.9,.3,1) both}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}

/* week nav */
.isc-weeknav{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}
.isc-arrow{width:42px;height:42px;border:2px solid var(--ink);border-radius:50%;background:#fff;font-size:17px;font-weight:800;transition:background .15s,color .15s,transform .2s cubic-bezier(.2,1.6,.4,1)}
.isc-arrow:hover{background:var(--ink);color:#fff;transform:scale(1.1)}
.isc-arrow:active{transform:scale(.9)}
.isc-weektitle{text-align:center;display:flex;flex-direction:column;align-items:center;gap:2px}
.isc-weektitle .wk{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:26px;line-height:1.1}
.isc-weektitle .range{color:var(--mid);font-size:13px;font-weight:600}
.isc-today{margin-top:6px;border:0;background:var(--magenta);color:#fff;font-size:11px;padding:5px 12px;font-weight:800;border-radius:999px;transition:transform .2s cubic-bezier(.2,1.6,.4,1),box-shadow .2s}
.isc-today:hover{transform:translateY(-2px);box-shadow:0 4px 10px rgba(229,19,125,.35)}

/* summary */
.isc-summary{display:flex;align-items:center;gap:26px;margin-bottom:20px;flex-wrap:wrap}
.isc-ring{position:relative;flex:none;animation:popIn .6s cubic-bezier(.2,1.4,.4,1) both}
@keyframes popIn{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
.isc-ring .ring-fg{transition:stroke-dashoffset .6s cubic-bezier(.4,0,.2,1), stroke .3s}
.isc-ring.done svg{animation:ringPulse 1.4s ease-in-out infinite}
@keyframes ringPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
.ring-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
.ring-val{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:21px;font-variant-numeric:tabular-nums}
.isc-ring.done .ring-val{color:var(--magenta)}
.ring-lbl{font-size:10px;color:var(--mid);font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.isc-numbers{display:flex;gap:34px;flex-wrap:wrap;align-items:flex-end}
.isc-numbers .big{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:34px;line-height:1;font-variant-numeric:tabular-nums}
.isc-numbers .big .unit{font-size:19px;color:var(--mid)}
.isc-numbers .big.pay{font-size:24px}
.isc-numbers .small{color:var(--mid);font-size:12px;margin-top:5px;font-weight:600}
.max{color:var(--magenta)!important;font-weight:800}

/* gauge */
.isc-gauge-wrap{margin-bottom:28px}
.isc-gauge{position:relative;height:42px;background:var(--rail);border-radius:999px;overflow:hidden}
.isc-gauge .seg{position:absolute;top:4px;bottom:4px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--ink);font-size:11px;font-weight:800;transition:left .5s cubic-bezier(.4,0,.2,1), width .5s cubic-bezier(.4,0,.2,1), filter .2s;animation:segIn .55s cubic-bezier(.2,1.4,.4,1) both;transform-origin:left center}
.isc-gauge .seg:hover{filter:saturate(1.4) brightness(.96)}
.isc-gauge .seg.over{background:var(--magenta)}
@keyframes segIn{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.isc-limit{position:absolute;top:-2px;bottom:-2px;width:3px;border-radius:2px;background:var(--magenta);transition:left .5s cubic-bezier(.4,0,.2,1)}
.isc-limit span{position:absolute;top:0;left:6px;font-size:10px;color:var(--magenta);font-weight:800}
.isc-ticks{position:relative;height:18px;margin-top:7px}
.isc-ticks span{position:absolute;transform:translateX(-50%);font-size:10px;color:var(--mid);font-weight:700;font-variant-numeric:tabular-nums}
.isc-ticks span.limit{color:var(--magenta)}

/* day rows */
.isc-days{display:flex;flex-direction:column;gap:8px}
.isc-day{display:grid;grid-template-columns:14px 88px auto 1fr 90px 52px;gap:12px;align-items:center;padding:11px 14px;background:#fff;border:1.5px solid var(--line);border-radius:16px;animation:rowIn .45s cubic-bezier(.2,1,.3,1) both;transition:transform .2s, box-shadow .2s, border-color .2s}
.isc-day:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(29,29,27,.07);border-color:transparent}
@keyframes rowIn{from{opacity:0;transform:translateX(-14px)}to{opacity:1;transform:none}}
.isc-day.weekend{background:#FAFAF6}
.isc-day.today{border-color:var(--magenta)}
.petal-dot{width:12px;height:12px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);transition:transform .3s cubic-bezier(.2,1.6,.4,1)}
.isc-day:hover .petal-dot{transform:rotate(315deg) scale(1.2)}
.isc-day-id{display:flex;flex-direction:column}
.isc-day-id .dname{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:14px}
.isc-day-id .ddate{color:var(--mid);font-size:11px;font-weight:600}
.today-pill{margin-top:3px;background:var(--magenta);color:#fff;font-size:9px;font-weight:800;letter-spacing:.08em;padding:2px 8px;border-radius:999px;width:fit-content;text-transform:uppercase;animation:pillPop .4s .3s cubic-bezier(.2,1.6,.4,1) both}
@keyframes pillPop{from{transform:scale(0)}to{transform:scale(1)}}
.isc-stepper{display:flex;align-items:center;gap:5px}
.isc-stepper button{width:30px;height:30px;border:2px solid var(--ink);border-radius:10px;background:#fff;font-size:15px;font-weight:800;transition:background .12s,color .12s,transform .18s cubic-bezier(.2,1.6,.4,1)}
.isc-stepper button:hover:not(:disabled){background:var(--ink);color:#fff;transform:scale(1.1)}
.isc-stepper button:active:not(:disabled){transform:scale(.85)}
.isc-stepper button:disabled{border-color:var(--line);color:var(--line);cursor:default}
.isc-stepper input{width:58px;height:30px;text-align:center;border:2px solid var(--ink);border-radius:10px;font-weight:800;font-size:14px;background:#fff;font-variant-numeric:tabular-nums;-moz-appearance:textfield}
.isc-stepper input::-webkit-inner-spin-button{-webkit-appearance:none}
.isc-stepper .chip{width:auto;padding:0 10px;font-size:11px;border-color:var(--line);color:var(--mid);border-radius:999px}
.isc-stepper .chip:hover{border-color:var(--ink)}
.isc-note{border:0;border-bottom:2px dashed var(--line);background:transparent;padding:6px 2px;font-size:13px;font-weight:600;transition:border-color .2s;min-width:0}
.isc-note::placeholder{color:#C4C4BC;font-weight:500}
.isc-note:focus{border-bottom:2px solid var(--magenta);outline:none}
.isc-day-bar{height:9px;background:var(--rail);border-radius:999px;overflow:hidden}
.isc-day-bar .fill{height:100%;border-radius:999px;transition:width .45s cubic-bezier(.4,0,.2,1), background .3s}
.isc-day-h{font-size:12px;font-weight:800;text-align:right;color:var(--mid);font-variant-numeric:tabular-nums}

/* months */
.isc-months{display:flex;flex-direction:column;gap:16px}
.isc-month-card{background:#fff;border:1.5px solid var(--line);border-radius:20px;padding:20px;animation:cardIn .5s cubic-bezier(.2,1.1,.3,1) both;transition:box-shadow .25s, transform .25s}
.isc-month-card:hover{box-shadow:0 10px 26px rgba(29,29,27,.08);transform:translateY(-3px)}
@keyframes cardIn{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
.mc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.mc-title{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:21px}
.mc-sub{color:var(--mid);font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mc-done,.mc-live{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;padding:2px 9px;border-radius:999px}
.mc-done{background:var(--mint);color:var(--ink)}
.mc-live{background:var(--yellow);color:var(--ink)}
.mc-figures{text-align:right}
.mc-h{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:24px;line-height:1}
.mc-pay{color:var(--magenta);font-weight:800;font-size:14px;margin-top:2px}
.mc-weeks{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}
.mc-week{display:grid;grid-template-columns:44px 1fr 56px;gap:10px;align-items:center;font-size:12px;font-weight:700}
.mc-wk{color:var(--mid)}
.mc-bar{height:9px;background:var(--rail);border-radius:999px;overflow:hidden;display:block}
.mc-fill{display:block;height:100%;border-radius:999px}
.mc-wh{text-align:right;font-variant-numeric:tabular-nums}

/* all weeks */
.isc-grand{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px;padding:18px 20px;background:#fff;border:1.5px solid var(--line);border-radius:20px}
.isc-grand .big{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:34px;line-height:1}
.isc-grand .big .unit{font-size:18px;color:var(--mid)}
.isc-grand .big.pay{font-size:23px;color:var(--magenta)}
.isc-grand .right{text-align:right}
.isc-grand .small{color:var(--mid);font-size:12px;margin-top:5px;font-weight:600}
.isc-all{display:flex;flex-direction:column;gap:8px}
.isc-week-row{display:grid;grid-template-columns:52px 1fr 130px 66px 108px;gap:12px;align-items:center;padding:13px 16px;border:1.5px solid var(--line);border-radius:14px;background:#fff;text-align:left;font-size:13px;font-weight:600;animation:rowIn .4s cubic-bezier(.2,1,.3,1) both;transition:transform .2s, box-shadow .2s, border-color .2s}
.isc-week-row:hover{transform:translateY(-2px) scale(1.005);box-shadow:0 6px 16px rgba(29,29,27,.07);border-color:transparent}
.isc-week-row .wk{font-family:'Baloo 2',sans-serif;font-weight:800;font-size:15px}
.isc-week-row .range{color:var(--mid)}
.isc-week-row .mini{position:relative;height:9px;background:var(--rail);border-radius:999px;display:block;overflow:hidden}
.isc-week-row .mini-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px}
.isc-week-row .hours{font-weight:800;text-align:right;font-variant-numeric:tabular-nums}
.isc-week-row .money{font-weight:800;text-align:right;font-variant-numeric:tabular-nums}
.isc-empty{padding:44px 0;color:var(--mid);text-align:center;font-weight:600}
.isc-empty button{border:0;background:none;color:var(--magenta);font-weight:800;text-decoration:underline;padding:0}

.isc-footer{margin-top:44px;padding-top:14px;border-top:1.5px solid var(--line);color:var(--mid);font-size:11px;font-weight:600;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.isc-footer a{color:var(--magenta);font-weight:800;text-decoration:none}
.isc-footer a:hover{text-decoration:underline}

/* responsive */
@media(max-width:700px){
  .isc-day{grid-template-columns:14px 74px auto 52px;grid-template-rows:auto auto;row-gap:9px}
  .isc-note{grid-column:1/5;grid-row:2}
  .isc-day-bar{display:none}
  .isc-day-h{grid-row:1}
  .isc-week-row{grid-template-columns:44px 1fr 58px 90px}
  .isc-week-row .mini{display:none}
  .isc-numbers{gap:20px}
  .isc-numbers .big{font-size:26px}
  .isc-numbers .big.pay{font-size:19px}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
`;
