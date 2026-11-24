"""API tests for the Escalation Check. Run: .venv/bin/python -m pytest -s tests"""
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app.server as server

client = TestClient(server.app)


@pytest.fixture(autouse=True)
def temp_log(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LOG", tmp_path / "decisions.csv")


def test_queue_lists_only_tickets_open_with_l1():
    rows = client.get("/api/tickets?mode=queue").json()
    print(f"queue has {len(rows)} tickets")
    assert len(rows) == 29
    assert all(r["status"] == "Open - with L1" for r in rows)


def test_replay_lists_every_escalation():
    rows = client.get("/api/tickets?mode=replay").json()
    print(f"replay has {len(rows)} escalations")
    assert len(rows) == 486


def test_replay_check_never_uses_information_from_after_the_ticket_was_raised():
    raised = pd.Timestamp(server.DF.set_index("ticket_id").loc["SUP-11389", "created_at"])
    body = client.post("/api/check", json={"ticket_id": "SUP-11389", "replay": True}).json()
    print(f"as_of={body['as_of']} raised={raised} similar escalations with known outcome={body['escalated_known']}")
    assert pd.Timestamp(body["as_of"]) == raised
    sim, _ = server.similar_tickets(server.DF, body["ticket"]["category"], body["ticket"]["description"], raised, "SUP-11389")
    assert (sim["created_at"] < raised).all()
    known = sim[sim["esc"] & (sim["final_closed_at"] < raised)]
    assert body["escalated_known"] == len(known)
    assert body["actual"]["eng_outcome"] == "Config issue - returned to L1"


def test_check_returns_category_playbook_and_outcome_breakdown():
    body = client.post("/api/check", json={"category": "Roster / booking not syncing", "description": "Cancelled bookings still appearing in tomorrow's roster"}).json()
    print(f"checks={len(body['checks'])} fields={len(body['fields'])} outcomes={[o['n'] for o in body['outcomes']]}")
    assert body["checks"] and body["fields"]
    assert sum(o["n"] for o in body["outcomes"]) == body["escalated_known"]
    assert body["is_engineering"]


def test_non_engineering_category_is_flagged():
    body = client.post("/api/check", json={"category": "Cab delay / no-show complaint", "description": "Cab arrived 40 mins late for 9 PM shift"}).json()
    print(f"owner: {body['owner']}")
    assert body["is_engineering"] is False


def test_new_ticket_needs_category_and_description():
    r = client.post("/api/check", json={"category": "Roster / booking not syncing", "description": "  "})
    print(f"blank description -> {r.status_code}")
    assert r.status_code == 422


def test_escalating_an_incomplete_check_needs_a_reason():
    base = dict(ticket_id="SUP-11444", category="x", description="y", decision="Escalate to engineering", ready=False,
                checks_done=1, checks_total=3, fields_done=0, fields_total=4)
    r = client.post("/api/log", json=base)
    print(f"no reason -> {r.status_code}")
    assert r.status_code == 422
    r = client.post("/api/log", json={**base, "override_reason": "P1, client escalated to CEO"})
    print(f"with reason -> {r.status_code}")
    assert r.status_code == 200
    logged = client.get("/api/log").json()
    assert logged[0]["override_reason"] == "P1, client escalated to CEO"


def test_scorecard_matches_the_write_up():
    sc = client.get("/api/scorecard").json()
    wk = {w["week"]: w for w in sc["weeks"]}["2026-09-21"]
    print(f"w/c 21 Sep: open={wk['open_end_of_week']} L1-fixable={wk['preventable_bounce_rate']:.2f} handoffs={wk['handoffs_per_escalation']:.2f}")
    assert wk["open_end_of_week"] == 43
    assert round(wk["preventable_bounce_rate"], 2) == 0.41
    assert round(wk["handoffs_per_escalation"], 2) == 1.64
    assert sc["weeks"][-1]["partial"] is True
