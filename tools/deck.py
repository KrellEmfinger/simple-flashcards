#!/usr/bin/env python3
"""Deck tools for the flashcards app. Standard library only.

  python3 tools/deck.py validate [FILES]    check every deck in decks/ and every pack in packs/ (CI runs this)
  python3 tools/deck.py fmt [FILES]         rewrite decks in the canonical one-card-per-line format
  python3 tools/deck.py packs               rebuild packs/index.json from the packs folder
  python3 tools/deck.py from-csv FILE.csv "Pack name" [--labels Group,Category]
                                            make packs/<name>.json from a spreadsheet with columns
                                            term, definition, category, group (header row optional)
  python3 tools/deck.py build               write dist/flashcards-offline.html (single file, works without a server)
  python3 tools/deck.py app                 copy the app into app-dist/ for the desktop (Tauri) build
  python3 tools/deck.py import FILE.tsv CAT [--deck ID]
                                            append "term<TAB>definition" rows to category CAT (e.g. 4.6)
  python3 tools/deck.py stats [--deck ID]   cards per group and category
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECKS = ROOT / "decks"
CARD_KEYS = ["id", "obj", "term", "def", "tags", "src", "pack"]


def json_sp(v):
    """Same compact-with-spaces style as jsonSp() in app.js."""
    if isinstance(v, list):
        return "[" + ", ".join(json_sp(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(json.dumps(k, ensure_ascii=False) + ": " + json_sp(x) for k, x in v.items()) + "}"
    return json.dumps(v, ensure_ascii=False)


def serialize(deck):
    parts = []
    for k, v in deck.items():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            rows = ",\n".join("    " + json_sp(x) for x in v)
            parts.append(f"  {json.dumps(k)}: [\n{rows}\n  ]")
        else:
            parts.append(f"  {json.dumps(k)}: {json_sp(v)}")
    return "{\n" + ",\n".join(parts) + "\n}\n"


def clean_card(c):
    out = {k: c[k] for k in CARD_KEYS if k in c and c[k] not in ("", None, [])}
    out.update({k: v for k, v in c.items() if k not in CARD_KEYS and not k.startswith("_")})
    out.setdefault("obj", "")
    return out


def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:48].rstrip("-") or "card"


def load_index():
    return json.loads((DECKS / "index.json").read_text(encoding="utf-8"))


def deck_path(deck_id=None):
    idx = load_index()
    deck_id = deck_id or idx.get("default") or idx["decks"][0]["id"]
    entry = next((d for d in idx["decks"] if d["id"] == deck_id), None)
    if not entry:
        sys.exit(f"no deck with id {deck_id!r} in decks/index.json")
    return DECKS / entry["file"]


def pop_opt(args, name):
    if name in args:
        i = args.index(name)
        val = args[i + 1]
        return args[:i] + args[i + 2:], val
    return args, None


def validate(deck):
    errors, warnings = [], []
    for key in ("title", "domains", "objectives", "cards"):
        if key not in deck:
            errors.append(f"missing top-level key: {key}")
    domains = {d.get("id") for d in deck.get("domains", [])}
    objectives = {}
    for o in deck.get("objectives", []):
        if o.get("domain") not in domains:
            errors.append(f"objective {o.get('id')} points at unknown domain {o.get('domain')}")
        objectives[o.get("id")] = o
    ids, terms = set(), {}
    for i, c in enumerate(deck.get("cards", []), 1):
        where = f"card {i} ({c.get('id', '?')})"
        for f in ("id", "term", "def"):
            if not str(c.get(f, "")).strip():
                errors.append(f"{where}: empty {f}")
        if c.get("id") in ids:
            errors.append(f"{where}: duplicate id")
        ids.add(c.get("id"))
        if c.get("obj") and c["obj"] not in objectives:
            errors.append(f"{where}: unknown objective {c['obj']}")
        key = re.sub(r"[^a-z0-9]+", " ", re.sub(r"\([^)]*\)", " ", c.get("term", "").lower())).strip()
        if key in terms and terms[key] == c.get("obj"):
            warnings.append(f"{where}: same term as {terms[key]!r} card in the same objective ({c.get('term')})")
        terms.setdefault(key, c.get("obj"))
    return errors, warnings


def deck_files(args):
    if args:
        return [Path(a).resolve() for a in args]
    return sorted(p for p in DECKS.glob("*.json") if p.name != "index.json") + \
        sorted(p for p in (ROOT / "packs").glob("*.json") if p.name != "index.json")


def cmd_validate(args):
    failed = False
    if not args:
        idx = load_index()
        files = {p.name for p in DECKS.glob("*.json")}
        for e in idx.get("decks", []):
            if e.get("file") not in files:
                print(f"decks/index.json: error: {e.get('id')} points at missing file {e.get('file')}")
                failed = True
        if idx.get("default") not in {e.get("id") for e in idx.get("decks", [])}:
            print("decks/index.json: warning: default deck is not in the list")
    for path in deck_files(args):
        name = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
        text = path.read_text(encoding="utf-8")
        try:
            deck = json.loads(text)
        except json.JSONDecodeError as e:
            print(f"{name}: not valid JSON: {e}")
            failed = True
            continue
        errors, warnings = validate(deck)
        for w in warnings:
            print(f"{name}: warning: {w}")
        for e in errors:
            print(f"{name}: error: {e}")
        if serialize(deck) != text:
            print(f"{name}: note: not in canonical format; run `python3 tools/deck.py fmt`")
        print(f"{name}: {len(deck.get('cards', []))} cards, {len(errors)} errors, {len(warnings)} warnings")
        failed |= bool(errors)
    return 1 if failed else 0


def cmd_fmt(args):
    for path in deck_files(args):
        deck = json.loads(path.read_text(encoding="utf-8"))
        deck["cards"] = [clean_card(c) for c in deck.get("cards", [])]
        path.write_text(serialize(deck), encoding="utf-8")
        print(f"formatted {path.name}")
    return 0


def cmd_packs(_):
    index = []
    for path in sorted((ROOT / "packs").glob("*.json")):
        if path.name == "index.json":
            continue
        deck = json.loads(path.read_text(encoding="utf-8"))
        index.append({"file": path.name, "id": deck.get("id", path.stem), "title": deck.get("title", path.stem),
                      "description": deck.get("description", ""), "cards": len(deck.get("cards", []))})
    (ROOT / "packs" / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"packs/index.json lists {len(index)} pack(s)")
    return 0


def cmd_build(_):
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "app.css").read_text(encoding="utf-8")
    js = (ROOT / "app.js").read_text(encoding="utf-8")
    idx = load_index()
    lib = {"index": idx, "decks": {e["id"]: json.loads((DECKS / e["file"]).read_text(encoding="utf-8")) for e in idx["decks"]}}
    deck = json.dumps(lib, ensure_ascii=False)
    safe = lambda s: s.replace("</script", "<\\/script")
    html = html.replace('<link rel="stylesheet" href="app.css">', f"<style>\n{css}</style>")
    html = html.replace('<script src="app.js"></script>',
                        f"<script>window.EMBEDDED_LIB = {safe(deck)};</script>\n<script>\n{safe(js)}</script>")
    out = ROOT / "dist" / "flashcards-offline.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
    return 0


def cmd_import(args):
    args, deck_id = pop_opt(args, "--deck")
    if len(args) != 2:
        print("usage: python3 tools/deck.py import FILE.tsv CATEGORY [--deck ID]")
        return 2
    path, obj = Path(args[0]), args[1]
    target = deck_path(deck_id)
    deck = json.loads(target.read_text(encoding="utf-8"))
    if obj and obj not in {o["id"] for o in deck["objectives"]}:
        print(f"unknown objective {obj}")
        return 1
    ids = {c["id"] for c in deck["cards"]}
    have = {c["term"].lower() for c in deck["cards"]}
    added = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if "\t" not in line or line.startswith("#"):
            continue
        term, definition = [s.strip() for s in line.split("\t")[:2]]
        if not term or not definition or term.lower() in have:
            continue
        base = cid = f"{obj or 'x'}-{slug(term)}"
        n = 2
        while cid in ids:
            cid = f"{base}-{n}"
            n += 1
        ids.add(cid)
        have.add(term.lower())
        deck["cards"].append({"id": cid, "obj": obj, "term": term, "def": definition, "src": "import"})
        added += 1
    target.write_text(serialize(deck), encoding="utf-8")
    print(f"added {added} cards to {obj} in {target.name}")
    return 0


def cmd_stats(args):
    args, deck_id = pop_opt(args, "--deck")
    deck = json.loads(deck_path(deck_id).read_text(encoding="utf-8"))
    print(deck.get("title", ""))
    names = {o["id"]: o["name"] for o in deck["objectives"]}
    counts = {}
    for c in deck["cards"]:
        counts[c.get("obj", "")] = counts.get(c.get("obj", ""), 0) + 1
    for d in deck["domains"]:
        objs = [o["id"] for o in deck["objectives"] if o["domain"] == d["id"]]
        print(f"{deck.get('labels', {}).get('group', 'Group')} {d['id']} {d['name']}: {sum(counts.get(o, 0) for o in objs)}")
        for o in objs:
            print(f"   {o:5} {names[o]:32} {counts.get(o, 0)}")
    if counts.get(""):
        print(f"Unsorted: {counts['']}")
    print(f"Total: {len(deck['cards'])}")
    return 0


def cmd_from_csv(args):
    import csv
    labels = None
    if "--labels" in args:
        i = args.index("--labels")
        labels = [x.strip() for x in args[i + 1].split(",")][:2]
        args = args[:i] + args[i + 2:]
    if len(args) < 2:
        print('usage: python3 tools/deck.py from-csv FILE.csv "Pack name" [--labels Group,Category]')
        return 2
    path, title = Path(args[0]), args[1]
    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.reader(text.splitlines(), delimiter="\t" if path.suffix.lower() in (".tsv", ".txt") else ","))
    rows = [r for r in rows if any(c.strip() for c in r) and not r[0].startswith("#")]
    col = {"term": 0, "def": 1, "cat": 2, "group": 3}
    if rows and rows[0] and rows[0][0].strip().lower() in ("term", "front", "question", "word", "concept"):
        hdr = [h.strip().lower() for h in rows.pop(0)]
        def find(names, default):
            return next((i for i, h in enumerate(hdr) if h in names), default)
        col = {"term": find({"term", "front", "question", "word", "concept"}, 0),
               "def": find({"def", "definition", "back", "answer", "meaning", "description"}, 1),
               "cat": find({"category", "objective", "topic", "subtopic"}, -1),
               "group": find({"group", "domain", "section", "chapter", "subject"}, -1)}
    cell = lambda r, k: r[col[k]].strip() if 0 <= col[k] < len(r) else ""
    groups, cats, cards, ids, seen = {}, {}, [], set(), set()
    for r in rows:
        term, definition = cell(r, "term"), cell(r, "def")
        if not term or not definition or term.lower() in seen:
            continue
        seen.add(term.lower())
        gname = cell(r, "group") or "General"
        if gname not in groups:
            base = "".join(w[:4] for w in slug(gname).split("-"))[:8] or "g"
            gid, n = base, 2
            while gid in {g["id"] for g in groups.values()}:
                gid, n = f"{base}{n}", n + 1
            groups[gname] = {"id": gid, "name": gname, "short": gname if len(gname) <= 14 else gname[:13] + "…"}
        g = groups[gname]
        cname = cell(r, "cat") or "General"
        key = (g["id"], cname.lower())
        if key not in cats:
            k = sum(1 for c in cats.values() if c["domain"] == g["id"]) + 1
            cats[key] = {"id": f"{g['id']}.{k}", "domain": g["id"], "name": cname}
        obj = cats[key]["id"]
        cid = base = f"{obj}-{slug(term)}"
        n = 2
        while cid in ids:
            cid, n = f"{base}-{n}", n + 1
        ids.add(cid)
        cards.append({"id": cid, "obj": obj, "term": term, "def": definition})
    pack = {"schema": 1, "id": slug(title), "title": title, "description": ""}
    if labels:
        pack["labels"] = {"group": labels[0], "category": labels[-1]}
    pack.update({"domains": list(groups.values()), "objectives": list(cats.values()), "cards": cards})
    out = ROOT / "packs" / f"{pack['id']}.json"
    out.write_text(serialize(pack), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}: {len(cards)} cards, {len(groups)} groups, {len(cats)} categories")
    cmd_packs([])
    return 0


def cmd_app(_):
    """Copy the web app into app-dist/ for the desktop (Tauri) build."""
    import shutil
    out = ROOT / "app-dist"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()
    for f in ["index.html", "app.css", "app.js", "manifest.webmanifest"]:
        shutil.copy2(ROOT / f, out / f)
    for d in ["decks", "packs", "icons"]:
        shutil.copytree(ROOT / d, out / d)
    print(f"wrote {out.relative_to(ROOT)}/")
    return 0


COMMANDS = {"app": cmd_app, "from-csv": cmd_from_csv, "validate": cmd_validate, "fmt": cmd_fmt, "packs": cmd_packs, "build": cmd_build, "import": cmd_import, "stats": cmd_stats}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    sys.exit(COMMANDS[sys.argv[1]](sys.argv[2:]))
