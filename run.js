/* Training Hub runner: node run.js daily|weekly --today YYYY-MM-DD [--since YYYY-MM-DD] [--dir /tmp/hub]. Reads the database copies in <dir>/db, writes results to <dir>/out. */
const fs = require("fs"), path = require("path");
const args = Object.fromEntries(process.argv.slice(3).reduce((a, x, i, arr) => (x.startsWith("--") ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const mode = process.argv[2], dir = args.dir || "/tmp/hub", today = args.today;
const E = require(path.join(dir, "engine.js"));
const out = path.join(dir, "out"); fs.mkdirSync(out, { recursive: true });
const rj = p => { try { const j = JSON.parse(fs.readFileSync(p, "utf8")); return j.data || j; } catch (e) { return null; } };
const readColl = c => { const d = path.join(dir, "db", c); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => ({ id: f.replace(/\.json$/, ""), ...rj(path.join(d, f)) })); };
E.applySettings(rj(path.join(dir, "db/config/settings.json")));
const zones = E.zoneText();
const w = (n, o) => fs.writeFileSync(path.join(out, n), JSON.stringify(o));
const metaPmc = rj(path.join(dir, "db/meta/pmc.json")) || {};
const metaActs = rj(path.join(dir, "db/meta/acts.json")) || { list: [] };
// Ride power (normalized power, seconds, FTP that day) cached by the hub page; used for bike load
const power = (rj(path.join(dir, "db/meta/power.json")) || {}).rides || null;
const fresh = rj(path.join(dir, "new.json")) || [];
const seen = new Set(fresh.map(a => String(a.id)));
// --since START: Strava was re-read from START, so saved activities from START on are replaced (ones deleted in Strava drop out)
const since = args.since || "9999-12-31";
const acts = [...metaActs.list.filter(a => !seen.has(String(a.id)) && a.date < since), ...fresh.map(a => ({ ...a, id: String(a.id) }))].filter(a => a.date > E.addDays(today, -70)).sort((a, b) => a.date < b.date ? -1 : 1);
const y = E.addDays(today, -1);

function pmcThrough(end) {
  if (!metaPmc.asOf) return null;
  const loads = E.dailyLoads(acts, power);
  const hist = metaPmc.history || []; const anchorDate = E.addDays(metaPmc.asOf, -14);
  const anchor = hist.find(h => h.date === anchorDate);
  const seed = anchor ? { asOf: anchorDate, ctl: anchor.ctl, atl: anchor.atl } : { asOf: metaPmc.asOf, ctl: metaPmc.ctl, atl: metaPmc.atl };
  const ext = seed.asOf < end ? E.pmc(loads, null, end, seed) : [];
  const merged = [...hist.filter(h => h.date <= seed.asOf), ...ext].slice(-120);
  const last = merged[merged.length - 1];
  return { asOf: last.date, ctl: last.ctl, atl: last.atl, history: merged };
}

if (mode === "daily") {
  const days = readColl("days").filter(d => d.date);
  const day = rj(path.join(dir, "garmin.json"));
  const allDays = [...days.filter(d => d.date !== today), day];
  const pmc = pmcThrough(y);
  const form = pmc ? { ctl: pmc.ctl, atl: pmc.atl, tsb: pmc.tsb ?? Math.round((pmc.ctl - pmc.atl) * 10) / 10 } : null;
  if (form) form.band = E.formBand(form.tsb).label;
  const recovery = E.recovery(day, allDays);
  const races = readColl("races").filter(r => r.date);
  const flags = E.flags({ date: today, days: allDays, acts, form, recovery, races });
  const p30 = allDays.filter(d => d.date < today && d.date >= E.addDays(today, -30)), q = x => Math.round(x * 10) / 10;
  const avg = k => { const a = p30.filter(d => d[k] != null).map(d => d[k]); return a.length >= 7 ? q(a.reduce((s, x) => s + x, 0) / a.length) : null; };
  const g = { sleepScore: day.sleepScore ?? null, sleepDetail: day.sleepDetail || null, resp: day.resp ?? null, respBase: avg("resp"), spo2: day.spo2 ?? null, spo2Base: avg("spo2"), load: day.gLoad || null };
  if (g.resp != null && g.respBase != null && g.resp - g.respBase >= 1) flags.push({ tone: "warn", text: `Overnight breathing rate ${g.resp} br/min is ${q(g.resp - g.respBase)} above your ${g.respBase} baseline, often an early sign of illness.` });
  if (g.spo2 != null && g.spo2Base != null && g.spo2Base - g.spo2 >= 3) flags.push({ tone: "warn", text: `Overnight SpO2 ${g.spo2}% is ${q(g.spo2Base - g.spo2)} points under your ${g.spo2Base}% baseline.` });
  if (g.load && /HIGH/.test(g.load.acwr || "")) flags.push({ tone: "warn", text: `Garmin acute load ${g.load.acute} vs chronic ${g.load.chronic} (ratio ${g.load.ratio}) is high.` });
  const mon = E.mondayOf(today);
  const wk = readColl("weeks").find(x => x.id === mon) || {};
  const workouts = (wk.workouts || []).filter(x => x.date >= today && x.date <= E.addDays(today, 2)).map(x => ({ key: x.key, date: x.date, sport: x.sport, title: x.title, minutes: x.minutes, status: x.status, note: x.note, desc: (x.desc || "").slice(0, 350) }));
  const journal = readColl("journal").filter(j => j.date >= E.addDays(today, -3)).map(j => ({ id: j.id, date: j.date, text: j.text, suggestions: (j.suggestions || []).map(s => ({ title: s.title, status: s.status })) }));
  const notes = (rj(path.join(dir, "db/config/notes.json")) || {}).items || [];
  const yActs = acts.filter(a => a.date === y).map(a => ({ type: a.type, name: a.name, km: a.km, min: Math.round(a.min), re: a.re, note: a.note }));
  w("day.json", day);
  if (pmc) w("pmc.json", pmc);
  w("acts.json", { updatedThrough: y, list: acts.filter(a => a.date > E.addDays(today, -60)) });
  const parts = Object.fromEntries(Object.entries(recovery.parts).map(([k, v]) => [k, { value: v.value, base: v.base, score: v.score }]));
  const rules = { dayAfterBigEffort: E.bigEffort(acts, today), raceWithin10Days: E.racesSoon(races, today).map(r => `${r.name} ${r.date}`), fatigueCarryover: E.fatigueScreen(acts, today) };
  w("snapshot.json", { date: today, run: "pending", form, recovery: { score: recovery.score, band: recovery.band, why: recovery.why, parts }, autoFlags: flags, garmin: g });
  w("summary.json", { today, zones, form, recovery: { score: recovery.score, band: recovery.band, why: recovery.why, missing: recovery.missing, parts }, sleepH: day.sleep, garmin: g, flags: flags.map(f => f.text), rules, yesterday: yActs, workouts, journal, standingNotes: notes.map(n => n.text) });
  console.log(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
}

if (mode === "weekly") {
  const mon = E.mondayOf(today), prevMon = E.addDays(mon, -7), nextMon = E.addDays(mon, 7);
  const wk = readColl("weeks").find(x => x.id === mon) || { workouts: [] };
  const compliance = E.compliance(wk.workouts || [], acts.filter(a => a.date >= mon && a.date <= today));
  const stat = (a, b) => { const s = acts.filter(x => x.date >= a && x.date <= b); const by = t => s.filter(x => E.sportOf(x.type) === t);
    const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
    return { hours: +(sum(s, x => x.min) / 60).toFixed(1), re: sum(s, x => x.re), runMi: +(sum(by("run"), x => x.km) / 1.609).toFixed(1), bikeMi: +(sum(by("bike"), x => x.km) / 1.609).toFixed(1), bikeFt: Math.round(sum(by("bike"), x => x.elev) * 3.281), swimM: Math.round(sum(by("swim"), x => x.km) * 1000), rowMin: Math.round(sum(by("row"), x => x.min)), strengthMin: Math.round(sum(by("strength"), x => x.min)) }; };
  const cur = stat(mon, today);
  const prevs = [1, 2, 3, 4].map(k => stat(E.addDays(mon, -7 * k), E.addDays(mon, -7 * k + 6)));
  const avg = Object.fromEntries(Object.keys(cur).map(k => [k, +(prevs.reduce((t, p) => t + p[k], 0) / 4).toFixed(1)]));
  const pct = (a, b) => b ? (a >= b ? "+" : "") + Math.round((a / b - 1) * 100) + "%" : a ? "new" : "same";
  const r0 = x => Math.round(x);
  const table = { cols: [`This week (${mon.slice(5)})`, "4-week avg"], rows: [
    ["Total time", cur.hours + " h", avg.hours + " h", pct(cur.hours, avg.hours)], ["Relative effort", String(cur.re), String(r0(avg.re)), pct(cur.re, avg.re)],
    ["Run", cur.runMi + " mi", avg.runMi + " mi", pct(cur.runMi, avg.runMi)], ["Bike", `${cur.bikeMi} mi · ${cur.bikeFt.toLocaleString()} ft`, `${avg.bikeMi} mi · ${r0(avg.bikeFt).toLocaleString()} ft`, pct(cur.bikeMi, avg.bikeMi)],
    ["Swim", cur.swimM.toLocaleString() + " m", r0(avg.swimM).toLocaleString() + " m", pct(cur.swimM, avg.swimM)], ["Strength", cur.strengthMin + " min", r0(avg.strengthMin) + " min", pct(cur.strengthMin, avg.strengthMin)]] };
  const weekly = [cur, ...prevs].map((p, i) => ({ week: E.addDays(mon, -7 * i), hours: p.hours, re: p.re, runMi: p.runMi }));
  const pmc = pmcThrough(today);
  const days = readColl("days").filter(d => d.date);
  const tday = days.find(d => d.date === today);
  const allRaces = readColl("races").filter(r => r.date);
  const flags = E.flags({ date: today, days, acts, races: allRaces, form: pmc ? { tsb: pmc.history[pmc.history.length - 1].tsb } : null, recovery: tday ? E.recovery(tday, days) : null });
  const lastSwim = acts.filter(a => a.type === "Swim").slice(-1)[0];
  const lastLong = acts.filter(a => E.sportOf(a.type) === "run").sort((a, b) => b.km - a.km)[0];
  const journal = readColl("journal").filter(j => j.date >= E.addDays(today, -8)).map(j => ({ id: j.id, date: j.date, text: j.text }));
  const notes = (rj(path.join(dir, "db/config/notes.json")) || {}).items || [];
  const rank = { top: 0, mid: 1, low: 2 };
  // Open milestones with their index in the goal's milestones array; overdue = date passed and not done
  const goals = readColl("goals").sort((a, b) => (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1)).map(g => ({ id: g.id, priority: g.priority || "mid", title: g.title, due: g.due, openMilestones: (g.milestones || []).map((m, i) => [m, i]).filter(([m]) => !m.done).map(([m, i]) => ({ i, label: m.label, due: m.due || null, movedFrom: m.movedFrom || null, overdue: !!(m.due && m.due < today) })) }));
  const wts = days.filter(d => d.weight != null && d.date > E.addDays(today, -28)).sort((a, b) => a.date < b.date ? -1 : 1);
  const weight = wts.length ? { latestLb: wts[wts.length - 1].weight, trendLbPerWeek: wts.length >= 3 ? +E.slopePerWeek(wts.map(d => [d.date, d.weight])).toFixed(2) : null } : null;
  const races = readColl("races").filter(r => r.date >= today).map(r => ({ id: r.id, name: r.name, date: r.date, kind: r.kind }));
  const sweatEntries = readColl("sweat");
  const sweat = Object.fromEntries(["run", "bike", "swim", "row"].map(sp => [sp, E.sweatProfile(sweatEntries, sp, null, today)]).filter(x => x[1]).map(([k, p]) => [k, { sweatOzHr: p.ozHr, drinkOzHr: p.fluidOzHr, sodiumMgHr: p.naMgHr, tests: p.n }]));
  const wkActs = acts.filter(a => a.date >= mon && a.date <= today && ["run", "bike", "swim", "row"].includes(E.sportOf(a.type)));
  const zm = Object.fromEntries(readColl("zonemix").map(z => [String(z.id), z]));
  const mix = E.intensityMix(wkActs.map(a => zm[a.id]));
  const intensityMix = mix ? { ...mix, coveredSessions: mix.sessions, enduranceSessions: wkActs.length } : { note: "No heart-rate zone data cached for this week" };
  const res = { zones, intensityMix, sweat, thisWeek: mon, nextWeek: nextMon, nextDates: [...Array(7)].map((_, i) => E.addDays(nextMon, i)), compliance, table, last5Weeks: weekly, form: pmc && pmc.history[pmc.history.length - 1], fitnessPlan: pmc ? E.fitnessPlan(pmc.history) : null, flags,
    lastSwimM: lastSwim ? Math.round(lastSwim.km * 1000) : null, longestRunMi: lastLong ? +(lastLong.km / 1.609).toFixed(1) : null, weight, journal, standingNotes: notes.map(n => n.text), goals, races,
    lastWeekPlan: (wk.workouts || []).map(x => ({ sport: x.sport, title: x.title, minutes: x.minutes })) };
  if (pmc) w("pmc.json", pmc);
  w("acts.json", { updatedThrough: today, list: acts.filter(a => a.date > E.addDays(today, -60)) });
  w("weekly.json", res);
  console.log(JSON.stringify(res));
}

// Weight milestones (daily): mark open "weightMax" milestones done when the 7-day average weigh-in is at or under the number in the label.
// Input <dir>/weighins.json = [{date, lb}] for TODAY-6..TODAY (latest weigh-in per day). Needs 3+ days. Writes out/goals.json = [{id, milestones}] for goals that changed.
if (mode === "daily") {
  const wi = (rj(path.join(dir, "weighins.json")) || []).filter(x => x && x.date >= E.addDays(today, -6) && x.date <= today && x.lb > 0);
  const byDay = {}; for (const x of wi) byDay[x.date] = x.lb;
  const vals = Object.values(byDay), changed = [];
  const avg = vals.length >= 3 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null;
  if (avg != null) for (const g of readColl("goals")) {
    let hit = false;
    const ms = (g.milestones || []).map(m => { if (m.type !== "weightMax" || m.done) return m; const t = parseFloat((String(m.label).match(/(\d+(?:\.\d+)?)/) || [])[1]);
      if (!(t >= avg)) return m; hit = true; return { ...m, done: true, doneOn: today, doneValue: `7-day avg ${avg} lb` }; });
    if (hit) changed.push({ id: g.id, milestones: ms, reached: ms.filter((m, k) => m.doneOn === today && !(g.milestones[k] || {}).done).map(m => m.label) });
  }
  w("goals.json", changed);
  console.log(JSON.stringify({ weight7dayAvg: avg, weighInDays: vals.length, milestonesReached: changed.flatMap(c => c.reached.map(l => ({ goal: c.id, label: l }))) }));
}
