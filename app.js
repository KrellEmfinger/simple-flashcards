/* Flashcards app — plain JavaScript, no build step.
 *
 * Data:   decks/index.json lists the decks; each deck is decks/<id>.json
 *         (the offline build embeds them as window.EMBEDDED_LIB).
 * Saving: Claude artifact  -> publishes the changed deck files back into the artifact (artifact capability)
 *         GitHub Pages     -> one commit with every changed deck file, through the GitHub API with your token
 *         anywhere         -> export a deck file and commit it yourself
 * Unsaved edits are kept as a draft in this browser until they are saved.
 */
"use strict";

/* ---------- small helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* By default every visit starts fresh from the deck files: study progress, sessions and unsaved edits are not
 * kept between visits. "Remember on this device" (Save & export) turns that memory on. Preferences (theme of the
 * page aside, which lives in the deck), tokens and keys are always kept. */
let REMEMBER = false;
const MEMORY = /^fc-(draft|session|progress|active)/;
const LS = {
  get(k, d) { if (!REMEMBER && MEMORY.test(k)) return d; try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { if (!REMEMBER && MEMORY.test(k)) return; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
  forgetMemory() { try { for (const k of Object.keys(localStorage)) if (MEMORY.test(k)) localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
};
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const slug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "")) || "card";
const normTerm = (s) => String(s).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
const capUse = (name) => (window.claude && typeof window.claude.use === "function") ? window.claude.use(name).catch(() => null) : Promise.resolve(null);

/* Deck JSON is written one card per line so Git diffs stay readable.
 * tools/deck.py writes the exact same format. */
function jsonSp(v) {
  if (Array.isArray(v)) return "[" + v.map(jsonSp).join(", ") + "]";
  if (v && typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ": " + jsonSp(x)).join(", ") + "}";
  return JSON.stringify(v);
}
function serializeDeck(d) {
  const parts = Object.entries(d).map(([k, v]) => {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") {
      return `  ${JSON.stringify(k)}: [\n${v.map((x) => "    " + jsonSp(x)).join(",\n")}\n  ]`;
    }
    return `  ${JSON.stringify(k)}: ${jsonSp(v)}`;
  });
  return "{\n" + parts.join(",\n") + "\n}\n";
}
const CARD_KEYS = ["id", "obj", "term", "def", "tags", "src", "pack"];
function cleanCard(c) {
  const o = {};
  for (const k of CARD_KEYS) if (c[k] !== undefined && c[k] !== "" && !(Array.isArray(c[k]) && !c[k].length)) o[k] = c[k];
  for (const k of Object.keys(c)) if (!CARD_KEYS.includes(k) && !k.startsWith("_")) o[k] = c[k];
  if (!o.obj) o.obj = "";
  return o;
}

/* ---------- state ---------- */
const S = {
  deck: null, baseText: "", baseDeck: null, loadError: null, draftConflict: null,
  env: { inViewer: !!window.claude, artifact: null, downloads: null, sample: null, readOnly: false, saving: false,
    desktop: !!window.__TAURI__, installPrompt: null, installed: false, source: "files" },
  view: "study",
  study: { dom: "all", obj: null, mode: "flip", filter: "all", defFirst: false, order: [], known: [], review: [], round: 1, missed: new Set(), history: [],
    pile: "study", flipped: false, quiz: null, typing: null, reveal: null, right: 0, asked: 0, elapsed: 0, typedN: 0, typedMs: 0, timeouts: 0 },
  list: { q: "", dom: "all", src: "all", limit: 150, sel: new Set(), org: false },
  packExp: { groups: null, title: "", desc: "" },
  add: { text: "", defaultObj: "auto", cands: [], busy: false, ctl: null, msg: "", deckImport: null, created: new Set() },
  packs: null,
  settings: LS.get("fc-settings", { gh: { owner: "", repo: "", branch: "main", folder: "decks" }, ai: { model: "claude-sonnet-5-5" }, commitMsg: "" }),
  lib: { index: null, indexBase: "", store: {}, deleted: new Set() },
  activeId: null,
  ghToken: LS.get("fc-gh-token", ""),
  apiKey: LS.get("fc-anthropic-key", ""),
  prog: {},
  modal: null,
};
const progKey = () => "fc-progress";
const draftKey = (id) => "fc-draft:" + (id || S.activeId);
const pk = (c) => S.activeId + "|" + c.id;          // study progress is per deck
if (!S.settings.gh.folder) S.settings.gh.folder = "decks";
if (S.settings.typeChance == null) S.settings.typeChance = 0.25;
if (S.settings.timed == null) S.settings.timed = false;
REMEMBER = !!S.settings.remember;
if (!REMEMBER) LS.forgetMemory();           // start fresh: clear anything an earlier visit left behind
if (![5, 7, 10, 14].includes(S.settings.timedSecs)) S.settings.timedSecs = 10;
const TYPE_CHANCES = [[0, "Off"], [0.25, "Sometimes"], [0.5, "Often"], [1, "Always"]];
const THEMES = [
  ["", "Auto (match device)"], ["midnight", "Midnight"], ["graphite", "Graphite"], ["ember", "Ember"], ["plum", "Plum"], ["daylight", "Daylight"],
];
/* What this deck calls its two levels of grouping (Security+ uses Domain / Objective). */
function lab() {
  const l = S.deck?.labels || {};
  const G = l.group || "Group", C = l.category || "Category";
  return { G, g: G.toLowerCase(), Gs: G + "s", gs: G.toLowerCase() + "s", C, c: C.toLowerCase(), Cs: C + "s", cs: C.toLowerCase() + "s" };
}

/* ---------- deck model ---------- */
function normalizeDeck(d) {
  d = d && typeof d === "object" ? d : {};
  d.schema = d.schema || 1;
  d.title = d.title || "My deck";
  d.domains = Array.isArray(d.domains) ? d.domains : [];
  d.objectives = Array.isArray(d.objectives) ? d.objectives : [];
  d.cards = (Array.isArray(d.cards) ? d.cards : []).filter((c) => c && c.term && c.def).map(cleanCard);
  // objectives referenced by cards but not declared
  const known = new Set(d.objectives.map((o) => o.id));
  for (const c of d.cards) if (c.obj && !known.has(c.obj)) { known.add(c.obj); d.objectives.push({ id: c.obj, domain: c.obj.split(".")[0], name: c.obj }); }
  const doms = new Set(d.domains.map((x) => x.id));
  for (const o of d.objectives) if (!doms.has(o.domain)) { doms.add(o.domain); d.domains.push({ id: o.domain, name: "Domain " + o.domain, short: "Domain " + o.domain }); }
  const ids = new Set();
  for (const c of d.cards) { if (!c.id || ids.has(c.id)) c.id = uniqueId(c.obj, c.term, ids); ids.add(c.id); }
  return d;
}
function uniqueId(obj, term, taken) {
  const has = taken || new Set(S.deck ? S.deck.cards.map((c) => c.id) : []);
  const base = `${obj || "x"}-${slug(term)}`;
  let id = base, n = 2;
  while (has.has(id)) id = `${base}-${n++}`;
  return id;
}
const objMap = () => Object.fromEntries(S.deck.objectives.map((o) => [o.id, o]));
const domainOf = (c) => (c.obj ? (objMap()[c.obj]?.domain ?? c.obj.split(".")[0]) : "none");
const objName = (id) => (id ? (objMap()[id]?.name || id) : "Unsorted");
function changeCount() {
  if (!S.baseDeck) return 0;
  const base = new Map(S.baseDeck.cards.map((c) => [c.id, c]));
  let n = 0;
  for (const c of S.deck.cards) {
    const b = base.get(c.id);
    if (!b) n++;
    else if (b.term !== c.term || b.def !== c.def || b.obj !== c.obj) n++;
    base.delete(c.id);
  }
  n += base.size;
  if (!n && serializeDeck(S.deck) !== S.baseText) n = 1;   // groups, categories, title or packs changed
  return n;
}
let draftTimer = 0;
function writeDraft() {
  if (!S.deck) return;
  syncIndexEntry();
  if (serializeDeck(S.deck) === S.baseText) LS.del(draftKey());
  else LS.set(draftKey(), { base: hash(S.baseText), at: Date.now(), deck: serializeDeck(S.deck) });
  if (indexDirty()) LS.set("fc-draft-index", { base: hash(S.lib.indexBase), index: S.lib.index, deleted: [...S.lib.deleted] });
  else LS.del("fc-draft-index");
}
function changed() { clearTimeout(draftTimer); draftTimer = setTimeout(writeDraft, 300); }

/* ---------- deck library ---------- */
const indexText = () => serializeDeck(S.lib.index);
const indexDirty = () => indexText() !== S.lib.indexBase || S.lib.deleted.size > 0;
const entryOf = (id) => S.lib.index.decks.find((d) => d.id === id);
function syncIndexEntry() {
  const e = S.deck && entryOf(S.activeId);
  if (e && e.title !== S.deck.title) e.title = S.deck.title;
}
function stash() {
  if (!S.activeId || !S.deck) return;
  writeDraft();
  S.lib.store[S.activeId] = { deck: S.deck, baseText: S.baseText, baseDeck: S.baseDeck };
}
function deckDirty(id) {
  if (id === S.activeId) return serializeDeck(S.deck) !== S.baseText;
  const st = S.lib.store[id];
  return !!st && serializeDeck(st.deck) !== st.baseText;
}
function dirtyIds() { return S.lib.index.decks.map((d) => d.id).filter(deckDirty); }
/* "Save to this device": the whole library kept in this browser / desktop app, used instead of the bundled decks. */
const DEVICE_KEY = "fc-device-lib";
const deviceLib = () => LS.get(DEVICE_KEY, null);
const deviceSaveAvailable = () => !S.env.inViewer;
async function allDeckTexts() {          // every deck as text, loading any that haven't been opened yet
  stash();
  const out = {};
  for (const e of S.lib.index.decks) {
    const st = S.lib.store[e.id];
    out[e.id] = st ? serializeDeck(st.deck) : await fetchDeckText(e);
  }
  return out;
}
async function saveToDevice() {
  try {
    const decks = await allDeckTexts();
    const lib = { savedAt: Date.now(), index: S.lib.index, decks };
    localStorage.setItem(DEVICE_KEY, JSON.stringify(lib));
    markAllSaved(); S.env.source = "device";
    toast(`Saved ${plural(Object.keys(decks).length, "deck")} to this device`);
  } catch (e) {
    toast(/quota/i.test(String(e)) ? "Not enough browser storage to save that much here. Export the decks instead." : `Couldn't save to this device (${e.message || e}).`);
  }
  render();
}
async function fetchDeckText(entry) {
  const dev = S.env.source === "device" ? deviceLib() : null;
  if (dev && dev.decks[entry.id]) return dev.decks[entry.id];
  if (window.EMBEDDED_LIB) {
    const d = window.EMBEDDED_LIB.decks[entry.id];
    if (!d) throw new Error(`deck ${entry.id} is missing`);
    return serializeDeck(d);
  }
  const r = await fetch("decks/" + encodeURIComponent(entry.file), { cache: "no-cache" });
  if (!r.ok) throw new Error(`decks/${entry.file} answered ${r.status}`);
  return await r.text();
}
async function activate(id) {
  stash();
  const st = S.lib.store[id];
  if (st) { S.activeId = id; S.deck = st.deck; S.baseText = st.baseText; S.baseDeck = st.baseDeck; S.draftConflict = null; }
  else useDeckText(await fetchDeckText(entryOf(id)), id);
  LS.set("fc-active", id);
  objIndex = null; S.list.sel.clear(); S.list.dom = "all"; S.list.src = "all"; S.packExp = { groups: null, title: "", desc: "" };
  Object.assign(S.study, { dom: "all", obj: null, right: 0, asked: 0 });
  rebuildOrder(true, false);
  restoreSession();
  saveSession();
}
function uniqueDeckId(base) {
  const taken = new Set(S.lib.index.decks.map((d) => d.id));
  let id = slug(base || "deck"), n = 2; const b = id;
  while (taken.has(id)) id = `${b}-${n++}`;
  return id;
}
/* Add a deck to the library and switch to it. It counts as unsaved until saved. */
function addDeck(deck) {
  stash();
  const id = uniqueDeckId(deck.id || deck.title);
  deck = normalizeDeck({ ...deck, id });
  S.lib.index.decks.push({ id, file: id + ".json", title: deck.title });
  S.lib.deleted.delete(id + ".json");
  S.activeId = id; S.deck = deck; S.baseText = ""; S.baseDeck = { cards: [] }; S.draftConflict = null;
  LS.set("fc-active", id);
  objIndex = null; S.list.sel.clear(); S.list.dom = "all"; S.list.src = "all";
  Object.assign(S.study, { dom: "all", obj: null, right: 0, asked: 0 });
  rebuildOrder(true); changed();
  return id;
}
function newEmptyDeck(title) {
  return { schema: 1, title: title || "My Flashcards", labels: { group: "Group", category: "Category" }, domains: [], objectives: [], cards: [] };
}
async function removeDeck(id) {
  const e = entryOf(id); if (!e) return;
  if (S.lib.indexBase.includes(`"file": ${JSON.stringify(e.file)}`)) S.lib.deleted.add(e.file);
  S.lib.index.decks = S.lib.index.decks.filter((d) => d.id !== id);
  delete S.lib.store[id]; LS.del(draftKey(id));
  for (const k of Object.keys(S.prog)) if (k.startsWith(id + "|")) delete S.prog[k];
  LS.set(progKey(), S.prog);
  if (S.lib.index.default === id) S.lib.index.default = S.lib.index.decks[0]?.id || "";
  if (S.activeId === id) {
    S.activeId = null; S.deck = null;
    if (S.lib.index.decks.length) await activate(S.lib.index.default || S.lib.index.decks[0].id);
    else addDeck(newEmptyDeck());
  }
  changed();
}
function markAllSaved() {
  stash();
  for (const [id, st] of Object.entries(S.lib.store)) {
    st.baseText = serializeDeck(st.deck); st.baseDeck = JSON.parse(st.baseText); LS.del(draftKey(id));
  }
  const a = S.lib.store[S.activeId]; S.baseText = a.baseText; S.baseDeck = a.baseDeck;
  S.lib.indexBase = indexText(); S.lib.deleted.clear(); LS.del("fc-draft-index");
}
/* Every file that differs from what's saved: {path: text | null (delete)} */
function pendingFiles(folder) {
  stash();
  const out = {};
  for (const id of dirtyIds()) out[`${folder}/${entryOf(id).file}`] = serializeDeck(S.lib.store[id].deck);
  if (indexDirty()) {
    out[`${folder}/index.json`] = indexText();
    for (const f of S.lib.deleted) out[`${folder}/${f}`] = null;
  }
  return out;
}

/* ---------- loading ---------- */
async function loadIndex() {
  const dev = deviceSaveAvailable() ? deviceLib() : null;
  if (dev && dev.index?.decks?.length) { S.env.source = "device"; return dev.index; }
  if (window.EMBEDDED_LIB) return window.EMBEDDED_LIB.index;
  const r = await fetch("decks/index.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`decks/index.json answered ${r.status}`);
  return await r.json();
}
function useDeckText(text, id) {
  S.activeId = id;
  S.draftConflict = null;
  S.deck = normalizeDeck(JSON.parse(text));
  S.baseText = serializeDeck(S.deck);
  S.baseDeck = JSON.parse(S.baseText);
  const draft = LS.get(draftKey(), null);
  if (draft && draft.deck) {
    if (draft.base === hash(S.baseText)) {
      try { S.deck = normalizeDeck(JSON.parse(draft.deck)); } catch (e) { LS.del(draftKey()); }
    } else {
      S.draftConflict = draft;
    }
  }
  rebuildOrder(true, false);
}
async function boot() {
  S.prog = LS.get(progKey(), {});
  try {
    const idx = await loadIndex();
    S.lib.index = { schema: 1, default: idx.default || idx.decks?.[0]?.id || "", decks: Array.isArray(idx.decks) ? idx.decks : [] };
    S.lib.indexBase = indexText();
    const di = LS.get("fc-draft-index", null);
    if (di && di.base === hash(S.lib.indexBase) && di.index?.decks) { S.lib.index = di.index; (di.deleted || []).forEach((f) => S.lib.deleted.add(f)); }
    for (const e of S.lib.index.decks) {                 // decks created but never saved live only in their drafts
      const d = LS.get(draftKey(e.id), null);
      if (d && d.base === hash("") && !S.lib.indexBase.includes(`"id": ${JSON.stringify(e.id)}`)) {
        S.lib.store[e.id] = { deck: normalizeDeck(JSON.parse(d.deck)), baseText: "", baseDeck: { cards: [] } };
      }
    }
    if (!S.lib.index.decks.length) addDeck(newEmptyDeck());
    else {
      const want = LS.get("fc-active", "");
      await activate(entryOf(want) ? want : entryOf(S.lib.index.default) ? S.lib.index.default : S.lib.index.decks[0].id);
    }
  } catch (e) {
    S.loadError = e.message || String(e);
  }
  render();
  loadPacks();
  // Claude viewer capabilities (resolve to null everywhere else)
  if (S.env.inViewer) {
    const [artifact, downloads, sample] = await Promise.all([capUse("artifact"), capUse("downloads"), capUse("sample")]);
    Object.assign(S.env, { artifact, downloads, sample });
    render();
  }
}

async function loadPacks() {
  try {
    const r = await fetch("packs/index.json", { cache: "no-cache" });
    if (r.ok) { const j = await r.json(); S.packs = Array.isArray(j) ? j : []; if (S.view === "add") render(); }
  } catch (e) { S.packs = []; }
}
async function installPack(file) {
  try {
    const r = await fetch("packs/" + encodeURIComponent(file), { cache: "no-cache" });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    S.add.deckImport = { deck: normalizeDeck(await r.json()), name: file };
  } catch (e) { toast(`Couldn't load that pack (${e.message}).`); }
  render(); window.scrollTo(0, 0);
}
const onlySamples = () => S.deck.cards.length > 0 && S.deck.cards.every((c) => c.src === "sample");
function removeSamples() {
  const n = S.deck.cards.filter((c) => c.src === "sample").length;
  S.deck.cards = S.deck.cards.filter((c) => c.src !== "sample");
  S.deck.objectives = S.deck.objectives.filter((o) => !o.sample);
  S.deck.domains = S.deck.domains.filter((d) => !d.sample);
  return n;
}

/* ---------- groups, categories, packs ---------- */
const lc = (s) => String(s ?? "").trim().toLowerCase();
function findGroup(nameOrId) {
  const k = lc(nameOrId); if (!k) return null;
  return S.deck.domains.find((d) => lc(d.id) === k || lc(d.name) === k || lc(d.short) === k) || null;
}
function addGroup(name) {
  name = String(name).trim(); if (!name) return null;
  const have = findGroup(name); if (have) return have;
  const taken = new Set(S.deck.domains.map((d) => d.id));
  const base = slug(name).split("-").map((w) => w.slice(0, 4)).join("").slice(0, 8) || "g";
  let id = base, n = 2; while (taken.has(id)) id = base + n++;
  const g = { id, name, short: name.length > 14 ? name.slice(0, 13) + "…" : name };
  S.deck.domains.push(g);
  return g;
}
function addCategory(name, groupNameOrId) {
  name = String(name).trim(); if (!name) return null;
  const g = findGroup(groupNameOrId) || addGroup(groupNameOrId || "General");
  const existing = S.deck.objectives.find((o) => o.domain === g.id && lc(o.name) === lc(name));
  if (existing) return existing;
  const nums = S.deck.objectives.filter((o) => o.domain === g.id).map((o) => +String(o.id).split(".").pop() || 0);
  const o = { id: `${g.id}.${Math.max(0, ...nums) + 1}`, domain: g.id, name };
  S.deck.objectives.push(o);
  return o;
}
/* Turn a category cell (an id like "4.6" or a name like "Subnetting") into a category id, creating it if needed. */
function resolveCat(cat, group) {
  const k = lc(cat); if (!k) return "";
  const m = objMap();
  if (m[String(cat).trim()]) return String(cat).trim();
  const g = group ? findGroup(group) : null;
  const byName = S.deck.objectives.find((o) => lc(o.name) === k && (!g || o.domain === g.id));
  if (byName) return byName.id;
  const idInText = objFromCell(cat); if (idInText) return idInText;
  const groupsBefore = new Set(S.deck.domains.map((d) => d.id));
  const o = addCategory(String(cat).trim(), group || "General");
  S.add.created.add(o.id); objIndex = null;
  for (const d of S.deck.domains) if (!groupsBefore.has(d.id)) S.add.created.add("g:" + d.id);
  return o.id;
}
function pruneCreated() {        // drop categories made during an import that ended up with no cards
  const used = new Set(S.deck.cards.map((c) => c.obj));
  S.deck.objectives = S.deck.objectives.filter((o) => !S.add.created.has(o.id) || used.has(o.id));
  const groupsUsed = new Set(S.deck.objectives.map((o) => o.domain));
  S.deck.domains = S.deck.domains.filter((d) => groupsUsed.has(d.id) || !S.add.created.has("g:" + d.id));
  S.add.created.clear();
}
const packId = (deck) => deck.id || slug(deck.title || "pack");
function installDeck(imp, mode) {          // mode: "newdeck" | "merge"
  const pid = packId(imp);
  const tagged = imp.cards.map((c) => ({ ...c, pack: pid }));
  const entry = { id: pid, title: imp.title || pid };
  if (mode === "newdeck") {
    const sampleDeck = onlySamples() ? S.activeId : null;
    addDeck({ ...imp, id: pid, cards: tagged, packs: [entry],
      domains: imp.domains.map((d) => ({ ...d, pack: pid })), objectives: imp.objectives.map((o) => ({ ...o, pack: pid })) });
    if (sampleDeck) { removeDeck(sampleDeck); if (S.lib.index.default === sampleDeck || !entryOf(S.lib.index.default)) S.lib.index.default = S.activeId; }
    return tagged.length;
  }
  for (const d of imp.domains) if (!S.deck.domains.some((x) => x.id === d.id)) S.deck.domains.push({ ...d, pack: pid });
  for (const o of imp.objectives) if (!objMap()[o.id]) S.deck.objectives.push({ ...o, pack: pid });
  const have = existingTerms(), ids = new Set(S.deck.cards.map((c) => c.id)); let n = 0;
  for (const c of tagged) if (!have.has(normTerm(c.term))) { const id = ids.has(c.id) ? uniqueId(c.obj, c.term, ids) : c.id; ids.add(id); S.deck.cards.push({ ...c, id }); n++; }
  if (n) S.deck.packs = (S.deck.packs || []).filter((p) => p.id !== pid).concat(entry);
  return n;
}
function removePack(pid) {
  const before = S.deck.cards.length;
  S.deck.cards = S.deck.cards.filter((c) => c.pack !== pid);
  const used = new Set(S.deck.cards.map((c) => c.obj));
  S.deck.objectives = S.deck.objectives.filter((o) => o.pack !== pid || used.has(o.id));
  const groupsUsed = new Set(S.deck.objectives.map((o) => o.domain));
  S.deck.domains = S.deck.domains.filter((d) => d.pack !== pid || groupsUsed.has(d.id));
  const p = (S.deck.packs || []).find((x) => x.id === pid);
  S.deck.packs = (S.deck.packs || []).filter((x) => x.id !== pid);
  if (!S.deck.packs.length) delete S.deck.packs;
  if (p && S.deck.title === p.title) { S.deck.title = "My Flashcards"; delete S.deck.labels; delete S.deck.description; delete S.deck.sources; }
  return before - S.deck.cards.length;
}
function deleteCards(ids) {
  const kill = new Set(ids); if (!kill.size) return;
  const snapshot = S.deck.cards.slice();
  S.deck.cards = S.deck.cards.filter((c) => !kill.has(c.id));
  const n = snapshot.length - S.deck.cards.length;
  S.list.sel.clear(); objIndex = null; changed(); refreshSession(); render();
  toast(`Deleted ${plural(n, "card")}`, "Undo", () => { S.deck.cards = snapshot; changed(); refreshSession(); render(); });
}
function cardSource(c) { return c.pack ? "pack:" + c.pack : c.src === "sample" ? "sample" : "mine"; }
function buildPack() {
  const E = S.packExp, groups = E.groups || new Set(S.deck.domains.map((d) => d.id));
  const strip = ({ sample, pack, _auto, ...r }) => r;
  const domains = S.deck.domains.filter((d) => groups.has(d.id)).map(strip);
  const objectives = S.deck.objectives.filter((o) => groups.has(o.domain)).map(strip);
  const keep = new Set(objectives.map((o) => o.id));
  const cards = S.deck.cards.filter((c) => keep.has(c.obj)).map(({ pack, ...c }) => cleanCard(c));
  const title = (E.title || S.deck.title).trim();
  const pk = { schema: 1, id: slug(title), title, description: (E.desc || "").trim() };
  if (S.deck.labels) pk.labels = S.deck.labels;
  return Object.assign(pk, { domains, objectives, cards });
}

/* ---------- study ---------- */
function studyPool() {
  const st = S.study;
  return S.deck.cards.filter((c) =>
    (st.dom === "all" || domainOf(c) === st.dom) && (!st.obj || c.obj === st.obj) &&
    (st.filter === "all" || (st.filter === "new" && S.prog[pk(c)] !== "k") || (st.filter === "again" && S.prog[pk(c)] === "a")));
}
/* A study session: the cards still to study this round (order), plus the Known and Review piles.
 * When a round runs out, the Review pile becomes the next round, until everything is Known. */
const sessionSig = () => `${S.study.dom}|${S.study.obj || ""}|${S.study.filter}`;
const sessionKey = () => "fc-session:" + S.activeId;
function rebuildOrder(shuf, save = true) {
  const ids = studyPool().map((c) => c.id);
  Object.assign(S.study, { order: shuf ? shuffle(ids) : ids, known: [], review: [], round: 1, missed: new Set(), history: [], pile: "study", flipped: false, quiz: null,
    reveal: null, elapsed: 0, typedN: 0, typedMs: 0, timeouts: 0 });
  drawTyping(); if (save) saveSession();
}
/* After edits: keep the session's piles, drop cards that are gone, queue new matching cards. */
function refreshSession() {
  const st = S.study, pool = studyPool().map((c) => c.id), inPool = new Set(pool);
  const keep = (a) => a.filter((id) => inPool.has(id));
  const top = st.order[0];
  st.order = keep(st.order); st.known = keep(st.known); st.review = keep(st.review);
  const seen = new Set([...st.order, ...st.known, ...st.review]);
  st.order.push(...pool.filter((id) => !seen.has(id)));
  if (st.order[0] !== top) { st.flipped = false; st.quiz = null; drawTyping(); }
  saveSession();
}
function saveSession() {
  const st = S.study; if (!S.activeId) return;
  LS.set(sessionKey(), { sig: sessionSig(), order: st.order, known: st.known, review: st.review, round: st.round, missed: [...st.missed],
    elapsed: Math.round(st.elapsed), typedN: st.typedN, typedMs: Math.round(st.typedMs), timeouts: st.timeouts });
}
function restoreSession() {
  const saved = LS.get(sessionKey(), null), st = S.study;
  if (!saved) return;
  const [dom, obj, filter] = String(saved.sig || "").split("|");
  const have = new Set(S.deck.cards.map((c) => c.id)), keep = (a) => (a || []).filter((id) => have.has(id));
  if (dom !== "all" && !S.deck.domains.some((d) => d.id === dom)) return;
  Object.assign(st, { dom, obj: obj || null, filter: filter || "all", order: keep(saved.order), known: keep(saved.known), review: keep(saved.review),
    round: saved.round || 1, missed: new Set(keep(saved.missed)), history: [], pile: "study", flipped: false, quiz: null, reveal: null,
    elapsed: saved.elapsed || 0, typedN: saved.typedN || 0, typedMs: saved.typedMs || 0, timeouts: saved.timeouts || 0 });
  drawTyping();
}
const curCard = () => S.deck.cards.find((c) => c.id === S.study.order[0]);
function drawTyping() {          // decide whether the card now on top asks for a typed answer
  const st = S.study, c = curCard();
  st.typing = c && st.mode === "flip" && c.term.length <= 80 && Math.random() < (+S.settings.typeChance || 0) ? { id: c.id, value: "", result: null, used: 0 } : null;
}
function advance() {
  const st = S.study;
  st.flipped = false; st.quiz = null; st.reveal = null;
  if (!st.order.length && st.review.length) {
    st.order = shuffle(st.review.splice(0)); st.round++;
    toast(`Round ${st.round}: ${plural(st.order.length, "card")} from your Review pile`);
  }
  drawTyping(); saveSession(); render();
  if (st.typing) setTimeout(() => $("#type-ans")?.focus(), 0);
}
function record(v) {                // put the top card in a pile without moving on
  const st = S.study, c = curCard(); if (!c) return null;
  const prev = S.prog[pk(c)];
  S.prog[pk(c)] = v; LS.set(progKey(), S.prog);
  st.order.shift();
  (v === "k" ? st.known : st.review).push(c.id);
  if (v === "a") st.missed.add(c.id);
  st.history.push({ id: c.id, v, prev, round: st.round });
  return c;
}
function grade(v) {
  if (S.study.reveal) { advance(); return; }
  if (record(v)) advance();
}
function undoGrade() {
  const st = S.study, h = st.history.pop(); if (!h) { toast("Nothing to undo"); return; }
  st.reveal = null;
  if (h.round !== st.round) {                      // the undone card was graded last round: put this round back
    st.review = st.review.concat(st.order); st.order = []; st.round = h.round;
  }
  const pile = h.v === "k" ? st.known : st.review, i = pile.lastIndexOf(h.id);
  if (i >= 0) pile.splice(i, 1);
  st.order.unshift(h.id);
  const key = S.activeId + "|" + h.id;
  if (h.prev) S.prog[key] = h.prev; else delete S.prog[key];
  LS.set(progKey(), S.prog);
  st.flipped = false; st.quiz = null; drawTyping(); saveSession(); render();
}
function skipCard() {
  const st = S.study; if (st.order.length < 2) return;
  st.order.push(st.order.shift()); st.flipped = false; st.quiz = null; drawTyping(); saveSession(); render();
}
function moveBetweenPiles(id, to) {
  const st = S.study, from = to === "k" ? st.review : st.known, i = from.indexOf(id);
  if (i < 0) return;
  from.splice(i, 1); (to === "k" ? st.known : st.review).push(id);
  const c = S.deck.cards.find((x) => x.id === id);
  if (c) { S.prog[pk(c)] = to; LS.set(progKey(), S.prog); }
  if (to === "a") st.missed.add(id);
  if (!st.order.length && st.review.length) { st.pile = "study"; advance(); return; }
  saveSession(); render();
}
/* Typed answers: forgiving about case, punctuation, parentheses, "A / B" alternatives and small typos. */
const normAns = (s) => String(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9+#]+/g, " ").trim();
function answerVariants(term) {
  const out = new Set([term, term.replace(/\s*\([^)]*\)/g, "")]);
  for (const m of term.matchAll(/\(([^)]*)\)/g)) out.add(m[1]);
  for (const part of term.split(/\s*[\/;,]\s*|\s+or\s+/i)) out.add(part);
  out.add(term.replace(/^(the|a|an)\s+/i, ""));
  return [...out].map(normAns).filter((v) => v.length > 0);
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function checkAnswer(input, term) {
  const a = normAns(input).replace(/^(the|a|an)\s+/, "");
  if (!a) return { ok: false, close: false };
  let best = 0;
  for (const v of answerVariants(term)) {
    if (a === v) return { ok: true, exact: true };
    best = Math.max(best, 1 - lev(a, v) / Math.max(a.length, v.length));
  }
  return { ok: best >= 0.8 && a.length >= 3, close: best >= 0.8 && a.length >= 3 };
}
/* how: "check" | "giveup" | "timeout". Wrong answers go straight to Review; the answer stays on screen until Next. */
function submitTyped(how) {
  const st = S.study, c = curCard(), t = st.typing; if (!c || !t || t.result) return;
  t.value = how === "check" ? ($("#type-ans")?.value || "") : ($("#type-ans")?.value || "");
  t.result = how === "giveup" ? { ok: false, gaveUp: true } : how === "timeout" ? { ok: false, timeout: true } : checkAnswer(t.value, c.term);
  if (S.settings.timed) { st.typedN++; st.typedMs += t.used; if (how === "timeout") st.timeouts++; }
  if (!t.result.ok) {
    record("a");
    st.reveal = { id: c.id, value: t.value, result: t.result };
    saveSession(); render();
    setTimeout(() => $("#rv-next")?.focus(), 0);
    return;
  }
  render();
  setTimeout(() => $("#g-know")?.focus(), 0);
}
function revealKnewIt() {         // override: "Actually, I knew it"
  const st = S.study, r = st.reveal; if (!r) return;
  const h = st.history[st.history.length - 1];
  if (h && h.id === r.id) { h.v = "k"; }
  const i = st.review.lastIndexOf(r.id); if (i >= 0) st.review.splice(i, 1);
  st.known.push(r.id);
  if (!st.history.some((x) => x.id === r.id && x.v === "a")) st.missed.delete(r.id);
  S.prog[S.activeId + "|" + r.id] = "k"; LS.set(progKey(), S.prog);
  advance();
}
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
/* One ticker for the session clock and the typed-answer countdown. Time only counts while the Study tab is visible. */
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now(), dt = now - lastTick; lastTick = now;
  if (!S.deck || !S.settings.timed || S.view !== "study" || document.hidden || S.modal) return;
  const st = S.study, total = st.order.length + st.known.length + st.review.length;
  if (!total || (!st.order.length && !st.review.length && !st.reveal)) return;
  st.elapsed += dt;
  const clock = $("#clock"); if (clock) clock.textContent = fmtTime(st.elapsed);
  const t = st.typing, c = curCard();
  if (t && c && t.id === c.id && !t.result && !st.reveal && st.pile === "study") {
    t.used += dt;
    const left = Math.max(0, S.settings.timedSecs * 1000 - t.used);
    const bar = $("#tbar"), sec = $("#tsec");
    if (bar) bar.style.width = (100 * left / (S.settings.timedSecs * 1000)).toFixed(1) + "%";
    if (sec) sec.textContent = Math.ceil(left / 1000);
    if (left <= 0) submitTyped("timeout");
  }
}, 100);
function makeQuiz(c) {
  let pool = S.deck.cards.filter((x) => x.obj === c.obj && x.id !== c.id && normTerm(x.term) !== normTerm(c.term));
  if (pool.length < 3) pool = pool.concat(S.deck.cards.filter((x) => domainOf(x) === domainOf(c) && x.obj !== c.obj));
  if (pool.length < 3) pool = pool.concat(S.deck.cards.filter((x) => x.id !== c.id && domainOf(x) !== domainOf(c)));
  S.study.quiz = { id: c.id, opts: shuffle([c, ...shuffle(pool.slice()).slice(0, 3)]), picked: null };
}

/* ---------- rendering ---------- */
function render() {
  const app = $("#app");
  if (S.loadError) { app.innerHTML = viewLoadError(); return; }
  if (!S.deck) return;
  const active = document.activeElement;
  const keep = active && active.id ? { id: active.id, s: active.selectionStart, e: active.selectionEnd } : null;
  const skin = S.deck.theme || "";
  if (skin) document.documentElement.dataset.skin = skin; else delete document.documentElement.dataset.skin;
  document.title = S.deck.title + (/flashcard/i.test(S.deck.title) ? "" : " Flashcards");
  app.innerHTML = viewHeader() + ({ study: viewStudy, cards: viewCards, add: viewAdd, save: viewSave }[S.view] || viewStudy)();
  renderModal();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch (e) { /* not a text field */ } }
  }
}

function viewLoadError() {
  return `<header class="top"><h1>Flashcards</h1></header>
  <div class="panel">
    <h2>The card deck didn't load</h2>
    <p>${esc(S.loadError)}.</p>
    <p class="muted">Browsers block reading <code>decks/</code> when <code>index.html</code> is opened straight from your computer. Either run <code>python3 -m http.server</code> in the project folder and open <code>http://localhost:8000</code>, use the offline build (<code>python3 tools/deck.py build</code>), or open a deck file here:</p>
    <div class="row"><input type="file" id="open-deck" accept=".json,application/json"></div>
  </div>`;
}

function viewHeader() {
  const n = changeCount();
  const others = dirtyIds().filter((id) => id !== S.activeId).length + (indexDirty() && !n ? 1 : 0);
  const c = S.deck.cards.length;
  const conflict = S.draftConflict ? `<div class="note warn row between">
      <span>You have unsaved edits from ${esc(new Date(S.draftConflict.at).toLocaleString())}, made before the saved deck last changed.</span>
      <span class="row"><button class="btn small" data-act="draft-keep">Keep my edits</button><button class="btn small" data-act="draft-drop">Use the saved deck</button></span>
    </div>` : "";
  return `<header class="top">
      <span class="row title-row"><h1>${esc(S.deck.title)}${/flashcard/i.test(S.deck.title) ? "" : " <span>Flashcards</span>"}</h1>
        <button class="btn small ghost" data-act="rename" aria-label="Rename this deck" title="Rename this deck">✎ Rename</button></span>
      <span class="status ${n || others ? "dirty" : ""}"><span class="dot"></span>${n || others ? `${n ? plural(n, "unsaved change") : ""}${n && others ? " + " : ""}${others ? plural(others, "other deck") + " changed" : ""} <button class="btn small" data-act="view" data-v="save">Save</button>` : "All changes saved"}</span>
    </header>
    <div class="row deckbar">
      <label class="row small muted" for="deck-switch">Deck
        <select id="deck-switch">${S.lib.index.decks.map((d) => `<option value="${esc(d.id)}" ${d.id === S.activeId ? "selected" : ""}>${esc(d.title)}${deckDirty(d.id) ? " •" : ""}</option>`).join("")}
          <option value="__new">+ New deck…</option></select></label>
      ${S.env.installPrompt && !S.env.installed ? `<button class="btn small primary" data-act="install-app">⬇ Install app</button>` : ""}
      <label class="row small muted" for="theme-pick">Theme
        <select id="theme-pick">${THEMES.map(([v, l]) => `<option value="${v}" ${(S.deck.theme || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    </div>
    ${conflict}
    <nav class="tabs" role="tablist">
      ${[["study", "Study"], ["cards", `Cards<span class="count">${c}</span>`], ["add", "Add cards"], ["save", "Save &amp; export"]]
        .map(([v, l]) => `<button role="tab" aria-selected="${S.view === v}" data-act="view" data-v="${v}">${l}</button>`).join("")}
    </nav>`;
}

function domainTiles(sel, act) {
  const L = lab();
  const doms = [{ id: "all", name: "All " + L.gs, short: "All" }, ...S.deck.domains];
  if (S.deck.cards.some((c) => !c.obj)) doms.push({ id: "none", name: "Unsorted", short: "Unsorted" });
  return `<nav class="domains" aria-label="Domains">${doms.map((d, i) => {
    const cs = S.deck.cards.filter((c) => d.id === "all" || domainOf(c) === d.id);
    const k = cs.filter((c) => S.prog[pk(c)] === "k").length;
    const label = d.id === "all" ? "Everything" : d.id === "none" ? "No " + L.c : d.tag ? esc(d.tag) : d.weight ? `D${esc(d.id)} · ${d.weight}%` : `${esc(L.G)} ${i}`;
    return `<button class="dom" data-act="${act}" data-d="${esc(d.id)}" aria-pressed="${sel === d.id}">
      <span class="k">${label}</span>
      <span class="n"><span class="long">${esc(d.name)}</span><span class="short">${esc(d.short || d.name)}</span></span>
      <span class="bar"><i style="width:${cs.length ? (100 * k / cs.length).toFixed(1) : 0}%"></i></span>
      <span class="c">${k} / ${cs.length} known</span></button>`;
  }).join("")}</nav>`;
}
function objChips(dom, sel, act) {
  if (dom === "all" || dom === "none") return "";
  const os = S.deck.objectives.filter((o) => o.domain === dom);
  return `<div class="objs" aria-label="Objectives"><button class="chip" data-act="${act}" data-o="" aria-pressed="${!sel}"><span>All ${lab().cs}</span></button>${
    os.map((o) => `<button class="chip" data-act="${act}" data-o="${esc(o.id)}" aria-pressed="${sel === o.id}"><b>${esc(o.id)}</b><span>${esc(o.name)}</span></button>`).join("")}</div>`;
}
function objOptions(selected, { auto = false } = {}) {
  const L = lab();
  let html = auto ? `<option value="auto" ${selected === "auto" ? "selected" : ""}>Auto-detect ${L.c}</option>` : "";
  html += `<option value="" ${selected === "" ? "selected" : ""}>No ${L.c}</option>`;
  for (const d of S.deck.domains) {
    html += `<optgroup label="${esc(d.name)}">` + S.deck.objectives.filter((o) => o.domain === d.id)
      .map((o) => `<option value="${esc(o.id)}" ${selected === o.id ? "selected" : ""}>${esc(o.id)} ${esc(o.name)}</option>`).join("") + "</optgroup>";
  }
  return html;
}

function pileList(ids, to) {
  const cards = ids.map((id) => S.deck.cards.find((c) => c.id === id)).filter(Boolean);
  if (!cards.length) return `<div class="empty">${to === "a" ? "Nothing in Known yet. Cards you mark “Know it” land here." : "Nothing in Review. Cards you mark “Review again” land here and come back in the next round."}</div>`;
  return `<div class="list">${cards.map((c) => `<div class="item">
      <span class="objcode">${esc(c.obj || "—")}</span>
      <div><div class="t">${esc(c.term)}</div><div class="d">${esc(c.def)}</div></div>
      <div class="acts"><button class="btn small" data-act="pile-move" data-id="${esc(c.id)}" data-to="${to}">${to === "k" ? "I know it now" : "Back to Review"}</button></div>
    </div>`).join("")}</div>`;
}
function viewStudy() {
  const st = S.study;
  const seg = (id, label, on) => `<button data-act="${id}" aria-pressed="${on}">${label}</button>`;
  const total = st.order.length + st.known.length + st.review.length;
  const done = total > 0 && !st.order.length && !st.review.length;
  let stage;
  if (!total) {
    stage = `<div class="empty">${st.filter === "again" ? "Nothing you've missed before is in this set. Cards you mark “Review again” show up here."
      : st.filter === "new" ? "You know every card in this set. Switch to All to keep them fresh." : "No cards here yet. Add your own in the Add cards tab, or install a deck pack there."}</div>`;
  } else if (st.pile !== "study") {
    stage = `<div class="row between"><h2>${st.pile === "known" ? `Known · ${st.known.length}` : `Review · ${st.review.length}`}</h2><button class="btn" data-act="pile" data-p="study">Back to studying</button></div>
      ${st.pile === "known" ? pileList(st.known, "a") : pileList(st.review, "k")}`;
  } else if (done) {
    stage = `<div class="panel done">
      <h2>Every card is in Known</h2>
      <p class="muted">${plural(st.known.length, "card")} in ${plural(st.round, "round")}. ${st.missed.size ? `You missed ${plural(st.missed.size, "card")} along the way.` : "You didn't miss a single one."}</p>
      ${st.elapsed > 0 ? `<div class="stats"><span><b>${fmtTime(st.elapsed)}</b>total time</span>${st.typedN ? `<span><b>${(st.typedMs / st.typedN / 1000).toFixed(1)}s</b>average typed answer</span><span><b>${st.timeouts}</b>ran out of time</span>` : ""}</div>` : ""}
      <div class="row"><button class="btn primary" data-act="shuffle">Study this set again</button>${st.missed.size ? `<button class="btn" data-act="redo-missed">Practice the ${plural(st.missed.size, "card")} I missed</button>` : ""}</div>
    </div>`;
  } else {
    const c = curCard() || S.deck.cards.find((x) => x.id === st.reveal?.id);
    const meta = `<div class="meta"><span class="row"><span class="objcode">${esc(c.obj || "—")}</span> ${esc(objName(c.obj))}</span>
      <span class="row"><button class="btn small" data-act="edit" data-id="${esc(c.id)}">Edit card</button></span></div>`;
    const gradeBtns = (sugg) => `<div class="grade">
        <button class="again-b ${sugg === "a" ? "sugg" : ""}" id="g-again" data-act="grade" data-g="a">Review again <span class="cnt" aria-label="${st.review.length} in Review">${st.review.length}</span></button>
        <button class="know-b ${sugg === "k" ? "sugg" : ""}" id="g-know" data-act="grade" data-g="k">Know it <span class="cnt" aria-label="${st.known.length} known">${st.known.length}</span></button></div>`;
    const navRow = `<div class="row between"><button class="btn" data-act="undo" ${st.history.length ? "" : "disabled"}>↶ Undo</button><button class="btn" data-act="skip" ${st.order.length > 1 ? "" : "disabled"}>Skip for now →</button></div>`;
    if (st.reveal) {
      const r = st.reveal, rc = S.deck.cards.find((x) => x.id === r.id) || c;
      stage = `<div class="meta"><span class="row"><span class="objcode">${esc(rc.obj || "—")}</span> ${esc(objName(rc.obj))}</span></div>
        <div class="face typed"><span class="lab">Type the term for this definition</span>
          <div class="txt prose">${esc(rc.def)}</div>
          <div class="verdict no">
            <b>${r.result.timeout ? "Time's up." : r.result.gaveUp ? "Here's the answer:" : "Not quite."}</b>
            ${r.value && !r.result.gaveUp ? `<span class="muted">You typed “${esc(r.value)}”.</span>` : ""}
            <span class="big">${esc(rc.term)}</span>
            <span class="small">Moved to your Review pile. It comes back next round.</span></div>
        </div>
        <div class="row between"><span class="row"><button class="btn" data-act="undo">↶ Undo</button><button class="btn" data-act="rv-knew">Actually, I knew it</button></span><button class="btn primary" id="rv-next" data-act="rv-next">Next →</button></div>
        <p class="muted small">Press Enter for the next card.</p>`;
    } else if (st.mode === "flip" && st.typing && st.typing.id === c.id) {
      const t = st.typing, r = t.result;
      stage = meta + `
        <div class="face typed"><span class="lab">Type the term for this definition</span>
          <div class="txt prose">${esc(c.def)}</div>
          ${r ? `<div class="verdict ${r.ok ? "ok" : "no"}">
              <b>${r.ok ? (r.exact ? "Correct!" : "Close enough. Check the spelling.") : r.gaveUp ? "Here's the answer:" : "Not quite."}</b>
              ${!r.ok && !r.gaveUp && t.value ? `<span class="muted">You typed “${esc(t.value)}”.</span>` : ""}
              <span class="big">${esc(c.term)}</span></div>`
            : `<div class="row typerow"><input type="text" id="type-ans" placeholder="Your answer" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(t.value)}">
              <button class="btn primary" data-act="type-check">Check</button><button class="btn" data-act="type-giveup">I don't know</button></div>
              ${S.settings.timed ? `<div class="countdown" aria-live="off"><span class="timer"><i id="tbar" style="width:${(100 * Math.max(0, S.settings.timedSecs * 1000 - t.used) / (S.settings.timedSecs * 1000)).toFixed(1)}%"></i></span><span class="small"><b id="tsec">${Math.ceil(Math.max(0, S.settings.timedSecs * 1000 - t.used) / 1000)}</b>s left</span></div>` : ""}
              <span class="hint">Press Enter to check.${S.settings.timed ? " Running out of time sends the card to Review." : ""}</span>`}
        </div>
        ${r ? gradeBtns("k") + `<p class="muted small">Press Enter to accept Know it, or pick Review again.</p>` : gradeBtns("")}
        ${navRow}`;
    } else if (st.mode === "flip") {
      const [fl, fv, bl, bv] = st.defFirst ? ["Definition", c.def, "Term", c.term] : ["Term", c.term, "Definition", c.def];
      stage = meta + `
        <div class="card ${st.flipped ? "flipped" : ""}" id="card" data-act="flip" role="button" tabindex="0" aria-label="Flip card">
          <div class="card-in">
            <div class="face front"><span class="lab">${fl}</span><div class="txt ${st.defFirst ? "prose" : "big"}">${esc(fv)}</div><span class="hint">Click or press Space to flip</span></div>
            <div class="face back"><span class="lab">${bl}</span><div class="txt ${st.defFirst ? "big" : "prose"}">${esc(bv)}</div></div>
          </div>
        </div>
        ${gradeBtns("")}
        ${navRow}`;
    } else {
      if (!st.quiz || st.quiz.id !== c.id) makeQuiz(c);
      const q = st.quiz;
      stage = meta + `
        <div class="face" style="min-height:0"><span class="lab">${st.defFirst ? "Which term matches this definition?" : "Which definition matches this term?"}</span>
          <div class="txt ${st.defFirst ? "prose" : "big"}">${esc(st.defFirst ? c.def : c.term)}</div></div>
        <div class="quiz">${q.opts.map((o, j) => `<button class="opt ${q.picked != null ? (o.id === c.id ? "right" : j === q.picked ? "wrong" : "") : ""}" data-act="pick" data-j="${j}" ${q.picked != null ? "disabled" : ""}>${esc(st.defFirst ? o.term : o.def)}</button>`).join("")}</div>
        <div class="row between"><button class="btn" data-act="undo" ${st.history.length ? "" : "disabled"}>↶ Undo</button>
          ${q.picked != null ? `<button class="btn primary" data-act="quiz-next">${q.opts[q.picked].id === c.id ? "Next (goes to Known) →" : "Next (goes to Review) →"}</button>` : `<button class="btn" data-act="skip" ${st.order.length > 1 ? "" : "disabled"}>Skip for now →</button>`}</div>`;
    }
  }
  const piles = total ? `<div class="piles" role="group" aria-label="Study piles">
      <button data-act="pile" data-p="study" aria-pressed="${st.pile === "study"}"><span class="pl">Studying</span><b>${st.order.length}</b><span class="ps">left · round ${st.round}${S.settings.timed ? ` · ⏱ <span id="clock">${fmtTime(st.elapsed)}</span>` : ""}</span></button>
      <button data-act="pile" data-p="review" aria-pressed="${st.pile === "review"}" class="pr"><span class="pl">Review</span><b>${st.review.length}</b><span class="ps">${st.order.length && st.review.length ? "next round" : "to retry"}</span></button>
      <button data-act="pile" data-p="known" aria-pressed="${st.pile === "known"}" class="pk"><span class="pl">Known</span><b>${st.known.length}</b><span class="ps">of ${total}</span></button>
    </div>` : "";
  const samples = S.deck.cards.filter((c) => c.src === "sample").length;
  const banner = samples ? `<div class="note row between"><span>${plural(samples, "sample card")} show how the app works. Install a deck pack or add your own cards, then remove the samples.</span>
      <span class="row"><button class="btn small" data-act="view" data-v="add">Add cards</button><button class="btn small danger" data-act="rm-samples">Remove sample cards</button></span></div>` : "";
  return banner + domainTiles(st.dom, "study-dom") + objChips(st.dom, st.obj, "study-obj") + `
    <div class="row between">
      <div class="seg" role="group" aria-label="Mode">${seg("mode-flip", "Flip cards", st.mode === "flip")}${seg("mode-quiz", "Quiz", st.mode === "quiz")}</div>
      <div class="seg" role="group" aria-label="Which cards">${seg("f-all", "All", st.filter === "all")}${seg("f-new", "Not known yet", st.filter === "new")}${seg("f-again", "Missed before", st.filter === "again")}</div>
      <div class="row">${st.mode === "flip" ? `<label class="row small muted" for="type-chance">Type answers <select id="type-chance">${TYPE_CHANCES.map(([v, l]) => `<option value="${v}" ${+S.settings.typeChance === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
        ${st.mode === "flip" ? `<span class="row timed-ctl"><button class="btn ${S.settings.timed ? "on" : ""}" data-act="timed" aria-pressed="${!!S.settings.timed}">⏱ Timed${S.settings.timed ? " on" : ""}</button>
          ${S.settings.timed ? `<select id="timed-secs" aria-label="Seconds per typed answer">${[14, 10, 7, 5].map((v) => `<option value="${v}" ${S.settings.timedSecs === v ? "selected" : ""}>${v} s</option>`).join("")}</select>` : ""}</span>` : ""}
        <button class="btn" data-act="dir">${st.defFirst ? "Show term first" : "Show definition first"}</button><button class="btn" data-act="shuffle">Restart</button></div>
    ${st.mode === "flip" && S.settings.timed && !+S.settings.typeChance ? `<p class="note">Timed mode counts down on typed answers. Set <b>Type answers</b> to Sometimes, Often or Always to get them.</p>` : ""}
    </div>
    ${piles}
    <section class="stage" aria-live="polite">${stage}</section>
    <div class="keys"><span><kbd>Space</kbd> flip</span><span><kbd>1</kbd> review again</span><span><kbd>2</kbd> know it</span><span><kbd>←</kbd> undo</span><span><kbd>→</kbd> skip</span><span><kbd>E</kbd> edit</span></div>`;
}

function listMatches() {
  const L = S.list, q = L.q.trim().toLowerCase();
  return S.deck.cards.filter((c) => (L.dom === "all" || domainOf(c) === L.dom || c.obj === L.dom) &&
    (L.src === "all" || cardSource(c) === L.src) &&
    (!q || c.term.toLowerCase().includes(q) || c.def.toLowerCase().includes(q) || (c.obj || "").startsWith(q)));
}
function listBody() {
  const m = listMatches(), sel = S.list.sel;
  const allOn = m.length > 0 && m.every((c) => sel.has(c.id));
  const bulk = `<div class="bulk row between">
      <label class="row small"><input type="checkbox" data-act="sel-matching" ${allOn ? "checked" : ""}> Select all ${plural(m.length, "matching card")}</label>
      ${sel.size ? `<span class="row"><b class="small">${sel.size} selected</b>
        <select id="bulk-move" aria-label="Move selected cards"><option value="__">Move to…</option>${objOptions("__none__")}</select>
        <button class="btn small danger" data-act="bulk-del">Delete ${plural(sel.size, "card")}</button>
        <button class="btn small" data-act="sel-clear">Clear</button></span>` : ""}
    </div>`;
  const rows = m.slice(0, S.list.limit).map((c) => `<div class="item sel-item">
      <input type="checkbox" data-act="sel" data-id="${esc(c.id)}" ${sel.has(c.id) ? "checked" : ""} aria-label="Select ${esc(c.term)}">
      <span class="objcode">${esc(c.obj || "—")}</span>
      <div><div class="t">${esc(c.term)}</div><div class="d">${esc(c.def)}</div></div>
      <div class="acts"><button class="btn small" data-act="edit" data-id="${esc(c.id)}">Edit</button><button class="btn small danger" data-act="del" data-id="${esc(c.id)}">Delete</button></div>
    </div>`).join("");
  return bulk + `${m.length > S.list.limit ? `<p class="muted small">Showing the first ${S.list.limit} of ${m.length}.</p>` : ""}
    ${m.length ? `<div class="list">${rows}${m.length > S.list.limit ? `<div class="more"><button class="btn" data-act="more">Show ${Math.min(300, m.length - S.list.limit)} more</button></div>` : ""}</div>` : `<div class="empty">No cards match.</div>`}`;
}
function viewCards() {
  const L = lab();
  const opts = [`<option value="all">All ${L.gs}</option>`, ...S.deck.domains.map((d) => `<optgroup label="${esc(d.name)}"><option value="${esc(d.id)}">All of ${esc(d.short || d.name)}</option>${
    S.deck.objectives.filter((o) => o.domain === d.id).map((o) => `<option value="${esc(o.id)}">${esc(o.id)} ${esc(o.name)}</option>`).join("")}</optgroup>`)];
  if (S.deck.cards.some((c) => !c.obj)) opts.push(`<option value="none">Unsorted</option>`);
  const srcs = [["all", "All sources"], ["mine", "My own cards"]];
  if (S.deck.cards.some((c) => c.src === "sample")) srcs.push(["sample", "Sample cards"]);
  for (const p of S.deck.packs || []) srcs.push(["pack:" + p.id, "Pack: " + p.title]);
  return `${S.list.org ? viewOrganize() : ""}<div class="row">
      <input type="search" id="list-q" placeholder="Search terms and definitions" value="${esc(S.list.q)}" style="flex:1 1 220px">
      <select id="list-dom" aria-label="Filter by ${L.g} or ${L.c}">${opts.join("").replace(`value="${esc(S.list.dom)}"`, `value="${esc(S.list.dom)}" selected`)}</select>
      <select id="list-src" aria-label="Filter by source">${srcs.map(([v, l]) => `<option value="${esc(v)}" ${S.list.src === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <button class="btn" data-act="org-toggle" aria-pressed="${S.list.org}">${S.list.org ? "Hide" : "Manage"} ${L.gs}, ${L.cs} &amp; packs</button>
      <button class="btn primary" data-act="new">New card</button>
    </div>
    <div id="list-body">${listBody()}</div>`;
}

function viewOrganize() {
  const L = lab(), count = (pred) => S.deck.cards.filter(pred).length;
  const packs = (S.deck.packs || []).map((p) => `<div class="item" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="t">${esc(p.title)}</div><div class="d">${plural(count((c) => c.pack === p.id), "card")} from this pack</div></div>
      <div class="acts"><button class="btn small danger" data-act="pack-rm" data-p="${esc(p.id)}">Remove pack</button></div></div>`).join("");
  const groups = S.deck.domains.map((d) => {
    const objs = S.deck.objectives.filter((o) => o.domain === d.id);
    const n = count((c) => domainOf(c) === d.id);
    return `<div class="org-g">
      <div class="row between"><span class="row" style="flex:1 1 260px"><span class="objcode">${esc(d.id)}</span>
        <input type="text" id="g-name-${esc(d.id)}" data-org="g" data-id="${esc(d.id)}" value="${esc(d.name)}" aria-label="${L.G} name" style="flex:1"></span>
        <span class="row"><span class="muted small">${plural(n, "card")}</span><button class="btn small danger" data-act="g-del" data-id="${esc(d.id)}">${n ? `Delete with its ${plural(n, "card")}` : "Delete"}</button></span></div>
      ${objs.map((o) => { const k = count((c) => c.obj === o.id); return `<div class="row between org-c">
        <span class="row" style="flex:1 1 240px"><span class="objcode">${esc(o.id)}</span><input type="text" id="c-name-${esc(o.id)}" data-org="c" data-id="${esc(o.id)}" value="${esc(o.name)}" aria-label="${L.C} name" style="flex:1"></span>
        <span class="row"><span class="muted small">${plural(k, "card")}</span><button class="btn small danger" data-act="c-del" data-id="${esc(o.id)}">${k ? `Delete with its ${plural(k, "card")}` : "Delete"}</button></span></div>`; }).join("")}
      <div class="row org-c"><input type="text" id="c-new-${esc(d.id)}" placeholder="New ${L.c} in ${esc(d.name)}" style="flex:1 1 200px"><button class="btn small" data-act="c-add" data-id="${esc(d.id)}">Add ${L.c}</button></div>
    </div>`;
  }).join("");
  return `<div class="panel">
      <h2>Deck</h2>
      <div class="grid2">
        <label class="field">Deck name<input type="text" id="deck-title" data-org="title" value="${esc(S.deck.title)}"></label>
        <label class="field">Description<input type="text" id="deck-desc" data-org="desc" value="${esc(S.deck.description || "")}"></label>
        <label class="field">Word for groups<input type="text" id="deck-lg" data-org="lg" value="${esc(L.G)}" placeholder="Group"></label>
        <label class="field">Word for categories<input type="text" id="deck-lc" data-org="lc" value="${esc(L.C)}" placeholder="Category"></label>
      </div>
      <div class="field"><span class="small muted">Theme</span><div class="swatches">${THEMES.map(([v, l]) => `<button class="swatch" data-act="theme" data-t="${v}" aria-pressed="${(S.deck.theme || "") === v}"><span class="sw sw-${v || "auto"}"></span>${l}</button>`).join("")}</div></div>
      <div class="row between"><span class="muted small">${S.lib.index.decks.length > 1 ? `This is one of ${S.lib.index.decks.length} decks.` : "This is your only deck."}${S.lib.index.default === S.activeId ? " It opens first on a new device." : ""}</span>
        <span class="row">${S.lib.index.default !== S.activeId ? `<button class="btn small" data-act="deck-default">Open this deck first</button>` : ""}<button class="btn small danger" data-act="deck-del">Delete this deck</button></span></div>
    </div>
    <div class="panel">
      <h2>Installed packs</h2>
      ${packs ? `<div class="list">${packs}</div><p class="muted small">Removing a pack deletes its cards (including any you edited) and any of its ${L.gs} and ${L.cs} left empty. Undo by discarding unsaved changes.</p>` : `<p class="muted">No packs installed. Install one from Add cards.</p>`}
    </div>
    <div class="panel">
      <h2>${L.Gs} &amp; ${L.cs}</h2>
      <p class="muted small">Rename by editing a name. To keep cards from something you delete, select them below and move them first.</p>
      ${groups || `<p class="muted">No ${L.gs} yet.</p>`}
      <div class="row"><input type="text" id="g-new" placeholder="New ${L.g}, e.g. Networking" style="flex:1 1 220px"><button class="btn" data-act="g-add">Add ${L.g}</button></div>
    </div>`;
}
function aiMode() {
  if (S.env.sample) return "viewer";
  if (!S.env.inViewer && S.apiKey) return "api";
  return null;
}
function packActions(pk) {
  const id = pk.id || pk.file.replace(/\.json$/, "");
  if (entryOf(id)) return id === S.activeId ? `<span class="pill known">This deck</span>` : `<span class="pill known">Installed</span><button class="btn small" data-act="switch" data-id="${esc(id)}">Open</button>`;
  if ((S.deck.packs || []).some((x) => x.id === id)) return `<span class="pill known">In this deck</span><button class="btn small danger" data-act="pack-rm" data-p="${esc(id)}">Remove</button>`;
  return `<button class="btn small primary" data-act="install-pack" data-file="${esc(pk.file)}">Install</button>`;
}
function viewAdd() {
  const A = S.add;
  const on = A.cands.filter((c) => c.on && c.term.trim() && c.def.trim()).length;
  const ai = aiMode();
  const deckImport = A.deckImport ? `<div class="panel">
      <h3>Install “${esc(A.deckImport.deck.title || A.deckImport.name)}” (${plural(A.deckImport.deck.cards.length, "card")})</h3>
      ${A.deckImport.deck.description ? `<p class="muted">${esc(A.deckImport.deck.description)}</p>` : ""}
      <p class="muted">${onlySamples() ? "It becomes its own deck and replaces the sample deck." : `Install it as its own deck (switch decks from the menu at the top), or add its cards into “${esc(S.deck.title)}”. Cards you already have are skipped.`} Save afterwards to keep it.</p>
      <div class="row"><button class="btn primary" data-act="deck-newdeck">Install as a new deck</button>
        ${onlySamples() ? "" : `<button class="btn" data-act="deck-merge">Add to “${esc(S.deck.title)}”</button>`}<button class="btn" data-act="deck-cancel">Cancel</button></div>
    </div>` : "";
  const results = A.cands.length ? `<div class="row between">
      <h2>${plural(A.cands.length, "card")} found <span class="muted small">· ${on} selected</span></h2>
      <div class="row"><button class="btn small" data-act="sel-all">Select all</button><button class="btn small" data-act="sel-none">Select none</button>
      <button class="btn primary" data-act="add-sel" ${on ? "" : "disabled"}>Add ${plural(on, "card")}</button></div>
    </div>
    <p class="muted small">Fix anything that looks off before adding. Cards marked “already in deck” are unticked so you don't get duplicates.</p>
    <div class="list">${A.cands.map((c, i) => `<div class="cand ${c.on ? "" : "off"}">
        <input type="checkbox" data-act="cand-on" data-i="${i}" ${c.on ? "checked" : ""} aria-label="Include this card">
        <div class="fields">
          <input type="text" id="cand-t-${i}" data-cand="${i}" data-f="term" value="${esc(c.term)}" aria-label="Term">
          <select id="cand-o-${i}" data-cand="${i}" data-f="obj" aria-label="${lab().C}">${objOptions(c.obj)}</select>
          <textarea id="cand-d-${i}" data-cand="${i}" data-f="def" rows="2" aria-label="Definition">${esc(c.def)}</textarea>
          ${c.dup ? `<span><span class="pill dup">Already in deck as “${esc(c.dup)}”</span></span>` : ""}
        </div>
      </div>`).join("")}</div>` : "";
  const packs = !A.deckImport && S.packs && S.packs.length ? `<div class="panel">
      <h2>Deck packs</h2>
      <p class="muted">Ready-made card sets. Installing one adds its cards and ${lab().gs}; you can still edit everything.</p>
      <div class="list">${S.packs.map((pk) => `<div class="item" style="grid-template-columns:minmax(0,1fr) auto">
        <div><div class="t">${esc(pk.title)} <span class="muted small">· ${plural(pk.cards || 0, "card")}</span></div><div class="d">${esc(pk.description || "")}</div></div>
        <div class="acts">${packActions(pk)}</div></div>`).join("")}</div>
      <div class="row"><label class="btn small" for="pack-file">Install a pack from a file…</label><input type="file" id="pack-file" accept=".json,application/json" hidden></div>
    </div>` : !A.deckImport ? `<div class="row"><label class="btn" for="pack-file">Install a deck pack from a file…</label><input type="file" id="pack-file" accept=".json,application/json" hidden></div>` : "";
  return `${deckImport}${packs}
    <h2>Add your own cards</h2>
    <div class="drop" id="drop">
      <textarea id="add-text" data-bind="add.text" placeholder="Paste notes, a glossary, a table, or rows like:
Mitochondria: The part of a cell that turns food into usable energy.
Treaty of Versailles	1919 peace treaty that formally ended World War I.

…or drop .txt, .md, .csv, .tsv or .json files here.">${esc(A.text)}</textarea>
      <div class="row between">
        <div class="row">
          <label class="btn" for="add-files">Choose files</label><input type="file" id="add-files" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,text/*,application/json" hidden>
          <select id="add-obj" aria-label="${lab().C} for new cards">${objOptions(A.defaultObj, { auto: true })}</select>
          <button class="btn small" data-act="goto-org">New ${lab().c}…</button>
        </div>
        <div class="row">
          <button class="btn" data-act="clear-add">Clear</button>
          <button class="btn" data-act="extract" ${A.busy ? "disabled" : ""}>Find cards in text</button>
          ${ai ? `<button class="btn primary" data-act="ai" ${A.busy ? "disabled" : ""}>Generate with Claude</button>` : ""}
        </div>
      </div>
    </div>
    ${A.busy ? `<div class="progress"><span class="spinner"></span><span>${esc(A.msg || "Working…")}</span><button class="btn small" data-act="ai-stop">Stop</button></div>`
      : A.msg ? `<p class="muted">${esc(A.msg)}</p>` : ""}
    <div class="note"><b>Find cards in text</b> runs instantly in your browser. It picks up “Term: definition” lines, “Term — definition”, “Term is …” sentences, bold terms, Markdown tables, Q:/A: pairs, and CSV/TSV/Anki exports. Spreadsheets with columns <i>term, definition, ${lab().c}, ${lab().g}</i> create any missing ${lab().cs} for you.
      ${ai ? `<b>Generate with Claude</b> reads messy notes or transcripts and writes clean cards, sorted into your ${lab().cs}.` : S.env.inViewer ? "" : `To have Claude write cards from messy notes, add an Anthropic API key under <a href="#" data-act="view" data-v="save">Save &amp; export</a>.`}</div>
    ${results}
    <div class="row"><button class="btn" data-act="new">Add one card by hand</button></div>`;
}

function viewSave() {
  const n = Object.keys(pendingFiles("x")).length;
  const gh = S.settings.gh;
  const art = S.env.artifact;
  const pageSave = art ? `<div class="panel">
      <h2>Save to this page</h2>
      <p class="muted">Saving updates the cards for everyone who opens this page. Study progress stays personal to each browser.</p>
      ${S.env.readOnly ? `<p class="note">You can study and export here, but only the page's owner and editors can save changes.</p>` : ""}
      <div class="row"><button class="btn primary" data-act="save-page" ${n && !S.env.readOnly && !S.env.saving ? "" : "disabled"}>${S.env.saving ? "Saving…" : n ? `Save ${plural(n, "changed file")}` : "Nothing to save"}</button>
      ${n ? `<button class="btn danger" data-act="discard">Discard changes</button>` : ""}</div>
    </div>` : "";
  const dev = deviceLib();
  const devicePanel = deviceSaveAvailable() ? `<div class="panel">
      <h2>Save to this device</h2>
      <p class="muted">Keeps all your decks ${S.env.desktop ? "in this app" : "in this browser"}, so they open exactly as you left them, even offline. ${dev ? `Last saved ${esc(new Date(dev.savedAt).toLocaleString())}.` : "Until you save here, the app opens with the original decks."}</p>
      <div class="row"><button class="btn primary" data-act="dev-save" ${n ? "" : "disabled"}>${n ? `Save ${plural(n, "change")} to this device` : "Nothing to save"}</button>
        ${n ? `<button class="btn danger" data-act="discard">Discard changes</button>` : ""}
        ${dev ? `<button class="btn" data-act="dev-reset">Go back to the original decks</button>` : ""}</div>
    </div>` : "";
  const installPanel = S.env.inViewer || S.env.desktop ? "" : `<div class="panel">
      <h2>Use it as an app</h2>
      ${S.env.installed ? `<p class="muted">Installed. Open it from your Start menu, Dock, app launcher or home screen; it works offline.</p>`
        : `<p class="muted">Install Simple Flashcards to get its own window and icon, and to use it with no internet connection.</p>
      <div class="row">${S.env.installPrompt ? `<button class="btn primary" data-act="install-app">Install app</button>` : ""}</div>
      <p class="muted small">${S.env.installPrompt ? "" : "If there's no Install button: in Chrome or Edge use the install icon in the address bar (or menu → Install); "}on iPhone or iPad, tap Share → Add to Home Screen; on Android, menu → Install app. Desktop installers for Windows, Mac and Linux are on the project's GitHub Releases page.</p>`}
    </div>`;
  const ghPanel = S.env.inViewer ? `<div class="panel">
      <h2>Save to GitHub</h2>
      <p class="muted">Committing straight to GitHub works from the GitHub Pages copy of this app. From here, export each deck below and upload it to the <code>decks/</code> folder of your repository.</p>
    </div>` : `<div class="panel">
      <h2>Save to GitHub</h2>
      <p class="muted">Commits all your decks to the <code>${esc(gh.folder)}/</code> folder of your repository in one commit, so the repository matches what you see here (decks you deleted are removed there too). Needs a fine-grained personal access token with <b>Contents: Read and write</b> on that one repository (<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">create one</a>). The token is kept in this browser only.</p>
      <div class="grid2">
        <label class="field">Owner<input type="text" id="gh-owner" data-bind="settings.gh.owner" value="${esc(gh.owner)}" placeholder="your-github-name"></label>
        <label class="field">Repository<input type="text" id="gh-repo" data-bind="settings.gh.repo" value="${esc(gh.repo)}" placeholder="secplus-flashcards"></label>
        <label class="field">Branch<input type="text" id="gh-branch" data-bind="settings.gh.branch" value="${esc(gh.branch)}"></label>
        <label class="field">Decks folder<input type="text" id="gh-folder" data-bind="settings.gh.folder" value="${esc(gh.folder)}"></label>
        <label class="field">Token<input type="password" id="gh-token" data-bind="ghToken" value="${esc(S.ghToken)}" placeholder="github_pat_…" autocomplete="off"></label>
        <label class="field">Commit message<input type="text" id="gh-msg" data-bind="settings.commitMsg" value="${esc(S.settings.commitMsg)}" placeholder="Update flashcards"></label>
      </div>
      <div class="row"><button class="btn primary" data-act="gh-commit" ${S.env.saving ? "disabled" : ""}>${S.env.saving ? "Committing…" : "Commit all decks to GitHub"}</button>
        ${S.ghToken ? `<button class="btn" data-act="gh-forget">Forget token</button>` : ""}</div>
      <p class="muted small">Files that haven't changed are left alone, so committing twice in a row does nothing.</p>
    </div>`;
  const aiPanel = S.env.inViewer ? "" : `<div class="panel">
      <h2>Claude for card generation</h2>
      <p class="muted">Optional. With an Anthropic API key, <b>Add cards → Generate with Claude</b> turns messy notes into cards. Requests go from your browser straight to Anthropic and use your API credits. Keep the key on your own devices only.</p>
      <div class="grid2">
        <label class="field">Anthropic API key<input type="password" id="ai-key" data-bind="apiKey" value="${esc(S.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
        <label class="field">Model<input type="text" id="ai-model" data-bind="settings.ai.model" value="${esc(S.settings.ai.model)}"></label>
      </div>
    </div>`;
  const known = S.deck.cards.filter((c) => S.prog[pk(c)] === "k").length, again = S.deck.cards.filter((c) => S.prog[pk(c)] === "a").length;
  return pageSave + devicePanel + ghPanel + `<div class="panel">
      <h2>Export</h2>
      <p class="muted">Exports “${esc(S.deck.title)}”. The deck file is the format the repository stores. The Anki/Quizlet file is tab-separated: term, definition, and a ${lab().c} tag.</p>
      <div class="row">
        <button class="btn" data-act="exp-json">Deck file (.json)</button>
        <button class="btn" data-act="exp-anki">Anki / Quizlet (.txt)</button>
        <button class="btn" data-act="exp-csv">Spreadsheet (.csv)</button>
      </div>
    </div>` + installPanel + viewPackExport() + aiPanel + `<div class="panel">
      <h2>Study memory</h2>
      <label class="row" style="gap:10px;cursor:pointer;align-items:flex-start"><input type="checkbox" id="remember" ${REMEMBER ? "checked" : ""} style="width:18px;height:18px;margin-top:3px;accent-color:var(--accent)">
        <span><b>Remember my progress and unsaved edits</b><br><span class="muted small">Off: every visit starts fresh from the saved decks, and you'll be warned before leaving with unsaved edits. On: Known/Review progress, your place in a session, and unsaved edits are kept in this browser.</span></span></label>
    </div>
    <div class="panel">
      <h2>Your study progress in this deck</h2>
      <p class="muted">${known} known, ${again} missed before. ${REMEMBER ? "Kept in this browser only." : "Cleared when you leave, because Remember is off."}</p>
      <div class="row"><button class="btn danger" data-act="reset-prog">Reset progress</button></div>
    </div>`;
}

function viewPackExport() {
  const L = lab(), E = S.packExp, groups = E.groups || new Set(S.deck.domains.map((d) => d.id));
  const n = S.deck.cards.filter((c) => groups.has(domainOf(c))).length;
  return `<div class="panel">
      <h2>Export a pack</h2>
      <p class="muted">Turn some or all of your ${L.gs} into a pack file that anyone can install with <b>Add cards → Install a deck pack from a file</b>. To list it on your site, upload the file to the <code>packs/</code> folder of your repository.</p>
      <div class="row">${S.deck.domains.map((d) => `<label class="chip" style="cursor:pointer"><input type="checkbox" data-act="pe-g" data-id="${esc(d.id)}" ${groups.has(d.id) ? "checked" : ""}> ${esc(d.name)}</label>`).join("") || `<span class="muted">No ${L.gs} yet.</span>`}</div>
      <div class="grid2">
        <label class="field">Pack name<input type="text" id="pe-title" data-bind="packExp.title" value="${esc(E.title)}" placeholder="${esc(S.deck.title)}"></label>
        <label class="field">Description<input type="text" id="pe-desc" data-bind="packExp.desc" value="${esc(E.desc)}" placeholder="What the pack covers"></label>
      </div>
      <div class="row"><button class="btn primary" data-act="pe-go" ${n ? "" : "disabled"}>Download pack (${plural(n, "card")})</button></div>
    </div>`;
}

/* ---------- modal editor ---------- */
function openEditor(id, presetObj) {
  const c = id ? S.deck.cards.find((x) => x.id === id) : null;
  S.modal = { id: c ? c.id : null, term: c ? c.term : "", def: c ? c.def : "", obj: c ? c.obj : (presetObj ?? S.study.obj ?? "") };
  renderModal();
  setTimeout(() => $("#ed-term")?.focus(), 0);
}
function renderModal() {
  let host = $("#modal-host");
  if (!host) { host = document.createElement("div"); host.id = "modal-host"; document.body.appendChild(host); }
  const m = S.modal;
  if (!m) { host.innerHTML = ""; return; }
  if (m.kind) {
    host.innerHTML = `<div class="scrim" data-act="modal-scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="md-h">
      <h2 id="md-h">${m.kind === "rename" ? "Rename this deck" : "New deck"}</h2>
      <label class="field">Deck name<input type="text" id="md-name" value="${esc(m.title)}" placeholder="e.g. A+ Core 1"></label>
      <p class="muted small">${m.kind === "rename" ? "The name shows at the top of the app and in the deck menu." : "Starts empty. Add groups and categories under Cards → Manage, then add cards or install a pack."}</p>
      <div class="row between"><span></span><span class="row"><button class="btn" data-act="ed-cancel">Cancel</button><button class="btn primary" data-act="md-ok">${m.kind === "rename" ? "Rename" : "Create deck"}</button></span></div>
    </div></div>`;
    return;
  }
  host.innerHTML = `<div class="scrim" data-act="modal-scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="ed-h">
      <h2 id="ed-h">${m.id ? "Edit card" : "New card"}</h2>
      <label class="field">Term<input type="text" id="ed-term" value="${esc(m.term)}"></label>
      <label class="field">Definition<textarea id="ed-def" rows="5">${esc(m.def)}</textarea></label>
      <label class="field">${lab().C}<select id="ed-obj">${objOptions(m.obj)}</select></label>
      <div class="row between">
        <span>${m.id ? `<button class="btn danger" data-act="ed-del">Delete card</button>` : ""}</span>
        <span class="row"><button class="btn" data-act="ed-cancel">Cancel</button><button class="btn primary" data-act="ed-save">${m.id ? "Save card" : "Add card"}</button></span>
      </div>
    </div></div>`;
}
function modalOk() {
  const v = $("#md-name").value.trim(); if (!v) { toast("Give the deck a name."); return; }
  if (S.modal.kind === "rename") { S.deck.title = v; syncIndexEntry(); }
  else { addDeck(newEmptyDeck(v)); S.view = "cards"; S.list.org = true; }
  S.modal = null; changed(); render();
}
function editorSave() {
  const term = $("#ed-term").value.trim(), def = $("#ed-def").value.trim(), obj = $("#ed-obj").value;
  if (!term || !def) { toast("A card needs both a term and a definition."); return; }
  const m = S.modal;
  if (m.id) {
    Object.assign(S.deck.cards.find((c) => c.id === m.id), { term, def, obj });
    toast("Card updated");
  } else {
    const card = { id: uniqueId(obj, term), obj, term, def, src: "manual" };
    S.deck.cards.push(card);
    S.study.order.splice(1, 0, card.id); saveSession();
    toast("Card added");
  }
  S.modal = null; changed(); render();
}
function deleteCard(id) {
  const i = S.deck.cards.findIndex((c) => c.id === id); if (i < 0) return;
  const [card] = S.deck.cards.splice(i, 1);
  const oi = S.study.order.indexOf(id);
  if (oi >= 0) { S.study.order.splice(oi, 1); S.study.quiz = null; S.study.flipped = false; if (oi === 0) drawTyping(); }
  for (const pile of [S.study.known, S.study.review]) { const j = pile.indexOf(id); if (j >= 0) pile.splice(j, 1); }
  saveSession();
  S.modal = null; changed(); render();
  toast(`Deleted “${card.term}”`, "Undo", () => {
    S.deck.cards.splice(i, 0, card); if (oi >= 0) S.study.order.splice(oi, 0, id); changed(); render();
  });
}

/* ---------- toast ---------- */
let toastTimer = 0;
function toast(msg, actionLabel, action) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.hidden = false;
  t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ""}`;
  if (actionLabel) t.querySelector("button").onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 7000 : 3500);
}

/* ---------- importers: turn text into candidate cards ---------- */
const STOP = new Set("the a an and or of to in on for with by is are be as at from that this it its into their your you can not no but use used uses using when which what who how than then also such any all each one two may must more most other only over same some these those they them there via per out up its it's was were has have had do does not like e.g eg i.e ie etc".split(" "));
const tokens = (s) => String(s).toLowerCase().match(/[a-z0-9][a-z0-9+/.-]{1,}/g)?.map((t) => t.replace(/[.-]+$/, "")).filter((t) => t.length > 2 && !STOP.has(t)) || [];
let objIndex = null;
function buildObjIndex() {
  const per = {}, df = new Map();
  for (const c of S.deck.cards) {
    if (!c.obj) continue;
    const m = per[c.obj] || (per[c.obj] = new Map());
    const toks = new Set([...tokens(c.term), ...tokens(c.term), ...tokens(c.def)]);
    for (const t of toks) { m.set(t, (m.get(t) || 0) + 1); df.set(t, (df.get(t) || 0) + 1); }
  }
  objIndex = { per, df, n: S.deck.cards.length };
}
function guessObj(term, def) {
  if (!objIndex) buildObjIndex();
  const toks = [...tokens(term), ...tokens(term), ...tokens(term), ...tokens(def)];
  let best = "", bestScore = 0;
  for (const [obj, m] of Object.entries(objIndex.per)) {
    let s = 0;
    for (const t of toks) { const f = m.get(t); if (f) s += f / Math.log(2 + (objIndex.df.get(t) || 0)); }
    if (s > bestScore) { bestScore = s; best = obj; }
  }
  return bestScore >= 0.8 ? best : "";
}
function existingTerms() { return new Map(S.deck.cards.map((c) => [normTerm(c.term), c.term])); }
const stripMd = (s) => String(s).replace(/\*\*|__|`/g, "").replace(/^\s*#+\s*/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
const cap1 = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
function objFromCell(s) {
  if (!s) return null;
  const m = String(s).match(/(?:^|[^\d])(\d+\.\d+)(?:[^\d]|$)/);
  return m && objMap()[m[1]] ? m[1] : null;
}
function parseDelimited(text, delim) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === "") q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function fromObject(o) {
  if (Array.isArray(o)) return o.length >= 2 ? { term: String(o[0]), def: String(o[1]), cat: o[2], group: o[3] } : null;
  if (!o || typeof o !== "object") return null;
  const term = o.term ?? o.front ?? o.question ?? o.q ?? o.word ?? o.name;
  const def = o.def ?? o.definition ?? o.back ?? o.answer ?? o.a ?? o.meaning ?? o.description;
  return term && def ? { term: String(term), def: String(def), cat: o.obj ?? o.category ?? o.objective ?? o.topic ?? o.cat, group: o.group ?? o.domain ?? o.section } : null;
}
function extractFromNotes(text) {
  const out = [];
  const push = (t, d, why) => {
    t = stripMd(t).replace(/[:\-–—=\s]+$/, "").trim(); d = cap1(stripMd(d).replace(/^[:\-–—=\s]+/, "").trim());
    if (t.length < 2 || t.length > 120 || d.length < 4 || d.length > 800) return;
    out.push({ term: t, def: d, why });
  };
  const lines = text.split(/\r?\n/);
  let header = null, pendingQ = null;
  for (let raw of lines) {
    let l = raw.trim();
    if (!l) { header = null; continue; }
    if (/^\|.*\|$/.test(l)) {                                   // Markdown table row
      const cells = l.slice(1, -1).split("|").map((s) => s.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || !c)) continue;
      if (!header) { header = cells; continue; }
      if (cells.length >= 2 && cells[0] && cells[1]) push(cells[0], cells[1], "table");
      continue;
    }
    header = null;
    if (/^#{1,6}\s/.test(l)) continue;                          // headings
    l = l.replace(/^(?:[-*+•▪◦‣]|\d{1,3}[.)])\s+/, "");           // bullets / numbering
    let m;
    if ((m = l.match(/^Q(?:uestion)?\s*[:.)]\s*(.+)$/i))) { pendingQ = m[1]; continue; }
    if (pendingQ && (m = l.match(/^A(?:nswer)?\s*[:.)]\s*(.+)$/i))) { push(pendingQ, m[1], "qa"); pendingQ = null; continue; }
    if ((m = l.match(/^\*\*([^*]{2,80})\*\*\s*(?:[:\-–—=]|\(([^)]*)\)\s*[:\-–—=]?)?\s*(.{6,})$/))) { push(m[2] ? `${m[1]} (${m[2]})` : m[1], m[3], "bold"); continue; }
    if ((m = l.match(/^([^:]{2,70}?)\s*(?::|\s[–—-]{1,2}\s|\s=>?\s|\s->\s)\s*(.{6,})$/))) {
      const term = stripMd(m[1]);
      if (term.split(/\s+/).length <= 8 && !/[.!?]$/.test(term) && !/^https?$/i.test(term)) { push(m[1], m[2], "sep"); continue; }
    }
    if ((m = l.match(/^([A-Z0-9][^.!?]{1,60}?)\s+(is|are|refers to|means|describes|stands for)\s+(.{8,})$/))) {
      const term = stripMd(m[1]).replace(/^(a|an|the)\s+/i, "");
      const chatty = /^(this|that|these|those|it|we|i|you|he|she|they|there|here|our|my|your|his|her|their|what|which|who|when|where|why|how)\b/i.test(term) ||
        /\b(said|says|told|think|thinks|thought|will|would|should|could|was|were|did|today|tomorrow|week)\b/i.test(term);
      if (!chatty && term.split(/\s+/).length <= 6) { push(term, (/^(is|are)$/.test(m[2]) ? "" : m[2] + " ") + m[3], "is"); continue; }
    }
  }
  return out;
}
function parseInput(text, filename = "") {
  const t = text.trim();
  if (!t) return { cards: [] };
  if (/^[[{]/.test(t)) {
    try {
      const j = JSON.parse(t);
      if (j && !Array.isArray(j) && Array.isArray(j.cards)) return { deck: j };
      if (Array.isArray(j)) return { cards: j.map(fromObject).filter(Boolean) };
    } catch (e) { /* not JSON; treat as notes */ }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const tabbed = lines.filter((l) => l.includes("\t")).length;
  const isCsv = /\.csv$/i.test(filename);
  if (tabbed >= Math.max(1, lines.length * 0.6) || isCsv) {
    let rows = parseDelimited(t, isCsv ? "," : "\t").filter((r) => !r[0]?.startsWith("#"));
    // Column order defaults to term, definition, category, group; a header row can name them in any order.
    let col = { term: 0, def: 1, cat: 2, group: 3 };
    if (rows.length && rows[0].some((h) => /^(term|front|question|word|concept)$/i.test(h.trim()))) {
      const hdr = rows.shift().map((h) => h.trim().toLowerCase());
      const find = (re, d) => { const i = hdr.findIndex((h) => re.test(h)); return i >= 0 ? i : d; };
      col = { term: find(/^(term|front|question|word|concept)$/, 0), def: find(/^(def|definition|back|answer|meaning|description)$/, 1),
        cat: find(/^(category|objective|topic|subtopic|obj|tags?)$/, -1), group: find(/^(group|domain|section|chapter|subject)$/, -1) };
    }
    return { cards: rows.filter((r) => r[col.term]?.trim() && r[col.def]?.trim())
      .map((r) => ({ term: stripMd(r[col.term]), def: stripMd(r[col.def]), cat: col.cat >= 0 ? r[col.cat]?.trim() : "", group: col.group >= 0 ? r[col.group]?.trim() : "" })) };
  }
  return { cards: extractFromNotes(t) };
}
function toCandidates(list, src) {
  const have = existingTerms(), seen = new Set(S.add.cands.map((c) => normTerm(c.term)));
  const def = S.add.defaultObj;
  const out = [];
  for (const c of list) {
    const k = normTerm(c.term); if (!k || seen.has(k)) continue; seen.add(k);
    const named = c.cat ? resolveCat(c.cat, c.group) : "";
    const obj = named || (def !== "auto" ? def : guessObj(c.term, c.def));
    const dup = have.get(k) || null;
    out.push({ term: c.term, def: c.def, obj, on: !dup, dup, src });
  }
  return out;
}
async function readFiles(files) {
  const A = S.add; let found = 0, texts = [];
  for (const f of files) {
    const text = await f.text();
    const r = parseInput(text, f.name);
    if (r.deck) { A.deckImport = { deck: normalizeDeck(r.deck), name: f.name }; continue; }
    if (r.cards.length) { const c = toCandidates(r.cards, "notes"); A.cands.push(...c); found += c.length; }
    texts.push(text);
  }
  if (texts.length && !found && !A.deckImport) {           // nothing recognisable: put the text in the box for Claude
    A.text = (A.text ? A.text + "\n\n" : "") + texts.join("\n\n");
    A.msg = "No term/definition patterns found in those files. Their text is in the box above" + (aiMode() ? "; try Generate with Claude." : ".");
  } else if (found) A.msg = `Found ${plural(found, "card")} in ${plural(files.length, "file")}.`;
  render();
}

/* ---------- Claude generation ---------- */
function aiPrompt(material) {
  const objs = S.deck.objectives.map((o) => `${o.id} ${o.name}`).join("\n");
  const have = S.deck.cards.map((c) => c.term).join("; ").slice(0, 24000);
  return `You write exam flashcards for the deck "${S.deck.title}".${S.deck.description ? " " + S.deck.description : ""}

From the study material below, write flashcards for the key terms, acronyms, numbers and concepts a student must know for the exam.
Rules:
- Use only facts supported by the material. If the material states something you are certain is wrong, write the correct fact instead.
- One card per distinct concept. Skip filler, logistics and anything trivial.
- "term": the keyword or short phrase (at most about 8 words).
- "def": a precise definition in one or two sentences, under 300 characters. Add a short real-world example when it helps.
- "obj": the id of the best-matching ${lab().c} from the list. If none fits, a short name for a new ${lab().c} (2-4 words) that several of your cards share.
- Do not repeat terms that are already in the deck (listed below).
Reply with only a JSON array of {"term": string, "def": string, "obj": string} objects, at most 60 items.

${lab().Cs}:
${objs || "(none yet)"}

Already in the deck: ${have}

Study material:
"""
${material}
"""`;
}
function parseJsonArray(text) {
  try { const j = JSON.parse(text); if (Array.isArray(j)) return j; } catch (e) { /* fall through */ }
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error("Claude's reply wasn't a list of cards");
}
async function aiGenerate() {
  const A = S.add, material = A.text.trim();
  if (!material) { toast("Paste or drop some notes first."); return; }
  const mode = aiMode(); if (!mode) return;
  const ctl = new AbortController();
  Object.assign(A, { busy: true, ctl, msg: mode === "viewer" ? "Claude is reading your notes… (this can take up to a minute)" : "Sending your notes to Claude…" });
  render();
  const prompt = aiPrompt(material.slice(0, 120000));
  try {
    let list;
    if (mode === "viewer") {
      list = await S.env.sample.json(prompt, { signal: ctl.signal, cache: false });
    } else {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": S.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: S.settings.ai.model || "claude-sonnet-5-5", max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `Anthropic API answered ${r.status}`);
      list = parseJsonArray((j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""));
    }
    if (!Array.isArray(list)) throw new Error("Claude's reply wasn't a list of cards");
    const c = toCandidates(list.map(fromObject).filter(Boolean), "claude");
    A.cands.push(...c);
    A.msg = c.length ? `Claude wrote ${plural(c.length, "card")}. Review them below.` : "Claude didn't find anything new to add.";
  } catch (e) {
    const code = e && e.code;
    A.msg = code === "cancelled" || e?.name === "AbortError" ? "Stopped."
      : code === "not_granted" || code === "sampling_disabled" ? "Claude isn't allowed for this page, so use Find cards in text instead."
      : code === "rate_limited" ? "Too many requests right now. Try again in a minute."
      : code === "prompt_too_large" ? "That's too much text at once. Paste a smaller chunk."
      : code === "invalid_json" ? "Claude's reply couldn't be read as cards. Try again or paste a smaller chunk."
      : `Generation failed: ${e?.message || code || e}`;
    if (code === "not_granted" || code === "sampling_disabled") S.env.sample = null;
  }
  A.busy = false; A.ctl = null; render();
}

/* ---------- export + save ---------- */
function openExternal(url) {
  const op = window.__TAURI__?.opener;
  if (op) op.openUrl(url).catch(() => toast("Couldn't open the link."));
  else window.open(url, "_blank", "noopener");
}
async function offerFile(filename, text) {
  if (S.env.desktop && window.__TAURI__?.dialog && window.__TAURI__?.fs) {
    try {
      const path = await window.__TAURI__.dialog.save({ defaultPath: filename });
      if (path) { await window.__TAURI__.fs.writeTextFile(path, text); toast(`Saved ${filename}`); }
    } catch (e) { toast(`Couldn't save the file (${e?.message || e}).`); }
    return;
  }
  if (S.env.downloads) {
    try { await S.env.downloads.save({ filename, data: text }); toast(`Saved ${filename}`); return; }
    catch (e) { if (e?.code === "declined") return; if (!["unavailable", "not_granted", "capability_disabled", "capability_removed"].includes(e?.code)) { toast(`Couldn't save the file (${e?.code || e}).`); return; } }
  }
  if (S.env.inViewer) {                                     // downloads blocked in this view: copy instead
    try { await navigator.clipboard.writeText(text); toast(`Copied ${filename} to the clipboard`); } catch (e) { toast("Downloads aren't available here."); }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: filename.endsWith(".json") ? "application/json" : "text/plain" }));
  a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const fileBase = () => slug(S.deck.title);
const tsvCell = (s) => String(s).replace(/[\t\r\n]+/g, " ");
const csvCell = (s) => /[",\n\r]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
function exportAnki() {
  const tag = slug(S.deck.title).replace(/-/g, "_");
  return "#separator:tab\n#html:false\n#tags column:3\n" + S.deck.cards.map((c) => [tsvCell(c.term), tsvCell(c.def), c.obj ? `${tag}::${c.obj}` : tag].join("\t")).join("\n") + "\n";
}
function exportCsv() {
  return "term,definition,objective,objective_name\n" + S.deck.cards.map((c) => [c.term, c.def, c.obj, c.obj ? objName(c.obj) : ""].map(csvCell).join(",")).join("\n") + "\n";
}
async function savePage() {
  const art = S.env.artifact; if (!art || S.env.saving) return;
  const files = pendingFiles("decks"); if (!Object.keys(files).length) return;
  S.env.saving = true; render();
  const payload = {};
  for (const [path, text] of Object.entries(files)) payload[path] = text == null ? null : { content: text, contentType: "application/json" };
  try {
    await art.publish(payload);
    markAllSaved(); toast("Saved. Everyone who opens this page now gets these cards.");
  } catch (e) {
    const code = e?.code;
    if (code === "conflict") toast("Someone saved a newer version; reloading it. Your edits are kept in this browser.");
    else if (code === "not_writer" || code === "not_granted" || code === "consent_required") { S.env.readOnly = true; toast("This page is read-only for you. Export the deck instead."); }
    else if (code === "capability_disabled" || code === "capability_removed" || code === "not_declared") { S.env.readOnly = true; toast("Saving isn't available in this view. Export the deck instead."); }
    else if (code === "rate_limited") toast("Saving too often. Wait a minute, then save again.");
    else if (code === "too_large") toast("The deck is too large to save here. Export it instead.");
    else toast(`Couldn't save (${code || e}). Your edits are kept in this browser.`);
  }
  S.env.saving = false; render();
}
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/* One commit with every changed file, through the Git Data API. */
async function ghCommit() {
  const g = S.settings.gh;
  if (!g.owner || !g.repo || !S.ghToken) { toast("Fill in owner, repository and token first."); return; }
  const folder = (g.folder || "decks").replace(/^\/+|\/+$/g, "");
  S.env.saving = true; render();
  let files;
  try {
    const texts = await allDeckTexts();
    files = { [`${folder}/index.json`]: indexText() };
    for (const e of S.lib.index.decks) files[`${folder}/${e.file}`] = texts[e.id];
  } catch (e) { toast(`Couldn't read every deck (${e.message || e}).`); S.env.saving = false; render(); return; }
  const api = `https://api.github.com/repos/${encodeURIComponent(g.owner)}/${encodeURIComponent(g.repo)}/git`;
  const hdr = { Authorization: `Bearer ${S.ghToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  const call = async (path, opt = {}) => {
    const r = await fetch(api + path, { headers: hdr, cache: "no-store", ...opt });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status}${j.message ? ": " + j.message : ""}`);
    return j;
  };
  try {
    const ref = await call(`/ref/heads/${encodeURIComponent(g.branch)}`);
    const parent = await call(`/commits/${ref.object.sha}`);
    const current = await call(`/trees/${parent.tree.sha}?recursive=1`);
    for (const f of current.tree || []) {         // deck files in the repo that are no longer in the deck list
      if (f.type === "blob" && f.path.startsWith(folder + "/") && f.path.endsWith(".json") && !(f.path in files) && !f.path.slice(folder.length + 1).includes("/")) files[f.path] = null;
    }
    const tree = Object.entries(files).map(([path, text]) => text == null ? { path, mode: "100644", type: "blob", sha: null } : { path, mode: "100644", type: "blob", content: text });
    const newTree = await call("/trees", { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
    if (newTree.sha === parent.tree.sha) { markAllSaved(); toast("GitHub already has these decks. Nothing to commit."); S.env.saving = false; render(); return; }
    const names = dirtyIds().map((id) => entryOf(id).title);
    const message = S.settings.commitMsg.trim() || (names.length ? `Update ${names.join(", ")}` : "Update deck list");
    const commit = await call("/commits", { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [parent.sha] }) });
    await call(`/refs/heads/${encodeURIComponent(g.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
    markAllSaved(); S.settings.commitMsg = ""; LS.set("fc-settings", S.settings);
    toast("Committed to GitHub", "View commit", () => openExternal(commit.html_url || `https://github.com/${g.owner}/${g.repo}/commit/${commit.sha}`));
  } catch (e) {
    const m = String(e.message || e);
    toast(/^401/.test(m) ? "GitHub rejected the token. Check it hasn't expired." : /^40[34]/.test(m) ? `GitHub said ${m}. Check the owner, repository, branch, and that the token can write Contents.` : /^409/.test(m) ? "The repository is empty. Push the project to it first." : `Commit failed: ${m}`);
  }
  S.env.saving = false; render();
}

/* ---------- events ---------- */
function setPath(path, v) {
  if (path === "ghToken") { S.ghToken = v; LS.set("fc-gh-token", v); return; }
  if (path === "apiKey") { S.apiKey = v; LS.set("fc-anthropic-key", v); return; }
  if (path === "add.text") { S.add.text = v; return; }
  if (path.startsWith("packExp.")) { S.packExp[path.split(".")[1]] = v; return; }
  const parts = path.split("."); let o = S;
  for (const p of parts.slice(0, -1)) o = o[p];
  o[parts.at(-1)] = v;
  if (path.startsWith("settings.")) LS.set("fc-settings", S.settings);
}
const armed = new WeakMap();
function confirmClick(btn, label, fn) {
  if (armed.get(btn)) { armed.delete(btn); fn(); return; }
  const old = btn.textContent; armed.set(btn, true); btn.classList.add("armed"); btn.textContent = label;
  setTimeout(() => { if (btn.isConnected && armed.get(btn)) { armed.delete(btn); btn.classList.remove("armed"); btn.textContent = old; } }, 3000);
}

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-act]"); if (!t) return;
  const act = t.dataset.act, st = S.study, A = S.add;
  if (t.tagName === "A") ev.preventDefault();
  switch (act) {
    case "view": S.view = t.dataset.v; render(); window.scrollTo(0, 0); break;
    case "study-dom": st.dom = t.dataset.d; st.obj = null; rebuildOrder(true); render(); break;
    case "study-obj": st.obj = t.dataset.o || null; rebuildOrder(true); render(); break;
    case "mode-flip": case "mode-quiz": st.mode = act === "mode-flip" ? "flip" : "quiz"; st.quiz = null; st.flipped = false; drawTyping(); render(); break;
    case "f-all": case "f-new": case "f-again": st.filter = act.slice(2); rebuildOrder(true); render(); break;
    case "dir": st.defFirst = !st.defFirst; st.flipped = false; st.quiz = null; render(); break;
    case "pile": st.pile = t.dataset.p; render(); break;
    case "pile-move": moveBetweenPiles(t.dataset.id, t.dataset.to); break;
    case "redo-missed": { const ids = shuffle([...st.missed]); Object.assign(st, { order: ids, known: [], review: [], round: 1, missed: new Set(), history: [], pile: "study" }); advance(); break; }
    case "undo": undoGrade(); break;
    case "skip": skipCard(); break;
    case "type-check": submitTyped("check"); break;
    case "type-giveup": submitTyped("giveup"); break;
    case "rv-next": advance(); break;
    case "rv-knew": revealKnewIt(); break;
    case "timed": S.settings.timed = !S.settings.timed; LS.set("fc-settings", S.settings); if (S.study.typing) S.study.typing.used = 0; render(); break;
    case "quiz-next": { const q = st.quiz, c = curCard(); if (q && c && q.picked != null) grade(q.opts[q.picked].id === c.id ? "k" : "a"); break; }
    case "shuffle": rebuildOrder(true); render(); break;
    case "flip": st.flipped = !st.flipped; $("#card")?.classList.toggle("flipped", st.flipped); break;
    case "grade": grade(t.dataset.g); break;
    case "pick": {
      const q = st.quiz; if (!q || q.picked != null) break;
      q.picked = +t.dataset.j; st.asked++;
      if (q.opts[q.picked].id === curCard().id) st.right++;
      render(); setTimeout(() => $('[data-act="quiz-next"]')?.focus(), 0); break;
    }
    case "edit": openEditor(t.dataset.id); break;
    case "new": openEditor(null, S.view === "cards" && S.list.dom.includes(".") ? S.list.dom : undefined); break;
    case "del": confirmClick(t, "Click to confirm", () => deleteCard(t.dataset.id)); break;
    case "more": S.list.limit += 300; $("#list-body").innerHTML = listBody(); break;
    case "modal-scrim": if (ev.target === t) { S.modal = null; renderModal(); } break;
    case "ed-cancel": S.modal = null; renderModal(); break;
    case "ed-save": editorSave(); break;
    case "ed-del": confirmClick(t, "Click to confirm", () => deleteCard(S.modal.id)); break;
    case "extract": {
      const r = parseInput(A.text);
      if (r.deck) { A.deckImport = { deck: normalizeDeck(r.deck), name: "Pasted deck" }; render(); break; }
      const c = toCandidates(r.cards, "notes"); A.cands.push(...c);
      A.msg = c.length ? `Found ${plural(c.length, "card")}.` : `No term/definition patterns found${aiMode() ? ". Try Generate with Claude for free-form notes." : ". Try lines like “Term: definition”."}`;
      render(); break;
    }
    case "ai": aiGenerate(); break;
    case "ai-stop": A.ctl?.abort(); break;
    case "clear-add": Object.assign(A, { text: "", cands: [], msg: "", deckImport: null }); pruneCreated(); changed(); render(); break;
    case "sel-all": A.cands.forEach((c) => { c.on = true; }); render(); break;
    case "sel-none": A.cands.forEach((c) => { c.on = false; }); render(); break;
    case "cand-on": A.cands[+t.dataset.i].on = t.checked; render(); break;
    case "add-sel": {
      const take = A.cands.filter((c) => c.on && c.term.trim() && c.def.trim());
      const ids = new Set(S.deck.cards.map((c) => c.id));
      for (const c of take) { const id = uniqueId(c.obj, c.term, ids); ids.add(id); S.deck.cards.push({ id, obj: c.obj, term: c.term.trim(), def: c.def.trim(), src: c.src }); }
      A.cands = A.cands.filter((c) => !take.includes(c)); A.msg = ""; objIndex = null; if (!A.cands.length) pruneCreated();
      changed(); refreshSession(); render();
      toast(`Added ${plural(take.length, "card")}. Remember to save.`, "Save now", () => { S.view = "save"; render(); });
      break;
    }
    case "deck-newdeck": {
      const n = installDeck(A.deckImport.deck, "newdeck");
      A.deckImport = null; S.view = "study"; render(); window.scrollTo(0, 0);
      toast(`Installed “${S.deck.title}” as a new deck with ${plural(n, "card")}. Save to keep it.`, "Save now", () => { S.view = "save"; render(); }); break;
    }
    case "deck-merge": {
      const n = installDeck(A.deckImport.deck, "merge");
      A.deckImport = null; objIndex = null; S.study.dom = "all"; S.study.obj = null; changed(); rebuildOrder(true); render();
      if (n) toast(`Installed ${plural(n, "card")}. Save to keep them.`, "Save now", () => { S.view = "save"; render(); }); else toast("Every card in that pack is already in your deck."); break;
    }
    case "deck-cancel": A.deckImport = null; render(); break;
    case "install-pack": installPack(t.dataset.file); break;
    case "pack-rm": confirmClick(t, "Click to confirm", () => {
      const n = removePack(t.dataset.p); S.study.dom = "all"; S.study.obj = null; S.list.src = "all"; objIndex = null; changed(); rebuildOrder(true); render();
      toast(`Removed the pack and its ${plural(n, "card")}. Save to make it stick.`);
    }); break;
    case "org-toggle": S.list.org = !S.list.org; render(); break;
    case "switch": activate(t.dataset.id).then(() => { S.view = "study"; render(); }); break;
    case "rename": S.modal = { kind: "rename", title: S.deck.title }; renderModal(); setTimeout(() => $("#md-name")?.select(), 0); break;
    case "md-ok": modalOk(); break;
    case "theme": S.deck.theme = t.dataset.t || undefined; if (!S.deck.theme) delete S.deck.theme; changed(); render(); break;
    case "deck-default": S.lib.index.default = S.activeId; changed(); render(); toast("This deck now opens first."); break;
    case "deck-del": confirmClick(t, `Delete “${S.deck.title}”?`, async () => { const title = S.deck.title; await removeDeck(S.activeId); render(); toast(`Deleted “${title}”. Save to make it stick.`); }); break;
    case "goto-org": S.view = "cards"; S.list.org = true; render(); window.scrollTo(0, 0); break;
    case "sel": if (t.checked) S.list.sel.add(t.dataset.id); else S.list.sel.delete(t.dataset.id); $("#list-body").innerHTML = listBody(); break;
    case "sel-matching": { const m = listMatches(); if (t.checked) m.forEach((c) => S.list.sel.add(c.id)); else m.forEach((c) => S.list.sel.delete(c.id)); $("#list-body").innerHTML = listBody(); break; }
    case "sel-clear": S.list.sel.clear(); $("#list-body").innerHTML = listBody(); break;
    case "bulk-del": confirmClick(t, `Click to delete ${S.list.sel.size}`, () => deleteCards([...S.list.sel])); break;
    case "g-add": { const g = addGroup($("#g-new").value); if (g) { changed(); render(); toast(`Added ${lab().g} “${g.name}”`); } break; }
    case "c-add": { const inp = $("#c-new-" + CSS.escape(t.dataset.id)); const o = addCategory(inp.value, t.dataset.id); if (o) { objIndex = null; changed(); render(); toast(`Added ${lab().c} “${o.name}”`); } break; }
    case "c-del": confirmClick(t, "Click to confirm", () => {
      const id = t.dataset.id; S.deck.cards = S.deck.cards.filter((c) => c.obj !== id); S.deck.objectives = S.deck.objectives.filter((o) => o.id !== id);
      if (S.study.obj === id) S.study.obj = null; objIndex = null; changed(); refreshSession(); render();
    }); break;
    case "g-del": confirmClick(t, "Click to confirm", () => {
      const id = t.dataset.id; const objs = new Set(S.deck.objectives.filter((o) => o.domain === id).map((o) => o.id));
      S.deck.cards = S.deck.cards.filter((c) => !objs.has(c.obj)); S.deck.objectives = S.deck.objectives.filter((o) => o.domain !== id); S.deck.domains = S.deck.domains.filter((d) => d.id !== id);
      if (S.study.dom === id) { S.study.dom = "all"; S.study.obj = null; } objIndex = null; changed(); refreshSession(); render();
    }); break;
    case "pe-g": { const E = S.packExp; if (!E.groups) E.groups = new Set(S.deck.domains.map((d) => d.id)); if (t.checked) E.groups.add(t.dataset.id); else E.groups.delete(t.dataset.id); render(); break; }
    case "pe-go": { const pk = buildPack(); offerFile(`${pk.id}.json`, serializeDeck(pk)); break; }
    case "rm-samples": confirmClick(t, "Click to confirm", () => {
      const n = removeSamples(); st.dom = "all"; st.obj = null; objIndex = null; changed(); rebuildOrder(true); render();
      toast(`Removed ${plural(n, "sample card")}. Save to make it stick.`);
    }); break;
    case "save-page": savePage(); break;
    case "dev-save": saveToDevice(); break;
    case "dev-reset": confirmClick(t, "Click to confirm", () => { LS.del(DEVICE_KEY); try { localStorage.removeItem(DEVICE_KEY); } catch (e) { /* blocked */ } LS.forgetMemory(); location.reload(); }); break;
    case "install-app": { const pr = S.env.installPrompt; if (pr) { pr.prompt(); pr.userChoice.then((c) => { if (c.outcome === "accepted") { S.env.installPrompt = null; S.env.installed = true; } render(); }); } break; }
    case "gh-commit": ghCommit(); break;
    case "gh-forget": S.ghToken = ""; LS.del("fc-gh-token"); render(); toast("Token removed from this browser"); break;
    case "discard": confirmClick(t, "Click to confirm", async () => {
      // undo everything since the last save: deck edits, new decks, deleted decks
      LS.del("fc-draft-index"); for (const e of S.lib.index.decks) LS.del(draftKey(e.id));
      S.lib.index = JSON.parse(S.lib.indexBase); S.lib.deleted.clear(); S.lib.store = {}; S.activeId = null; S.deck = null;
      const want = LS.get("fc-active", "");
      if (S.lib.index.decks.length) await activate(entryOf(want) ? want : S.lib.index.default || S.lib.index.decks[0].id); else addDeck(newEmptyDeck());
      render(); toast("Unsaved changes discarded");
    }); break;
    case "draft-keep": S.deck = normalizeDeck(JSON.parse(S.draftConflict.deck)); S.draftConflict = null; changed(); rebuildOrder(true); render(); break;
    case "draft-drop": S.draftConflict = null; LS.del(draftKey()); render(); break;
    case "exp-json": offerFile(`${S.activeId}.json`, serializeDeck(S.deck)); break;
    case "exp-anki": offerFile(`${fileBase()}-anki.txt`, exportAnki()); break;
    case "exp-csv": offerFile(`${fileBase()}.csv`, exportCsv()); break;
    case "reset-prog": confirmClick(t, "Click to confirm", () => { for (const k of Object.keys(S.prog)) if (k.startsWith(S.activeId + "|")) delete S.prog[k]; LS.set(progKey(), S.prog); render(); toast("Progress reset for this deck"); }); break;
  }
});

document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.dataset.bind) { setPath(el.dataset.bind, el.value); return; }
  if (el.dataset.cand) { S.add.cands[+el.dataset.cand][el.dataset.f] = el.value; return; }
  if (el.id === "list-q") { S.list.q = el.value; S.list.limit = 150; $("#list-body").innerHTML = listBody(); }
});
document.addEventListener("change", async (ev) => {
  const el = ev.target;
  if (el.dataset.cand && el.tagName === "SELECT") { S.add.cands[+el.dataset.cand].obj = el.value; return; }
  if (el.id === "list-dom") { S.list.dom = el.value; S.list.limit = 150; $("#list-body").innerHTML = listBody(); return; }
  if (el.id === "deck-switch") {
    if (el.value === "__new") { S.modal = { kind: "newdeck", title: "" }; renderModal(); setTimeout(() => $("#md-name")?.focus(), 0); el.value = S.activeId; return; }
    await activate(el.value); render(); return;
  }
  if (el.id === "remember") {
    S.settings.remember = REMEMBER = el.checked; LS.set("fc-settings", S.settings);
    if (REMEMBER) { writeDraft(); saveSession(); LS.set(progKey(), S.prog); LS.set("fc-active", S.activeId); toast("This browser will remember your progress and edits"); }
    else { LS.forgetMemory(); toast("Every visit will start fresh"); }
    render(); return;
  }
  if (el.id === "timed-secs") { S.settings.timedSecs = +el.value; LS.set("fc-settings", S.settings); render(); return; }
  if (el.id === "type-chance") { S.settings.typeChance = +el.value; LS.set("fc-settings", S.settings); drawTyping(); render(); return; }
  if (el.id === "theme-pick") { if (el.value) S.deck.theme = el.value; else delete S.deck.theme; changed(); render(); return; }
  if (el.id === "list-src") { S.list.src = el.value; S.list.limit = 150; $("#list-body").innerHTML = listBody(); return; }
  if (el.id === "bulk-move" && el.value !== "__") {
    const to = el.value, n = S.list.sel.size;
    for (const c of S.deck.cards) if (S.list.sel.has(c.id)) c.obj = to;
    S.list.sel.clear(); objIndex = null; changed(); render(); toast(`Moved ${plural(n, "card")} to ${to ? objName(to) : "no " + lab().c}`); return;
  }
  if (el.dataset.org) {
    const v = el.value.trim(), k = el.dataset.org;
    if (k === "title") { S.deck.title = v || "My Flashcards"; syncIndexEntry(); }
    else if (k === "desc") { if (v) S.deck.description = v; else delete S.deck.description; }
    else if (k === "lg" || k === "lc") { S.deck.labels = { ...(S.deck.labels || {}), [k === "lg" ? "group" : "category"]: v || (k === "lg" ? "Group" : "Category") }; }
    else if (k === "g" && v) { const d = S.deck.domains.find((x) => x.id === el.dataset.id); d.name = v; d.short = v.length > 14 ? v.slice(0, 13) + "…" : v; delete d.tag; }
    else if (k === "c" && v) { objMap()[el.dataset.id].name = v; }
    changed(); render(); return;
  }
  if (el.id === "add-obj") {
    S.add.defaultObj = el.value;
    if (el.value !== "auto") S.add.cands.forEach((c) => { c.obj = el.value; });
    render(); return;
  }
  if ((el.id === "add-files" || el.id === "pack-file") && el.files.length) { await readFiles([...el.files]); el.value = ""; return; }
  if (el.id === "open-deck" && el.files[0]) {
    try {
      const deck = normalizeDeck(JSON.parse(await el.files[0].text()));
      S.loadError = null; S.lib.index = { schema: 1, default: "", decks: [] }; S.lib.indexBase = indexText();
      addDeck(deck); S.lib.index.default = S.activeId; render();
    } catch (e) { S.loadError = "That file isn't a deck: " + e.message; render(); }
  }
});
// drag and drop onto the Add cards box (or anywhere while on that tab)
document.addEventListener("dragover", (ev) => { if (S.view !== "add" || !ev.dataTransfer?.types?.includes("Files")) return; ev.preventDefault(); $("#drop")?.classList.add("over"); });
document.addEventListener("dragleave", (ev) => { if (ev.target.id === "drop" || !ev.relatedTarget) $("#drop")?.classList.remove("over"); });
document.addEventListener("drop", async (ev) => {
  if (S.view !== "add" || !ev.dataTransfer?.files?.length) return;
  ev.preventDefault(); $("#drop")?.classList.remove("over");
  await readFiles([...ev.dataTransfer.files]);
});
document.addEventListener("keydown", (ev) => {
  if (S.modal) {
    if (ev.key === "Escape") { S.modal = null; renderModal(); }
    else if (ev.key === "Enter" && S.modal.kind) { ev.preventDefault(); modalOk(); }
    else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) editorSave();
    return;
  }
  if (ev.target.id === "type-ans" && ev.key === "Enter") { ev.preventDefault(); submitTyped("check"); return; }
  if (S.view !== "study" || ev.target.closest("input, textarea, select, [contenteditable]") || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const st = S.study;
  if (st.reveal && ev.key === "Enter" && !ev.target.closest("button")) { ev.preventDefault(); advance(); return; }
  if (st.typing?.result?.ok && ev.key === "Enter" && !ev.target.closest("button")) { ev.preventDefault(); grade("k"); return; }
  if (ev.key === "Enter" && ev.target.closest("button")) return;           // let the focused button act
  if (ev.key === " " && st.mode === "flip" && $("#card")) { ev.preventDefault(); st.flipped = !st.flipped; $("#card").classList.toggle("flipped", st.flipped); }
  else if (ev.key === "ArrowRight") skipCard();
  else if (ev.key === "ArrowLeft") undoGrade();
  else if (ev.key === "1" && st.mode === "flip" && curCard() && st.pile === "study" && !st.reveal) grade("a");
  else if (ev.key === "2" && st.mode === "flip" && curCard() && st.pile === "study" && !st.reveal) grade("k");
  else if ((ev.key === "e" || ev.key === "E") && curCard()) { ev.preventDefault(); openEditor(curCard().id); }
});
window.addEventListener("beforeunload", (ev) => {
  if (!S.deck) return;
  if (REMEMBER) { writeDraft(); return; }
  if (Object.keys(pendingFiles("decks")).length) { ev.preventDefault(); ev.returnValue = ""; }   // unsaved edits would be lost
});

// Pre-fill the GitHub settings when the app is served from GitHub Pages (owner.github.io/repo).
if (/\.github\.io$/i.test(location.hostname) && !S.settings.gh.owner) {
  S.settings.gh.owner = location.hostname.split(".")[0];
  S.settings.gh.repo = location.pathname.split("/").filter(Boolean)[0] || `${S.settings.gh.owner}.github.io`;
}

// Offline support and installing: a service worker caches the app (not inside Claude, not in the desktop app).
if ("serviceWorker" in navigator && !S.env.inViewer && !S.env.desktop && /^https?:$/.test(location.protocol)) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => { /* offline mode unavailable */ }));
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.env.installPrompt = e; if (S.deck) render(); });
window.addEventListener("appinstalled", () => { S.env.installPrompt = null; S.env.installed = true; if (S.deck) render(); toast("Installed. You can open Simple Flashcards like any other app."); });
if (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone) S.env.installed = true;
// In the desktop app, open web links in the normal browser.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest('a[target="_blank"]');
  if (a && S.env.desktop) { ev.preventDefault(); openExternal(a.href); }
}, true);

boot();
