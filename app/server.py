"""RideOps v0 API + static frontend.

Run:  .venv/bin/uvicorn app.server:app --port 8000   (then open http://localhost:8000)
All numbers come from core.py, the same code that produces the write-up.
"""
from __future__ import annotations

import csv
import json
import math
from datetime import datetime
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.core import (PREVENTABLE, PULL, ROOT, agent_table, known_issue_hits, load, open_eng_same_issue,
                      outcome_profile, similar_tickets, weekly_scorecard)

HERE = Path(__file__).parent
PLAYBOOK = json.loads((HERE / "playbook.json").read_text())
LOG = ROOT / "logs" / "decisions.csv"
LOG_FIELDS = ["logged_at", "ticket_id", "agent", "category", "description", "decision", "ready",
              "checks_done", "checks_total", "fields_done", "fields_total", "override_reason", "known_issue_flag"]
OUTCOME_ORDER = ["Fixed", "Config issue - returned to L1", "Insufficient info - returned to L1",
                 "Not a bug - how-to", "Duplicate of known issue", "Not reproducible"]
TARGETS = {"open_end_of_week": 30, "preventable_bounce_rate": 0.20, "handoffs_per_escalation": 1.3,
           "reopen_rate": 0.07, "median_first_response_h": 3.0, "csat": 3.7}

DF = load()
app = FastAPI(title="RideOps Escalation Check")


def clean(v):
    """JSON-safe scalars: NaN -> None, timestamps -> ISO strings."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.isoformat()
    if hasattr(v, "item"):
        return clean(v.item())
    return v


def ticket_row(r) -> dict:
    return {k: clean(getattr(r, k)) for k in ["ticket_id", "created_at", "channel", "client_name", "client_tier", "category",
                                              "priority", "description", "assigned_agent", "status", "eng_outcome",
                                              "eng_handoffs", "eng_ticket_id", "reopen_count", "csat_score",
                                              "final_closed_at", "hours_open"]}


@app.get("/api/meta")
def meta():
    return {"as_of": PULL.isoformat(), "tickets": len(DF), "from": DF.created_at.min().isoformat(),
            "categories": sorted(k for k in PLAYBOOK if not k.startswith("_")),
            "clients": sorted(DF.client_name.unique().tolist())}


@app.get("/api/tickets")
def tickets(mode: str = "queue"):
    """queue = open with L1 now; replay = every past escalation (newest first)."""
    pool = DF[DF.status == "Open - with L1"] if mode == "queue" else DF[DF.esc]
    pool = pool.sort_values("created_at", ascending=False)
    return [ticket_row(r) for r in pool.itertuples()]


class CheckIn(BaseModel):
    ticket_id: str | None = None
    category: str | None = None
    description: str | None = None
    priority: str | None = "P3"
    client_name: str | None = None
    replay: bool = False


@app.post("/api/check")
def check(body: CheckIn):
    actual = None
    if body.ticket_id:
        hit = DF[DF.ticket_id == body.ticket_id]
        if hit.empty:
            raise HTTPException(404, "Unknown ticket")
        t = next(hit.itertuples())
        category, description = t.category, t.description
        # Replay stands at the moment the ticket was raised, so only what was knowable then is used.
        as_of = t.created_at if body.replay else PULL
        ticket = ticket_row(t)
        if body.replay:
            actual = ticket
    else:
        if body.category not in PLAYBOOK or not (body.description or "").strip():
            raise HTTPException(422, "Category and description are required")
        category, description, as_of = body.category, body.description.strip(), PULL
        ticket = {"ticket_id": None, "category": category, "description": description, "priority": body.priority,
                  "client_name": body.client_name, "created_at": PULL.isoformat()}
    tid = body.ticket_id
    sim, how = similar_tickets(DF, category, description, as_of, exclude_id=tid)
    prof = outcome_profile(sim, as_of)
    ki = known_issue_hits(DF, description, as_of, 30, tid)
    live = open_eng_same_issue(DF, description, as_of, tid)
    pb = PLAYBOOK[category]
    oc = prof["outcomes"]
    return {
        "ticket": ticket,
        "as_of": as_of.isoformat(),
        "replay": body.replay,
        "match": how,
        "similar_total": prof["similar_total"],
        "escalated_known": prof["escalated_known"],
        "outcomes": [{"outcome": o, "n": int(oc.get(o, 0)),
                      "group": "fixed" if o == "Fixed" else "l1" if o in PREVENTABLE else "other"} for o in OUTCOME_ORDER],
        "fixed_share": clean(prof["fixed_share"]),
        "preventable_share": clean(prof["preventable_share"]),
        "median_h_escalated": clean(prof["median_h_escalated"]),
        "median_h_l1": clean(prof["median_h_l1"]),
        "known_issue": [{"eng_ticket_id": r.eng_ticket_id, "client_name": r.client_name, "created_at": r.created_at.isoformat()}
                        for r in ki.head(5).itertuples()],
        "open_with_eng": [{"eng_ticket_id": r.eng_ticket_id, "client_name": r.client_name} for r in live.head(6).itertuples()],
        "open_with_eng_total": len(live),
        "owner": pb["owner"],
        "is_engineering": pb["owner"].startswith("Engineering"),
        "checks": pb["config_checks"],
        "fields": pb["required_info"],
        "actual": actual,
    }


@app.get("/api/scorecard")
def scorecard():
    sc = weekly_scorecard(DF)
    sc["partial"] = sc["week"] >= pd.Timestamp("2026-09-28").date()
    weeks = [{k: clean(v) if not hasattr(v, "isoformat") else v.isoformat() for k, v in row.items()} for row in sc.to_dict("records")]
    at = agent_table(DF).reset_index()
    agents = [{k: clean(v) for k, v in row.items()} for row in at.to_dict("records")]
    return {"weeks": weeks, "agents": agents, "targets": TARGETS}


class LogIn(BaseModel):
    ticket_id: str | None = None
    agent: str | None = None
    category: str
    description: str
    decision: str
    ready: bool
    checks_done: int
    checks_total: int
    fields_done: int
    fields_total: int
    override_reason: str = ""
    known_issue_flag: bool = False


@app.post("/api/log")
def log(body: LogIn):
    if body.decision == "Escalate to engineering" and not body.ready and not body.override_reason.strip():
        raise HTTPException(422, "Escalating before the check is complete needs a reason")
    LOG.parent.mkdir(exist_ok=True)
    new = not LOG.exists()
    row = {"logged_at": datetime.now().isoformat(timespec="seconds"), **body.model_dump()}
    row["ticket_id"] = row["ticket_id"] or "NEW"
    with LOG.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        if new:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in LOG_FIELDS})
    return {"ok": True}


@app.get("/api/log")
def log_list():
    if not LOG.exists():
        return []
    return pd.read_csv(LOG, dtype=str, keep_default_na=False).tail(50).iloc[::-1].to_dict("records")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")
