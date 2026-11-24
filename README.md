# RideOps Support: Escalation Check (v0)

A working internal tool for **L1 support agents**. Run it before escalating a ticket to engineering.
It runs on `data/rideops_support_tickets.csv`. The write-up is in `writeup/writeup.pdf`.

## Run it (about 2 minutes)

Needs Python 3.11 or newer.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.server:app --port 8000     # then open http://localhost:8000
```

Tests: `.venv/bin/pip install pytest httpx && .venv/bin/python -m pytest -s tests`

## What's inside

| View | User | What it does |
|---|---|---|
| **Escalation check** | L1 agent | Pick a ticket from the open queue, replay a past escalation, or describe a new one. The check is four short screens, each with one big answer: (1) what happened to similar escalations; (2) whether it's a known issue or belongs to another team; (3) a category checklist to rule out config and collect what engineering needs; (4) the decision, with the engineering note and the client update ready to copy. Decisions are logged to `logs/decisions.csv`. |
| **Scorecard** | Support lead / Head of Ops | Four pages. **Overview**: the headline (open tickets at week end), the two drivers and the guardrails, each against its target with a status. **Trends**: weekly charts. **By agent**: a coaching table. **Logged checks**: decisions recorded with the tool. |

**Replay mode** puts you at the moment a past ticket was raised. The tool uses only the tickets and engineering outcomes known at that time. *Reveal the real outcome* then shows what actually happened.

Light and dark mode follow the system setting; the button in the top bar overrides it. The look is a white theme with an emerald brand colour; emerald marks actions and progress only, while data has its own colours (teal = fixed by engineering, orange = L1 could have handled it).

## Files

```
app/server.py         FastAPI: the JSON API and the static frontend
app/core.py           data loading, weekly metrics, similarity and known-issue logic (also used by the analysis)
app/playbook.json     per-category checklists: v0 seed, for engineering to own and edit
app/static/           frontend: index.html, styles.css (light/dark tokens), app.js, charts.js (hand-drawn SVG charts)
analysis/diagnose.py  reproduces every number and chart in the write-up (output in diagnose_output.txt)
tests/test_api.py     API tests, including that replay never uses information from after the ticket was raised
writeup/              write-up (PDF/HTML/MD) and figures
data/                 the two CSVs provided with the brief
```

## Assumptions and limits

- "Now" in the app is the data pull (30 Sep 2026, 23:59). Weeks run Monday to Sunday; the week of 28 Sep is partial.
- Similar tickets are matched on the description pattern (numbers normalised), then word overlap, then category. There is no ML model: 486 escalations is too few, and the text carries little signal about the outcome.
- The checklist content is inferred from which outcomes bounce back, plus assumptions about the product. Engineering should correct it.
- No logins, and no integration with the ticketing system. Decisions are logged to a local CSV.
