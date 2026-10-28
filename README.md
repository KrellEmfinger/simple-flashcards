# Simple Flashcards

A simple, quick flashcard app built to easily generate flashcards for study, without needing a subscription or handing over your information.

It's small and dependency-free, and runs in your browser. You can keep several decks (say *A+*, *Security+* and *Networking*) and switch between them, study, edit cards, turn your notes into new cards, and install ready-made **deck packs**. Each deck is one JSON file in this repository, so every change is versioned in Git.

It starts with 8 sample cards so you can see how it works. Install a pack or add your own cards, then remove the samples.

## Features

- **Multiple decks:** the **Deck** menu at the top switches between decks. Each deck has its own name, groups and categories, theme, and study progress, so switching to *A+* turns the whole app into "A+ Flashcards". **+ New deck…** creates an empty one, and **✎ Rename** renames the current one.
- **Themes:** five color themes, **Midnight**, **Graphite**, **Ember**, **Plum** and **Daylight**, plus **Auto**, which follows your device's light or dark setting. The theme is saved with the deck, so each deck can have its own look.
- **Study**
  - Flip cards, or take four-choice quizzes built from cards in the same category.
  - **Study piles:** **Know it** sends a card to the **Known** pile and **Review again** sends it to the **Review** pile, and each button shows its pile's count. Tap a pile to see its cards (and move one back if you graded it wrong). When you reach the end of a round, the Review pile automatically becomes the next round, until every card is Known. **Undo** and **Skip for now** help along the way, and with **Remember** on, your place is kept if you close the tab.
  - **Type the answer:** set **Type answers** to Sometimes, Often or Always and some cards will show the definition and ask you to type the term instead of flipping. Answers are checked loosely (case, punctuation, parenthesized parts, small typos). A wrong answer, or **I don't know**, goes straight to Review and shows the right answer; if the app misjudged it, press **Actually, I knew it**. A right answer asks you to confirm **Know it**.
  - **Timed mode:** turn on **⏱ Timed** and pick 14, 10, 7 or 5 seconds. A session clock runs while you study, and each typed prompt gets a countdown; running out of time sends the card to Review. The finish screen shows your total time, average typed-answer speed, and how many prompts timed out. The clock pauses when you leave the Study tab or switch away from the browser.
  - Filter by group and category, by cards you don't know yet, or by cards you've missed before.
  - Each group shows a progress bar. If a deck defines exam weights, those show too.
  - Keyboard: <kbd>Space</kbd> flip, <kbd>1</kbd> review again, <kbd>2</kbd> know it, <kbd>←</kbd> undo, <kbd>→</kbd> skip, <kbd>E</kbd> edit, <kbd>Enter</kbd> check a typed answer.
- **Edit:** change or delete any card, or add one by hand. Deleting can be undone.
- **Bulk changes:** in **Cards**, tick cards or **Select all matching** (filter by search, group, category, or source pack), then delete or move them all at once. Bulk deletes can be undone.
- **Organize:** **Cards → Manage** lets you rename the deck, pick its theme, create, rename and delete groups and categories, change what they're called (for example "Domain" and "Objective"), choose which deck opens first, or delete the deck.
- **Add cards from notes:** paste text or drop files (`.txt`, `.md`, `.csv`, `.tsv`, `.json`) into **Add cards**.
  - **Find cards in text** runs instantly in your browser. It recognizes `Term: definition` lines, `Term — definition`, "Term is …" sentences, bold terms, Markdown tables, `Q:`/`A:` pairs, CSV/TSV files, and Anki or Quizlet exports.
  - **Generate with Claude** (optional) turns messy notes or lecture transcripts into clean cards sorted into categories. Inside Claude it uses your Claude account; anywhere else it needs an Anthropic API key, entered under **Save & export**.
  - You review every suggested card before it's added. Terms already in the deck are flagged and unticked.
- **Deck packs:** install a ready-made set from the **Deck packs** list, or from a `.json` file. A pack installs as its own deck; if all you have is the sample deck, the pack replaces it. You can also add a pack's cards into the deck you're in.
  - The app remembers which pack each card came from, so **Remove pack** (in **Cards → Manage** or next to the pack in **Add cards**) takes out the whole pack in one click.
  - **Save & export → Export a pack** turns any of your groups into a pack file for sharing.
- **Save**
  - On GitHub Pages, **Commit deck to GitHub** writes every changed deck back to the `decks/` folder of this repository in a single commit, using a token you create. Created and deleted decks are included.
  - When the app is opened as a page inside Claude, **Save to this page** is used instead.
  - Save before leaving: with **Remember** off, unsaved edits are gone after a reload (the app warns you first).
- **Export:** the current deck as a deck file, an Anki/Quizlet tab-separated file with category tags, or a CSV spreadsheet.
- **Fresh start every visit:** by default the app always opens on the decks saved in the repository (or built into the offline file), with no leftover progress, sessions or edits from earlier visits. If you try to leave with unsaved edits, you're warned first. To keep your progress between visits, turn on **Save & export → On this device → Remember my progress and unsaved edits**. Progress is never committed to the repository.
- Light and dark themes, phone-sized screens, no build step, no dependencies.

## Install it

There are three ways to use it, and all of them work offline.

| Way | Best for | How |
| --- | --- | --- |
| **Installable app** | Any computer, phone or tablet | Open the site, then press **⬇ Install app** at the top (or the install icon in Chrome/Edge's address bar). On iPhone/iPad: Share → **Add to Home Screen**. On Android: menu → **Install app**. |
| **Desktop installer** | Windows, Mac, Linux without a browser | Download from the [Releases](../../releases) page: `.msi`/`-setup.exe` (Windows), `aarch64.dmg` (Apple silicon Mac) or `x64.dmg` (Intel Mac), `.AppImage`/`.deb`/`.rpm` (Linux). |
| **Website** | Trying it out | `https://<your-name>.github.io/<repo>/` |

The installers aren't code-signed yet. Windows may say "Windows protected your PC": choose **More info → Run anyway**. macOS may refuse to open it: go to **System Settings → Privacy & Security → Open Anyway**. If macOS says the app is "damaged", run `xattr -dr com.apple.quarantine "/Applications/Simple Flashcards.app"` once.

### Where your decks are saved

- **Save & export → Save to this device** keeps every deck on that computer or phone (in the desktop app's own storage, or the browser's). The app reopens exactly as you left it, with or without internet. Until you save there, it opens with the decks it shipped with.
- **Go back to the original decks** removes the device copy.
- **Commit all decks to GitHub** makes your repository match what you see, so every device and the website get your changes.

## Getting started (developers)

### Use it on GitHub Pages

1. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Push to `main`, or run the **Validate and deploy** workflow from the **Actions** tab.
3. The site appears at `https://<your-name>.github.io/<repo>/` within a minute or two.

### Run it on your computer

```bash
python3 -m http.server 8000      # run in the repo folder, then open http://localhost:8000
```

Opening `index.html` directly (as a `file://` page) can't load the decks. For a single file that works offline, run `python3 tools/deck.py build` and open `dist/flashcards-offline.html`. In that copy, install packs with **Install a deck pack from a file…**.

## Installing a deck pack

1. Open **Add cards**.
2. Under **Deck packs**, press **Install** next to a pack. To use a pack file you downloaded, choose **Install a pack from a file…** instead.
3. Press **Install as a new deck**. Or, to merge it into the deck you're in, choose **Add to "…"**.
4. Go to **Save & export** and save, so the new deck is kept.

### Included packs

| Pack | Cards | What it covers |
| --- | --- | --- |
| `packs/secplus-sy0-701.json` | 875 | CompTIA Security+ SY0-701, organized by the 5 exam domains and 28 objectives |

## Making a new pack (e.g. Networking)

A pack is just a deck file. There are four realistic ways to fill one, from easiest to most hands-on. All of them end with **Save & export → Export a pack** (or the command line) producing `something.json`.

### 1. Build it in the app from your notes

1. Choose **Deck → + New deck…** and name it *Networking*. Then, in **Cards → Manage**, add a group or two and a few categories (*Protocols*, *Ports*, *Subnetting*…).
2. **Add cards**: paste lecture notes, a glossary, a study guide or a transcript, then press **Find cards in text** or **Generate with Claude**. Review the suggestions and add them. Repeat as your course goes on.
3. **Save & export → Export a pack**: tick the groups to include, give the pack a name, and download it.

### 2. Fill in a spreadsheet

Use Excel, Google Sheets or Numbers with these four columns. Start from [`templates/pack-template.csv`](templates/pack-template.csv).

| term | definition | category | group |
| --- | --- | --- | --- |
| TCP | Connection-oriented transport protocol with a three-way handshake… | Protocols | Networking basics |
| /24 subnet | Subnet mask 255.255.255.0: 256 addresses, 254 usable hosts. | Subnetting | IP addressing |

Export it as **CSV**, make a new deck, and drop the file onto **Add cards**. Any categories and groups that don't exist yet are created for you. Then export the pack as in step 3 above.

To skip the app, run:

```bash
python3 tools/deck.py from-csv networking.csv "Networking Basics"
```

That writes `packs/networking-basics.json` and adds it to the pack list.

### 3. Have an AI draft it

Paste the prompt in [`templates/ai-pack-prompt.md`](templates/ai-pack-prompt.md) into Claude along with an exam objectives list, a syllabus, or your notes. It answers in the same CSV format, so continue with route 2. Inside the app, **Generate with Claude** does the same thing for one chunk of notes at a time.

### 4. Convert cards you already have

Anki ("Notes in plain text"), Quizlet (export, tab between term and definition), and any CSV/TSV with term and definition columns all import through **Add cards**.

### Publishing a pack

Upload the `.json` file into this repository's `packs/` folder: on GitHub, open `packs/`, then **Add file → Upload files**, then commit. The deploy workflow rebuilds `packs/index.json` automatically, and the pack shows up under **Add cards → Deck packs** on the site. Anyone else can install it from the file with **Install a deck pack from a file…**.

## Deck format

Decks live in `decks/`:

- `decks/index.json` lists the decks (`id`, `file`, `title`) and which one opens first (`default`).
- Each deck is its own file, e.g. `decks/secplus-sy0-701.json`. A pack in `packs/` has exactly the same format.

Cards are written one per line so Git diffs stay readable.

```json
{
  "schema": 1,
  "id": "networking",
  "title": "Networking",
  "description": "What this deck is for.",
  "labels": {"group": "Group", "category": "Category"},
  "theme": "plum",
  "domains": [
    {"id": "basics", "name": "Networking basics"}
  ],
  "objectives": [
    {"id": "basics.1", "domain": "basics", "name": "Protocols"}
  ],
  "cards": [
    {"id": "basics.1-tcp", "obj": "basics.1", "term": "TCP", "def": "Connection-oriented transport protocol with a three-way handshake."}
  ]
}
```

| Field | Meaning |
| --- | --- |
| `title` | The deck's name, shown as "<title> Flashcards" at the top of the app. |
| `labels` | What the app calls the two grouping levels. The Security+ pack uses Domain and Objective. |
| `theme` | `midnight`, `graphite`, `ember`, `plum` or `daylight`. Leave it out to follow the device. |
| `domains` | Top-level groups. Optional extras: `short` (name on narrow screens) and `weight` (exam percentage). |
| `objectives` | Categories inside a group. Each card points at one through `obj`. |
| card `id` | Stable id. Study progress is keyed on it, so don't reuse ids. |
| card `term` / `def` | Front and back of the card. |
| card `src` | Where it came from: `sample`, `manual`, `notes`, `claude`, or `import`. |
| card `pack` | The pack it was installed from, set by the app; it's what **Remove pack** uses. |
| `packs` | The packs installed in this deck. |

## Command-line tools

These need only Python 3, with no packages to install.

```bash
python3 tools/deck.py validate            # check every deck, the deck list, and every pack (CI runs this)
python3 tools/deck.py fmt                 # rewrite decks in the canonical format
python3 tools/deck.py stats --deck ID     # cards per group and category
python3 tools/deck.py import new.tsv S.1 --deck ID   # append "term<TAB>definition" rows to a category
python3 tools/deck.py packs               # rebuild packs/index.json
python3 tools/deck.py from-csv in.csv "Name"   # spreadsheet -> packs/<name>.json
python3 tools/deck.py build               # dist/flashcards-offline.html
```

## Building the desktop installers

GitHub builds them for you: **Actions → Desktop installers → Run workflow**, or push a version tag:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

About 15 minutes later, a **draft** release with Windows, Mac and Linux installers appears under **Releases**. Check it, then press **Publish**. Before a new release, raise the version number in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.

To build on your own machine, install [Rust](https://rustup.rs/), Node.js and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS, then run:

```bash
npm ci
python3 tools/deck.py app     # copies the app into app-dist/
npx tauri build               # installers land in src-tauri/target/release/bundle/
```

The desktop app is the same web app inside a small native window ([Tauri](https://tauri.app)), plus native "Save as" dialogs for exports.

## Project layout

```
index.html                    page shell
manifest.webmanifest, sw.js   make it installable and offline-capable
icons/                        app icons
app.css                       styles (light and dark)
app.js                        the whole app, plain JavaScript
decks/                        your decks + index.json (starts with an 8-card sample deck)
packs/                        installable deck packs + index.json
templates/                    spreadsheet template and AI prompt for making packs
tools/deck.py                 validate / format / import / pack index / offline build
src-tauri/                    desktop app (Tauri) configuration and icons
package.json                  pins the Tauri CLI used for desktop builds
.github/workflows/pages.yml   validates decks on every push and PR, deploys to GitHub Pages
.github/workflows/release.yml builds Windows/Mac/Linux installers into a draft release
```

## Ideas for later

- Spaced-repetition scheduling (SM-2 style intervals) on top of the known/review marks.
- A timed exam mode weighted by group percentages.
- Image cards.

## License

The code is MIT licensed (see `LICENSE`). The Security+ pack is study notes written in my own words. They draw on the *CompTIA Security+ SY0-701 Certification Guide* (Packt, 3rd ed.) and boot camp lectures. They are not affiliated with CompTIA or Packt.
