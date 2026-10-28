# Prompt: have an AI write a pack

Paste this into Claude (or any chatbot), fill in the brackets, and attach or paste your source material. Save the reply as a `.csv` file. Then either drop it into **Add cards** in the app, or run `python3 tools/deck.py from-csv file.csv "Pack name"`.

---

Make flashcards for studying **[subject, e.g. CompTIA Network+ N10-009]** from the material below.

Rules:
- Cover every key term, acronym, port number, command and concept a student needs.
- One card per idea. Keep the term short (at most 8 words) and the definition to one or two clear sentences, with a quick example when it helps.
- Sort the cards into **groups** (big sections, like exam domains or chapters) and **categories** (topics inside a group).
- Only state facts you are sure of. If the material has an error, write the correct fact.

Reply with only CSV, no commentary, using exactly this header:

term,definition,category,group

Put quotes around any field that contains a comma.

Material:
[paste notes, a syllabus, an exam objectives list, or a chapter]
