/* Training Hub engine: shared by the page and the scheduled runs. Pure functions, no I/O. */
(function (root) {
  const E = {};
  const r1 = x => Math.round(x * 10) / 10;
  const clip = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  E.addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  E.mondayOf = d => { const t = new Date(d + "T12:00:00Z"); const wd = (t.getUTCDay() + 6) % 7; return E.addDays(d, -wd); };
  // Personal settings (config/settings in the hub database overrides these defaults; see applySettings)
  E.DEFAULTS = { hr: [114, 143, 157, 171], ftp: 164, kcalBase: 1800, waterBase: 60, fallbackLb: 165, hrvMax: 150, weightFrom: "2025-09-01", lossGoalLbWk: 1 };
  E.powerZones = ftp => [0.55, 0.75, 0.9, 1.05, 1.2, 1.5].map(f => Math.round(ftp * f)); // Coggan zone tops
  E.applySettings = function (s) {
    const v = Object.assign({}, E.DEFAULTS); for (const k of Object.keys(v)) if (s && s[k] != null && s[k] !== "") v[k] = s[k];
    E.SET = v; E.ZONES = { hr: v.hr, power: E.powerZones(v.ftp), ftp: v.ftp }; return v;
  };
  E.applySettings(null);
  E.zoneText = function () {
    const h = E.ZONES.hr, p = E.ZONES.power;
    return `HR Z1 <=${h[0]}, Z2 ${h[0] + 1}-${h[1]}, Z3 ${h[1] + 1}-${h[2]}, Z4 ${h[2] + 1}-${h[3]}, Z5 ${h[3] + 1}+. Bike power (FTP ${E.ZONES.ftp} W) Z1 <=${p[0]}, Z2 ${p[0] + 1}-${p[1]}, Z3 ${p[1] + 1}-${p[2]}, Z4 ${p[2] + 1}-${p[3]}, Z5 ${p[3] + 1}-${p[4]}, Z6 ${p[4] + 1}-${p[5]}, Z7 ${p[5] + 1}+. Power and watts apply to cycling only; never use power or watts for runs (use HR and pace).`;
  };
  // Seconds in each HR zone from a time + heart_rate stream
  E.zoneSecs = function (hr, time, edges) {
    const secs = new Array(edges.length + 1).fill(0);
    for (let i = 1; i < hr.length; i++) { const v = hr[i], dt = time[i] - time[i - 1]; if (v == null || !v || dt <= 0 || dt > 30) continue; let z = edges.findIndex(e => v <= e); if (z < 0) z = edges.length; secs[z] += dt; }
    return secs;
  };
  // Intensity mix from cached per-activity zone seconds: easy = Z1-2, moderate = Z3, hard = Z4-5
  E.intensityMix = function (entries) {
    const t = [0, 0, 0, 0, 0]; let n = 0;
    for (const e of entries) if (e && e.secs) { n++; e.secs.forEach((s, i) => t[i] += s); }
    const tot = t.reduce((a, b) => a + b, 0); if (!tot) return null;
    const pc = x => Math.round(x / tot * 100);
    return { easy: pc(t[0] + t[1]), moderate: pc(t[2]), hard: pc(t[3] + t[4]), hours: Math.round(tot / 360) / 10, sessions: n };
  };

  // ---------- Health export parsing ----------
  function csvRows(text) {
    return text.replace(/\r/g, "").split("\n").filter(l => l.trim()).map(l => l.split(","));
  }
  // One daily HealthMetrics-YYYY-MM-DD file -> one day doc
  E.parseDayCsv = function (text, date) {
    const rows = csvRows(text); const h = rows[0].map(x => x.trim());
    const col = k => h.findIndex(x => x.startsWith(k));
    const iHRV = col("Heart Rate Variability"), iRHR = col("Resting Heart Rate"), iTot = col("Sleep Analysis [Total]"),
      iAsl = col("Sleep Analysis [Asleep]"), iCore = col("Sleep Analysis [Core]"), iDeep = col("Sleep Analysis [Deep]"),
      iRem = col("Sleep Analysis [REM]"), iW = col("Weight");
    const num = (r, i) => { if (i < 0 || r[i] == null || r[i].trim() === "") return null; const v = parseFloat(r[i]); return isNaN(v) ? null : v; };
    const hrvs = [], dropped = []; let rhr = null, sleep = null, weight = null;
    for (const r of rows.slice(1)) {
      const ts = (r[0] || "").trim(); const tm = ts.split(" ")[1] || "0:00:00";
      const [hh, mm] = tm.split(":").map(Number); const mins = hh * 60 + mm;
      const v = num(r, iHRV);
      if (v != null && mins <= 8 * 60) { if (v > E.SET.hrvMax) dropped.push(v); else hrvs.push(v); }
      const rr = num(r, iRHR); if (rr != null && rhr == null && mins <= 10 * 60) rhr = rr;
      if (mins === 0) {
        let t = num(r, iTot); if (!t) t = num(r, iAsl);
        if (!t) { const s = [num(r, iCore), num(r, iDeep), num(r, iRem)].filter(x => x != null); if (s.length) t = s.reduce((a, b) => a + b, 0); }
        if (t) sleep = r1(t * 100) / 100;
      }
      const w = num(r, iW); if (w != null) weight = w;
    }
    return { date, hrv: hrvs.length >= 2 ? r1(median(hrvs)) : null, hrvN: hrvs.length, hrvDropped: dropped, hrvMethod: "night",
      rhr, sleep: sleep != null ? Math.round(sleep * 100) / 100 : null, weight: weight != null ? r1(weight) : null, src: "daily" };
  };
  // "Health metrics historical.csv" (one row per day) -> day docs
  E.parseHistoricalCsv = function (text) {
    const rows = csvRows(text); const h = rows[0].map(x => x.trim());
    const col = k => h.findIndex(x => x.startsWith(k));
    const iHRV = col("Heart Rate Variability"), iRHR = col("Resting Heart Rate"), iTot = col("Sleep Analysis [Total]"), iW = col("Weight");
    return rows.slice(1).map(r => {
      // weight is always the last field; legacy rows can carry a stray blank field before VO2/weight
      const g = i => { const v = parseFloat(r[i]); return isNaN(v) ? null : v; };
      const w = parseFloat(r[r.length - 1]);
      const s = g(iTot);
      return { date: r[0].slice(0, 10), hrv: g(iHRV), hrvN: null, hrvDropped: [], hrvMethod: "dayavg", rhr: g(iRHR),
        sleep: s && s > 2 ? Math.round(s * 100) / 100 : null, weight: isNaN(w) ? null : r1(w), src: "historical" };
    });
  };

  // ---------- Recovery score ----------
  // Weights: HRV 50 / RHR 25 / Sleep 25. HRV uses ln(HRV) z-scores against a 60-day personal baseline,
  // averaged between last night and the 7-day rolling mean (Plews et al.). Sleep blends a personal z-score
  // with an absolute 5h->0, 8h->100 scale (7-9 h guideline).
  E.WEIGHTS = { hrv: 0.5, rhr: 0.25, sleep: 0.25 };
  E.recovery = function (today, days) {
    const prior = days.filter(d => d.date < today.date && d.date >= E.addDays(today.date, -60));
    const night = prior.filter(d => d.hrv != null && d.hrvMethod === "night");
    const hrvBase = (night.length >= 7 ? night : prior.filter(d => d.hrv != null)).map(d => Math.log(d.hrv));
    const rhrBase = prior.filter(d => d.rhr != null).map(d => d.rhr);
    const slBase = prior.filter(d => d.sleep != null).map(d => d.sleep);
    const parts = {}; const out = { date: today.date, parts, baselineDays: { hrv: hrvBase.length, rhr: rhrBase.length, sleep: slBase.length } };
    if (today.hrv != null && hrvBase.length >= 5) {
      const m = mean(hrvBase), s = Math.max(sd(hrvBase), 0.05);
      const last7 = days.filter(d => d.date <= today.date && d.date > E.addDays(today.date, -7) && d.hrv != null && (night.length >= 7 ? d.hrvMethod === "night" : true)).map(d => Math.log(d.hrv));
      const zT = (Math.log(today.hrv) - m) / s, z7 = last7.length ? (mean(last7) - m) / s : zT;
      const z = 0.5 * zT + 0.5 * z7;
      parts.hrv = { value: today.hrv, base: r1(Math.exp(m)), z: r1(z), z7: r1(z7), score: Math.round(clip(50 + 20 * z, 0, 100)), n: today.hrvN, dropped: today.hrvDropped || [] };
    }
    if (today.rhr != null && rhrBase.length >= 5) {
      const m = mean(rhrBase), s = Math.max(sd(rhrBase), 1.5); const z = (m - today.rhr) / s;
      parts.rhr = { value: today.rhr, base: r1(m), z: r1(z), score: Math.round(clip(50 + 20 * z, 0, 100)) };
    }
    if (today.sleep != null) {
      const abs = clip((today.sleep - 5) / 3 * 100, 0, 100);
      let rel = abs, z = null;
      if (slBase.length >= 5) { const m = mean(slBase), s = Math.max(sd(slBase), 0.4); z = (today.sleep - m) / s; rel = clip(50 + 20 * z, 0, 100); parts.sleepBase = r1(m); }
      parts.sleep = { value: today.sleep, base: parts.sleepBase ?? null, z: z == null ? null : r1(z), score: Math.round(0.5 * abs + 0.5 * rel) };
      delete parts.sleepBase;
    }
    let wsum = 0, ssum = 0;
    for (const k of ["hrv", "rhr", "sleep"]) if (parts[k]) { wsum += E.WEIGHTS[k]; ssum += E.WEIGHTS[k] * parts[k].score; }
    out.score = wsum ? Math.round(ssum / wsum) : null;
    // Readiness follows HRV-guided training (Kiviniemi, Vesterinen, Javaloyes, Plews): 7-day ln-HRV vs baseline, normal = no more than 0.5 SD below;
    // then one level down if resting HR is 5+ bpm over baseline or sleep was under 6 h. The 0-100 score is shown but no longer sets the level.
    const why = []; let L = parts.hrv ? (parts.hrv.z7 >= -0.5 ? 2 : parts.hrv.z7 >= -1 ? 1 : 0) : (out.score == null ? -1 : 2);
    if (parts.hrv) why.push(parts.hrv.z7 >= -0.5 ? "7-day HRV is within or above your normal range" : `7-day HRV is ${Math.abs(parts.hrv.z7)} SD below your baseline`);
    const down = [];
    if (parts.rhr && parts.rhr.value - parts.rhr.base >= 5) down.push(`resting HR ${Math.round(parts.rhr.value - parts.rhr.base)} bpm above baseline`);
    if (parts.sleep && parts.sleep.value < 6) down.push(`only ${parts.sleep.value.toFixed(1)} h of sleep`);
    if (L > 0 && down.length) { L -= 1; why.push("one level lower for " + down.join(" and ")); }
    out.band = L < 0 ? "none" : ["low", "moderate", "good"][L]; out.why = why.join("; ");
    out.missing = ["hrv", "rhr", "sleep"].filter(k => !parts[k]);
    return out;
  };

  // ---------- Fitness / Fatigue / Form (TrainingPeaks PMC math on Strava relative effort; bike power when available) ----------
  // Sessions recorded without heart rate have no relative effort. Estimate their load from your own
  // median effort per minute for that sport (falls back to conservative defaults until 3 sessions exist).
  const EST_DEFAULT = { strength: 0.4, swim: 0.8, row: 0.9, run: 1, bike: 0.8, other: 0.5 };
  // Rides with power: power-based load (hours x IF^2 x 100, from normalized power and the FTP in effect that day),
  // converted to the relative-effort scale with your own median RE-per-power-load ratio from rides that have both.
  // Needs 5 such rides; until then rides keep relative effort. Runs and swims never use power.
  // pw = { <activity id>: { np, sec, ftp } } (meta/power rides).
  E.tss = p => p && p.np > 0 && p.sec > 0 && p.ftp > 0 ? p.sec / 3600 * (p.np / p.ftp) ** 2 * 100 : 0;
  // Normalized power from a watts + time stream: 30 s rolling average, 4th-power mean
  E.np = function (w, t) {
    if (!w || !t || w.length < 10 || !w.some(x => x > 0)) return null;
    const r = []; let j = 0, s = 0;
    for (let i = 0; i < w.length; i++) { s += w[i] || 0; while (t[i] - t[j] >= 30) { s -= w[j] || 0; j++; } if (t[i] - t[0] >= 30) r.push(s / (i - j + 1)); }
    return r.length ? Math.round(Math.pow(r.reduce((a, x) => a + x ** 4, 0) / r.length, 0.25)) : null;
  };
  E.powerScale = function (acts, pw) {
    if (!pw) return null; const pairs = [];
    for (const a of acts) { const t = E.sportOf(a.type) === "bike" ? E.tss(pw[String(a.id)]) : 0; if (t >= 10 && a.re > 0) pairs.push(a.re / t); }
    return pairs.length >= 5 ? median(pairs) : null;
  };
  E.withLoadEstimates = function (acts, pw) {
    const rate = {}, k = E.powerScale(acts, pw);
    for (const a of acts) if (a.re > 0 && a.min >= 5) (rate[E.sportOf(a.type)] = rate[E.sportOf(a.type)] || []).push(a.re / a.min);
    return acts.map(a => {
      const t = k && E.sportOf(a.type) === "bike" ? E.tss(pw[String(a.id)]) : 0;
      if (t > 0) return { ...a, pwLoad: Math.round(k * t) };
      if (a.re > 0 || !(a.min > 0)) return a;
      const sp = E.sportOf(a.type), r = rate[sp] && rate[sp].length >= 3 ? median(rate[sp]) : EST_DEFAULT[sp] ?? EST_DEFAULT.other;
      return { ...a, reEst: Math.round(r * a.min) };
    });
  };
  E.loadOf = a => a.pwLoad ?? (a.re || a.reEst || 0);
  E.dailyLoads = function (acts, pw) { const m = {}; for (const a of E.withLoadEstimates(acts, pw)) { const d = a.date; m[d] = (m[d] || 0) + E.loadOf(a); } return m; };
  // Seeded walk: from seed {asOf, ctl, atl} (values at end of asOf) through endDate
  E.pmc = function (loads, startDate, endDate, seed) {
    let ctl = seed ? seed.ctl : 0, atl = seed ? seed.atl : 0; const out = [];
    for (let d = seed ? E.addDays(seed.asOf, 1) : startDate; d <= endDate; d = E.addDays(d, 1)) {
      const L = loads[d] || 0; ctl += (L - ctl) / 42; atl += (L - atl) / 7;
      out.push({ date: d, load: L, ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) });
    }
    return out;
  };
  // Today's form = yesterday's CTL - yesterday's ATL (TrainingPeaks convention)
  E.FORM_KEY = [
    { key: "veryfresh", label: "Very fresh", range: "above +6" },
    { key: "fresh", label: "Fresh", range: "−7 to +6" },
    { key: "neutral", label: "Neutral", range: "−17 to −7" },
    { key: "building", label: "Building", range: "−27 to −17" },
    { key: "risk", label: "High risk", range: "below −27" }];
  E.formBand = tsb => tsb > 6 ? { key: "veryfresh", label: "Very fresh", tone: "info", note: "Well rested, close to tapered. Good for a race or key session; fitness fades if it lasts weeks." }
    : tsb >= -7 ? { key: "fresh", label: "Fresh", tone: "good", note: "Recovered. Normal training, including hard sessions, is fine." }
    : tsb >= -17 ? { key: "neutral", label: "Neutral", tone: "good", note: "Carrying normal training fatigue. Keep easy days easy." }
    : tsb >= -27 ? { key: "building", label: "Building", tone: "warn", note: "Productive overload. Protect sleep and fueling; hold back on extra intensity." }
    : { key: "risk", label: "High risk", tone: "bad", note: "Fatigue is outrunning fitness. Back off until Form climbs above −27." };

  // ---------- Plan adjustment rules ----------
  // Day after a big effort: a 10K+ run, any triathlon leg, or a 30+ mi ride
  E.bigEffort = function (acts, date) {
    const y = E.addDays(date, -1);
    return acts.filter(a => a.date === y && ((E.sportOf(a.type) === "run" && a.km >= 9.9) || (E.sportOf(a.type) === "bike" && a.km >= 48.3) || /triathlon|\btri\b/i.test(a.name || "")))
      .map(a => `${a.name} (${E.sportOf(a.type) === "bike" ? (a.km / 1.609).toFixed(0) + " mi" : a.km.toFixed(1) + " km"})`);
  };
  // Race within 10 days
  E.racesSoon = (races, date) => (races || []).filter(r => r.date >= date && r.date <= E.addDays(date, 10)).map(r => ({ ...r, days: Math.round((new Date(r.date) - new Date(date)) / 864e5) }));
  // Fatigue carryover screen: same-sport sessions in the last 3 days that ran notably slow or costly vs the 4-60 day norm
  E.fatigueScreen = function (acts, date) {
    const out = [];
    for (const a of acts.filter(x => x.date >= E.addDays(date, -3) && x.date < date && ["run", "bike", "swim"].includes(E.sportOf(x.type)) && x.km > 0 && x.min > 10)) {
      const sp = E.sportOf(a.type);
      const norm = acts.filter(x => E.sportOf(x.type) === sp && x.date < E.addDays(date, -3) && x.date >= E.addDays(date, -60) && x.km > 0 && x.min >= a.min * 0.5 && x.min <= a.min * 2);
      if (norm.length < 3) continue;
      const spd = x => x.km / x.min, cost = x => (x.re || 0) / x.min;
      const mSpd = median(norm.map(spd)), mCost = median(norm.map(cost));
      const climb = x => (x.elev || 0) / Math.max(x.km, 0.1), mClimb = median(norm.map(climb));
      const hilly = climb(a) > mClimb * 1.5 + 5; // a climbing day is slow by design; judge it on effort cost only
      const slow = !hilly && spd(a) <= mSpd * 0.88, costly = !hilly && mCost > 0 && cost(a) >= mCost * 1.4;
      if (slow || costly) out.push({ sport: sp, date: a.date, id: a.id, name: a.name, why: [slow ? `${Math.round((1 - spd(a) / mSpd) * 100)}% slower than your recent ${sp} norm` : "", costly ? `relative effort per minute ${Math.round((cost(a) / mCost - 1) * 100)}% above norm` : ""].filter(Boolean).join("; ") });
    }
    return out;
  };

  // ---------- Red flags (deterministic part) ----------
  E.flags = function (ctx) {
    const { date, days, acts, form, recovery } = ctx; const f = [];
    const rec = recovery && recovery.parts;
    if (rec && rec.rhr && rec.rhr.value - rec.rhr.base >= 5) f.push({ tone: "warn", text: `Resting HR ${rec.rhr.value} bpm is ${Math.round(rec.rhr.value - rec.rhr.base)} above your ${rec.rhr.base} baseline. Common signs of illness, poor sleep or accumulated fatigue.` });
    if (rec && rec.hrv && rec.hrv.z7 <= -1) f.push({ tone: "warn", text: `7-day HRV trend is ${Math.abs(rec.hrv.z7)} SD below your baseline (${rec.hrv.base} ms). Sustained dips predict poorer adaptation.` });
    const today = days.find(d => d.date === date);
    if (today && today.sleep != null && today.sleep < 6.5) f.push({ tone: "warn", text: `Short sleep last night: ${today.sleep.toFixed(1)} h (target 7-9 h).` });
    const s3 = days.filter(d => d.date <= date && d.date > E.addDays(date, -3) && d.sleep != null).map(d => d.sleep);
    if (s3.length >= 3 && mean(s3) < 7) f.push({ tone: "info", text: `3-night sleep average ${mean(s3).toFixed(1)} h, under 7 h.` });
    if (form && form.tsb < -27) f.push({ tone: "bad", text: `Form ${form.tsb} is in the high-risk zone (below −27).` });
    for (const b of E.bigEffort(acts, date)) f.push({ tone: "warn", text: `Day after a big effort (${b}): cap today at 30 min of Zone 1.` });
    for (const r of E.racesSoon(ctx.races, date)) f.push({ tone: "info", text: `${r.name} is ${r.days === 0 ? "today" : r.days === 1 ? "tomorrow" : "in " + r.days + " days"} (${r.date.slice(5).replace("-", "/")}). Taper around it.` });
    for (const x of E.fatigueScreen(acts, date)) f.push({ tone: "warn", text: `Fatigue carryover check: ${x.name} (${x.date.slice(5).replace("-", "/")}) was ${x.why}. Downgrade today's quality ${x.sport} session if it confirms.` });
    // Load spikes come from Garmin's acute/chronic load ratio (runner and Today page), not a separate calculation here
    const y = E.addDays(date, -1);
    const runMi = (a, b) => acts.filter(x => E.sportOf(x.type) === "run" && x.date > a && x.date <= b).reduce((s, x) => s + (x.km || 0), 0) / 1.609;
    const thisW = runMi(E.addDays(y, -7), y), prev3 = (runMi(E.addDays(y, -28), E.addDays(y, -7))) / 3;
    if (prev3 > 2 && thisW - prev3 > 2 && thisW / prev3 > 1.3) f.push({ tone: "warn", text: `Run mileage up ${Math.round((thisW / prev3 - 1) * 100)}% (${thisW.toFixed(1)} mi vs ${prev3.toFixed(1)} mi weekly average). Running carries the most injury risk.` });
    // Whole words only, so "still", "hill", "drill" or a cold morning don't trip it
    const kw = /\b(sore\w*|pain(?:ful|s)?|hurt\w*|injur\w*|sick\w*|ill|illness|(?:a|head|chest) cold|tweak\w*|strain(?:ed|s)?|ach(?:e|es|ing|y))\b/i;
    for (const a of acts.filter(x => x.date > E.addDays(date, -3) && x.date <= date)) { // notes older than 3 days drop off
      const txt = `${a.name || ""} ${a.note || ""}`; if (kw.test(txt)) f.push({ tone: "warn", text: `${a.date.slice(5)} ${a.name}: "${(a.note || a.name).slice(0, 90)}"` });
    }
    const ws = days.filter(d => d.weight != null && d.date > E.addDays(date, -21) && d.date <= date);
    if (ws.length >= 4) { const sl = E.slopePerWeek(ws.map(d => [d.date, d.weight])); const g = E.SET.lossGoalLbWk; if (sl < -2 * g) f.push({ tone: "warn", text: `Losing ${Math.abs(sl).toFixed(1)} lb/week over 3 weeks, more than double your ${g} lb/week goal. Watch for under-fueling.` }); }
    return f;
  };
  E.slopePerWeek = function (pts) {
    if (pts.length < 2) return 0; const t0 = new Date(pts[0][0]).getTime();
    const xs = pts.map(p => (new Date(p[0]).getTime() - t0) / 864e5), ys = pts.map(p => p[1]);
    const mx = mean(xs), my = mean(ys); const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0), den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    return den ? num / den * 7 : 0;
  };

  // ---------- Compliance (80% rule) ----------
  const SPORT = { Run: "run", VirtualRun: "run", TrailRun: "run", Ride: "bike", VirtualRide: "bike", Swim: "swim", Rowing: "row", WeightTraining: "strength", Workout: "strength" };
  E.sportOf = t => SPORT[t] || "other";
  E.compliance = function (workouts, acts) {
    const used = new Set(); const pick = {};
    const ws = workouts.filter(w => w.sport !== "rest" && w.status !== "skipped");
    // Sports a workout needs: a triathlon counts its swim, bike and run together; a brick its bike and run
    const legs = w => { const t = w.title || "";
      if (w.sport === "brick") return /swim/i.test(t) ? ["swim", "bike", "run"] : ["bike", "run"];
      if (w.sport === "race" || w.sport === "tri") return /triathlon|\btri\b/i.test(t) || w.sport === "tri" ? ["swim", "bike", "run"] : /duathlon/i.test(t) ? ["run", "bike"] : /aquabike/i.test(t) ? ["swim", "bike"] : /fondo|century|ride|bike/i.test(t) ? ["bike"] : /swim/i.test(t) ? ["swim"] : ["run"];
      return [w.sport]; };
    const off = (a, w) => Math.abs((new Date(a.date) - new Date(w.date)) / 864e5);
    const order = [...ws].sort((a, b) => legs(b).length - legs(a).length); // multi-sport first so single workouts can't take their legs
    for (const pass of [0, 1]) for (const w of order) {
      if (pick[w.key]) continue;
      const L = legs(w);
      const days = [...new Set(acts.filter(a => !used.has(a.id) && L.includes(E.sportOf(a.type)) && off(a, w) <= pass).map(a => a.date))];
      if (!days.length) continue;
      const day = days.sort((x, y) => Math.abs(new Date(x) - new Date(w.date)) - Math.abs(new Date(y) - new Date(w.date)))[0];
      // the main activity for each leg that day (so a warm-up jog doesn't count as the run)
      const got = L.map(s => acts.filter(a => !used.has(a.id) && a.date === day && E.sportOf(a.type) === s).sort((a, b) => (b.min || 0) - (a.min || 0))[0]).filter(Boolean);
      pick[w.key] = got; got.forEach(a => used.add(a.id));
    }
    const cap = s => s[0].toUpperCase() + s.slice(1);
    return workouts.map(w => {
      // Rest days count: kept = no more than 30 min of light activity (walks, hikes and yoga don't count against it)
      if (w.sport === "rest" && w.status !== "skipped") {
        const da = acts.filter(a => a.date === w.date && !/^(Walk|Hike|Yoga)$/.test(a.type)), mins = Math.round(da.reduce((t, a) => t + (a.min || 0), 0)), re = da.reduce((t, a) => t + (a.re || 0), 0);
        return mins <= 30 && re <= 15 ? { key: w.key, date: w.date, title: w.title, status: "complete", detail: mins ? `Rest day kept (only ${mins} min of light activity)` : "Rest day kept" }
          : { key: w.key, date: w.date, title: w.title, status: "modified", detail: `Trained ${mins} min on a rest day` };
      }
      if (w.status === "skipped") return { key: w.key, date: w.date, title: w.title, status: "skipped", detail: "Skipped in the plan" };
      const got = pick[w.key];
      if (!got || !got.length) return { key: w.key, date: w.date, title: w.title, status: "missed", detail: "No matching activity in Strava" };
      const L = legs(w), multi = L.length > 1;
      const km = got.reduce((t, a) => t + (a.km || 0), 0), min = got.reduce((t, a) => t + (a.min || 0), 0);
      const byDist = !multi && w.distanceKm, ratio = byDist ? km / w.distanceKm : w.minutes ? min / w.minutes : 1;
      const pct = Math.round(ratio * 100);
      const missing = L.filter(s => !got.some(a => E.sportOf(a.type) === s));
      // 80% rule: at least 80% of planned distance (or time) counts as complete; over 130% is still complete but noted; a multi-sport workout missing a leg is partial
      const st = ratio >= 0.8 && !missing.length ? "complete" : "modified";
      const what = byDist ? `${(km / 1.609).toFixed(2)} of ${(w.distanceKm / 1.609).toFixed(2)} mi`
        : multi ? `${got.map(a => cap(E.sportOf(a.type)) + " " + Math.round(a.min)).join(" + ")} = ${Math.round(min)} of ${w.minutes || "?"} min` : `${Math.round(min)} of ${w.minutes} min`;
      const d = got[0].date;
      return { key: w.key, date: w.date, title: w.title, status: st, pct, activityId: got[0].id, activityIds: got.map(a => a.id), detail: `${what} (${pct}%)${ratio > 1.3 ? ", well over plan" : ""}${missing.length ? ", no " + missing.join(" or ") + " found in Strava" : ""}${d !== w.date ? ", done on " + d : ""}` };
    });
  };

  // ---------- Fuel ----------
  const MET = { run: 8, bike: 6.5, bikeHard: 8.5, swim: 7, row: 6, strength: 4, race: 9, other: 5 };
  E.workoutKcal = (w, lb) => Math.round((MET[w.intensity === "hard" && w.sport === "bike" ? "bikeHard" : w.sport] || 5) * (lb / 2.2046) * (w.minutes || 0) / 60);
  // Fixed daily tiers by the day's training (planned or done, whichever is longer): rest/easy under 45 min = base (1,800);
  // 45-90 min = base + 150 (1,950); 90+ min or a race = base + 400 (2,200). Session fuel is extra. Never cut around races or hard sessions.
  E.calTier = function (minutes, race) { const b = E.SET.kcalBase;
    return race || minutes >= 90 ? { key: "long", label: "Long or race day", kcal: b + 400, rule: "90+ min or a race" }
      : minutes >= 45 ? { key: "moderate", label: "Moderate day", kcal: b + 150, rule: "45-90 min" }
      : { key: "rest", label: "Rest or easy day", kcal: b, rule: "under 45 min" }; };
  E.dailyCalories = function ({ weightLb, workouts, done }) {
    const ws = (workouts || []).filter(w => w.sport !== "rest" && w.status !== "skipped");
    const planned = ws.reduce((t, w) => t + (w.minutes || 0), 0), doneMin = Math.round((done || []).reduce((t, a) => t + (a.min || 0), 0));
    const race = ws.some(w => w.sport === "race"), mins = Math.max(planned, doneMin), tier = E.calTier(mins, race), kg = weightLb / 2.2046;
    return { target: tier.kcal, tier, minutes: mins, planned, doneMin, proteinG: Math.round(kg * 1.6), carbG: Math.round(kg * (tier.key === "long" ? 4 : tier.key === "moderate" ? 3 : 2.5)) };
  };
  // Morgan's go-to fuel (no gels). Carb counts are approximate per package label.
  E.FOOD = {
    c20: "1 Honey Stinger waffle (~21 g) or 1 Welch's fruit snack pack (~20 g)",
    c30: "1 Honey Stinger waffle plus 1-2 Swedish Fish, or 1 Welch's pack plus a few sips of Gatorade",
    c60: "a Welch's pack or Honey Stinger waffle every 20-30 min, topped up with Swedish Fish, Nerds Gummy Clusters or Gatorade (20 oz ~36 g)",
    pre: "a few Swedish Fish or Nerds Gummy Clusters",
    na: "Liquid IV (~500 mg per stick), Gatorade (~270 mg per 20 oz) or a SaltStick capsule (~215 mg) as needed"
  };
  // Counter items for logging what you actually eat/drink. Per-serving label values.
  E.FUEL_ITEMS = [
    { k: "oat", name: "Quaker Dinosaur Eggs oatmeal", unit: "packet", c: 36, na: 230, oz: 0 },
    { k: "rbc", name: "Raisin Bran Crunch cup (280 cal) + 1 cup Fairlife 2% milk", unit: "cup with milk", c: 72, na: 550, oz: 8 },
    { k: "hscc", name: "Honey Stinger waffle, Cookies & Cream", unit: "waffle", c: 21, na: 90, oz: 0 },
    { k: "hssc", name: "Honey Stinger waffle, Salted Caramel", unit: "waffle", c: 21, na: 150, oz: 0 },
    { k: "sf", name: "Swedish Fish", unit: "5 pieces", c: 27, na: 25, oz: 0 },
    { k: "nerds", name: "Nerds Gummy Clusters", unit: "5 clusters", c: 7.2, na: 14, oz: 0 },
    { k: "ramen", name: "Maruchan ramen (full package, with broth)", unit: "package", c: 54, na: 1440, oz: 16 },
    { k: "liv", name: "Liquid IV Orange Vanilla Dream in 16 oz water", unit: "stick", c: 13, na: 500, oz: 16 },
    { k: "water", name: "Plain water", unit: "8 oz", c: 0, na: 0, oz: 8 }
  ];
  E.fuelTotals = log => { const t = E.FUEL_ITEMS.reduce((t, i) => { const n = (log && log[i.k]) || 0; t.c += n * i.c; t.na += n * i.na; t.oz += n * i.oz; return t; }, { c: 0, na: 0, oz: 0 });
    for (const x of (log && log.custom) || []) { t.c += +x.c || 0; t.na += +x.na || 0; t.oz += +x.oz || 0; } return t; };
  E.fuelAny = log => !!log && (E.FUEL_ITEMS.some(i => log[i.k] > 0) || ((log.custom || []).length > 0));
  E.fuelTotalsR = log => { const t = E.fuelTotals(log); return { c: Math.round(t.c), na: Math.round(t.na), oz: Math.round(t.oz) }; };
  // Targets for a before/after phase, read from the plan's own lines (meal carbs, snacks, water amounts)
  E.phaseNeed = function (lines) { let c = 0, oz = 0;
    for (const l of lines) { const m = l.match(/~(\d+) g carbs/); if (m) c += +m[1]; else if (/Swedish Fish|Gummy Clusters/.test(l)) c += 20; else if (/waffle|Welch/.test(l)) c += 21;
      if (!/every lb|per lb/.test(l)) for (const x of l.matchAll(/(\d+)(?:-(\d+))? oz/g)) oz += +(x[2] || x[1]); }
    return { c, na: 0, oz }; };
  // After: replace the ~25% of sweat not replaced during (drink ~22 oz per lb lost), at least 16 oz
  E.postOz = duringOz => Math.max(16, Math.round(duringOz / 3 * 1.375 / 4) * 4);
  // Sweat profile per sport from recent weigh-ins (last 90 days, newest 6). With a temperature, prefers
  // entries within 10°F. Replace ~75% of fluid lost; sodium assumes ~1,000 mg per liter of sweat (typical),
  // replacing ~75% of that.
  E.sweatProfile = function (entries, sport, tempF, today) {
    let es = (entries || []).filter(x => x.sport === sport && x.rate > 0 && (!today || x.date >= E.addDays(today, -90))).sort((a, b) => a.date < b.date ? 1 : -1);
    if (tempF != null) { const near = es.filter(x => x.tempF != null && Math.abs(x.tempF - tempF) <= 10); if (near.length >= 2) es = near; }
    es = es.slice(0, 6); if (!es.length) return null;
    const ozHr = Math.round(es.reduce((t, x) => t + x.rate, 0) / es.length);
    return { ozHr, n: es.length, latest: es[0].date, fluidOzHr: Math.min(32, Math.round(ozHr * 0.75)), naMgHr: Math.round(ozHr * 29.57 * 0.75 / 50) * 50 };
  };
  E.sweatRate = e => { const loss = (e.pre - e.post) * 16 + (e.fluidOz || 0); const h = (e.minutes || 0) / 60; return h > 0 ? r1(loss / h) : null; };
  // Cardiac drift: HR rise 2nd half vs 1st half of the moving portion (first 10 min dropped as warm-up when > 30 min),
  // plus Pa:HR / Pw:HR decoupling when power (bike) or speed is recorded.
  E.drift = function (st, sport) {
    const t = st.time, hr = st.heart_rate; if (!t || !hr || t.length < 10) return null;
    const out = sport === "bike" && st.watts ? st.watts : st.velocity_smooth || null, mv = st.moving;
    const pts = []; for (let i = 1; i < t.length; i++) { const dt = t[i] - t[i - 1]; if (dt <= 0 || dt > 30 || !hr[i] || (mv && mv[i] === false)) continue; pts.push([dt, hr[i], out ? out[i] || 0 : 0]); }
    let tot = pts.reduce((x, p) => x + p[0], 0); if (tot < 20 * 60) return { short: true };
    let skip = tot > 30 * 60 ? 600 : 0, acc = 0; const use = pts.filter(p => (acc += p[0]) > skip); tot = use.reduce((x, p) => x + p[0], 0);
    const half = [[0, 0, 0], [0, 0, 0]]; acc = 0; for (const p of use) { const h = half[(acc += p[0]) <= tot / 2 ? 0 : 1]; h[0] += p[0]; h[1] += p[1] * p[0]; h[2] += p[2] * p[0]; }
    const [h1, h2] = half.map(h => ({ hr: h[1] / h[0], o: h[2] / h[0] }));
    const r = { hr1: Math.round(h1.hr), hr2: Math.round(h2.hr), driftPct: +((h2.hr - h1.hr) / h1.hr * 100).toFixed(1) };
    if (out && h1.o > 0 && h2.o > 0) { r.decouplePct = +(((h1.o / h1.hr) - (h2.o / h2.hr)) / (h1.o / h1.hr) * 100).toFixed(1); r.basis = sport === "bike" && st.watts ? "power" : "pace"; }
    const v = r.decouplePct ?? r.driftPct; r.band = v < 5 ? "good" : v <= 10 ? "moderate" : "high";
    r.label = { good: "Under 5%: solid aerobic durability", moderate: "5-10%: some drift; heat, hydration, fueling or effort a bit above aerobic", high: "Over 10%: big drift; effort was above your aerobic ceiling or heat/dehydration took over" }[r.band];
    return r;
  };
  // Daily water goal: 60 oz base + each workout's sweat loss (sweat rate x hours; drink ~75% during, the rest after),
  // + 16 oz pre-hydration for sessions 75+ min, hard sessions or races. sweatOf(sport) -> oz/hr or null.
  E.waterGoal = function (workouts, sweatOf) {
    const def = { run: 24, bike: 24, row: 24, brick: 24, race: 24, strength: 12, swim: 8 };
    const parts = []; let extra = 0;
    for (const w of workouts) { if (!w.minutes || w.sport === "rest") continue;
      const sp = w.sport === "race" ? "run" : w.sport === "brick" ? "bike" : w.sport; const rate = sweatOf(sp) || def[w.sport] || 20;
      let oz = rate * w.minutes / 60; if (w.minutes >= 75 || w.intensity === "hard" || w.sport === "race") oz += 16;
      oz = Math.round(oz / 4) * 4; if (oz < 4) continue; extra += oz; parts.push({ title: w.title, oz }); }
    const base = E.SET.waterBase; return { base, extra, goal: base + extra, parts };
  };
  // Fitness markers from one activity's streams: highest HR held ~10 s, and the hardest 20 minutes (avg HR + avg speed)
  E.streamMarkers = function (st, edges) {
    const t = st.time, hr = st.heart_rate, v = st.velocity_smooth; if (!t || !hr || t.length < 10) return {};
    const out = {}; let best = 0;
    // Aerobic efficiency: average speed while heart rate sits in Zone 2 (moving only)
    if (v && edges) { let secs = 0, sv = 0, sh = 0; for (let i = 1; i < t.length; i++) { const dt = t[i] - t[i - 1]; if (dt <= 0 || dt > 30 || !hr[i] || !(v[i] > 0.5)) continue; if (hr[i] > edges[0] && hr[i] <= edges[1]) { secs += dt; sv += v[i] * dt; sh += hr[i] * dt; } }
      if (secs >= 300) out.z2 = { secs: Math.round(secs), mps: Math.round(sv / secs * 1000) / 1000, hr: Math.round(sh / secs) }; }
    for (let i = 0, j = 0, s = 0, n = 0; i < t.length; i++) { s += hr[i] || 0; n++; while (t[i] - t[j] > 10) { s -= hr[j] || 0; n--; j++; } if (t[i] - t[j] >= 8 && n) best = Math.max(best, s / n); }
    if (best) out.hrMax = Math.round(best);
    if (t[t.length - 1] - t[0] >= 25 * 60) {
      let b = null;
      for (let i = 0, j = 0, sh = 0, sv = 0, n = 0; i < t.length; i++) { sh += hr[i] || 0; sv += v ? v[i] || 0 : 0; n++;
        while (t[i] - t[j] > 1200) { sh -= hr[j] || 0; sv -= v ? v[j] || 0 : 0; n--; j++; }
        if (t[i] - t[j] >= 1150 && (!b || sh / n > b.hr)) b = { hr: sh / n, mps: v ? sv / n : null }; }
      if (b) out.best20 = { hr: Math.round(b.hr), mps: b.mps ? Math.round(b.mps * 1000) / 1000 : null };
    }
    return out;
  };
  E.EMOJI = { swim: "🏊‍♀️", bike: "🚴‍♀️", run: "🏃‍♀️", strength: "🏋️‍♀️", row: "🚣‍♀️", brick: "🚴‍♀️🏃‍♀️", race: "🏁", rest: "😴" };
  E.emojiTitle = function (title, sport) { const t = String(title || "").replace(/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+/u, ""); const e = E.EMOJI[sport] || (/brick/i.test(t) ? E.EMOJI.brick : ""); return e ? `${e} ${t}` : t; };
  // Schedule-style during-fuel: what, how much, how often. g = carbs per hour, start = first snack (min in).
  E.fuelPlan = function ({ min, g, start, ozHr, naHr, pre = "", snack = "1 Honey Stinger waffle or 1 Welch's pack (or 3 Swedish Fish)", pack = false }) {
    const sip = Math.max(3, Math.round(ozHr / 4));
    const bottle = Math.max(12, Math.min(24, Math.round(ozHr * 500 / naHr / 4) * 4));
    const extraNa = naHr - Math.round(ozHr / bottle * 500);
    const every = Math.round(60 * 20 / g / 5) * 5, snacks = min >= start ? Math.floor((min - start) / every) + 1 : 0;
    const totOz = Math.round(ozHr * min / 60), sticks = Math.max(1, Math.round(totOz / bottle));
    const saltEvery = extraNa >= 150 ? Math.max(30, Math.round(60 * 215 / extraNa / 15) * 15) : 0;
    const out = [`${pre}Every 15 min: ~${sip} oz from your bottle (water with 1 Liquid IV stick per ${bottle} oz)`];
    if (snacks) out.push(snacks === 1 ? `${pre}Once, at about ${start} min: ${snack}` : `${pre}Every ${every} min, starting ${start} min in: ${snack}`);
    out.push(saltEvery ? `${pre}Every ${saltEvery} min: 1 SaltStick capsule` : `${pre}If it's hot or you're salty-sweaty: 1 SaltStick capsule per hour`);
    out.kit = { oz: totOz, sticks, snacks, salt: saltEvery ? Math.floor(min / saltEvery) : 0, carbs: Math.round(g * min / 60), na: Math.round(naHr * min / 60) };
    if (pack) out.push(`${pre}Pack: ${totOz} oz water, ${sticks} Liquid IV${snacks ? `, ${snacks} snack${snacks > 1 ? "s" : ""} from the list above` : ""}${saltEvery ? `, ${Math.floor(min / saltEvery)} SaltStick` : ""}`);
    return out;
  };
  // kits: [{oz, sticks, snacks, salt}], opts: {preSnack, recovery, label}
  E.packList = function (kits, o = {}) {
    const sum = k => kits.reduce((t, x) => t + (x[k] || 0), 0);
    const oz = sum("oz"), sticks = sum("sticks"), snacks = sum("snacks"), salt = sum("salt"), pl = (n, a, b) => n === 1 ? a : b;
    const out = [];
    if (o.waterOnly) out.push(`Water bottle${oz ? ` (~${oz} oz)` : ""}`);
    else { out.push(`${oz} oz water${sticks ? ` + ${sticks} Liquid IV ${pl(sticks, "stick", "sticks")}` : ""}`);
      if (snacks) out.push(`${snacks} ${pl(snacks, "Honey Stinger waffle or Welch's pack", "Honey Stinger waffles / Welch's packs")} (Swedish Fish work as swaps)`);
      out.push(salt ? `${salt} SaltStick ${pl(salt, "capsule", "capsules")}` : "1-2 SaltStick capsules in case it's hot"); }
    if (o.preSnack) out.push(o.preSnack);
    if (o.recovery) out.push("Protein shake or bar for right after");
    return out;
  };
  E.fuelChecklist = function (w, ctx) {
    const p = ctx.sweat; const min = w.minutes || 0, hard = w.intensity === "hard" || w.sport === "race";
    const ozHr = p ? p.fluidOzHr : 20, sip = Math.max(3, Math.round(ozHr / 4));
    // Pre-fuel scales with the session (1-4 g/kg guideline): easy ~1 g/kg, hard or 2.5 h+ ~1.5 g/kg, race ~2 g/kg, including ~20 g of Swedish Fish just before
    const kg = (ctx.weightLb || 165) / 2.2046, gkg = w.sport === "race" ? 2 : w.intensity === "hard" || w.intensity === "moderate" || min >= 150 ? 1.5 : 1;
    const meal = Math.max(30, Math.round((kg * gkg - 20) / 5) * 5);
    const before = min >= 75 || hard ? [`2-3 h before: a carb-heavy meal (~${meal} g carbs) with 16 oz water`, "15 min before: 3-4 Swedish Fish or a few Nerds Gummy Clusters"]
      : ["2-3 h before: a normal meal (or 1 Honey Stinger waffle or Welch's pack if going first thing)", "In the hour before: 8-16 oz water"];
    let during = [];
    const big = min >= 75 || hard, preSnack = big ? "3-4 Swedish Fish or a few Nerds Gummy Clusters for 15 min before" : null;
    let pack;
    if (w.sport === "swim" || w.sport === "strength") { during = ["Sip water between sets or laps as needed"]; pack = E.packList([{ oz: Math.max(12, Math.round(min / 60 * 16)) }], { waterOnly: true, preSnack }); }
    else if (min < 60) { during = [`Every 15 min: ~${sip} oz water (nothing else needed)`]; pack = E.packList([{ oz: Math.max(8, Math.round(ozHr * min / 60)) }], { waterOnly: true, preSnack }); }
    else during = E.fuelPlan({ min, g: min > 90 ? 50 : 30, start: min > 90 ? 20 : 30, ozHr, naHr: p ? p.naMgHr : (min > 90 ? 400 : 300) });
    if (!pack) pack = E.packList([during.kit], { preSnack, recovery: big });
    const k = during.kit, target = k ? { c: k.carbs, na: k.na, oz: k.oz } : { c: 0, na: 0, oz: w.sport === "swim" || w.sport === "strength" ? Math.max(12, Math.round(min / 60 * 16)) : Math.max(8, Math.round(ozHr * min / 60)) };
    const after = [min >= 75 || hard ? "Within 1 h: a meal or shake with 20-30 g protein and ~75 g carbs" : "Within 2 h: a normal meal with 20-30 g protein",
      "Weigh in, then drink 20-24 oz for every lb lost over the next couple of hours"];
    return { pack, before, during, after, target, targets: { pre: E.phaseNeed(before), during: target, post: { ...E.phaseNeed(after), oz: E.postOz(target.oz) } } };
  };

  if (typeof module !== "undefined" && module.exports) module.exports = E; else root.ENGINE = E;
})(typeof window !== "undefined" ? window : globalThis);
