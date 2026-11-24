"""Shared data loading, metrics and similarity logic for the RideOps v0.

Everything here is pure pandas so the Streamlit app, the analysis script and the
backtest all compute numbers the same way.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "rideops_support_tickets.csv"
PULL = pd.Timestamp("2026-09-30 23:59")  # data pulled end of 30 Sep 2026

BOUNCE_OUTCOMES = {
    "Config issue - returned to L1": "L1 could have fixed (config)",
    "Insufficient info - returned to L1": "Missing info",
    "Not a bug - how-to": "L1 could have answered (how-to)",
    "Duplicate of known issue": "Known issue already open",
    "Not reproducible": "Not reproducible",
}
PREVENTABLE = ["Config issue - returned to L1", "Insufficient info - returned to L1", "Not a bug - how-to"]

_STOP = set("the a an in on of for to is are be by and or not but our we with at from after still while than this that it".split())


def template(desc: str) -> str:
    """Normalise a description to its issue pattern (numbers -> N)."""
    return re.sub(r"\d+", "N", str(desc)).strip()


def tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z]+", str(text).lower())
    return {w for w in words if w not in _STOP and len(w) > 1}


def load(path: Path | str = DATA) -> pd.DataFrame:
    df = pd.read_csv(path)
    for c in ["created_at", "first_response_at", "first_closed_at", "final_closed_at"]:
        df[c] = pd.to_datetime(df[c])
    df["end"] = df["final_closed_at"].fillna(PULL)
    df["hours_open"] = (df["end"] - df["created_at"]).dt.total_seconds() / 3600
    df["first_close_h"] = (df["first_closed_at"] - df["created_at"]).dt.total_seconds() / 3600
    df["frt_h"] = (df["first_response_at"] - df["created_at"]).dt.total_seconds() / 3600
    df["esc"] = df["escalated_to_eng"].eq("Yes")
    df["outcome"] = df["eng_outcome"].fillna("")
    df["bounced"] = df["esc"] & df["outcome"].ne("Fixed") & df["outcome"].ne("")
    df["preventable"] = df["outcome"].isin(PREVENTABLE)
    df["reopened"] = df["reopen_count"] > 0
    df["tmpl"] = df["description"].map(template)
    df["week"] = df["created_at"].dt.to_period("W-SUN").dt.start_time
    return df


# ---------------------------------------------------------------- weekly scorecard
def open_at(df: pd.DataFrame, t: pd.Timestamp) -> pd.DataFrame:
    return df[(df["created_at"] <= t) & (df["end"] > t)]


def weekly_scorecard(df: pd.DataFrame) -> pd.DataFrame:
    """One row per week (Mon-Sun). Escalation/reopen metrics are by creation week."""
    weeks = sorted(df["week"].unique())
    rows = []
    for w in weeks:
        w = pd.Timestamp(w)
        wend = min(w + pd.Timedelta(days=7), PULL)
        created = df[df["week"] == w]
        o = open_at(df, wend - pd.Timedelta(seconds=1)) if wend < PULL else df[df["final_closed_at"].isna()]
        esc = created[created["esc"]]
        decided = esc[esc["outcome"] != ""]
        closed = df[(df["final_closed_at"] >= w) & (df["final_closed_at"] < wend)]
        rows.append({
            "week": w.date(),
            "created": len(created),
            "closed": len(closed),
            "open_end_of_week": len(o),
            "open_with_eng_history": int(o["esc"].sum()),
            "escalation_rate": esc.shape[0] / max(len(created), 1),
            "bounce_rate": decided["bounced"].mean() if len(decided) else np.nan,
            "preventable_bounce_rate": decided["preventable"].mean() if len(decided) else np.nan,
            "handoffs_per_escalation": esc["eng_handoffs"].mean() if len(esc) else np.nan,
            "reopen_rate": created["reopened"].mean(),
            "median_first_response_h": created["frt_h"].median(),
            "csat": created["csat_score"].mean(),
        })
    return pd.DataFrame(rows)


def agent_table(df: pd.DataFrame) -> pd.DataFrame:
    e = df[df["esc"]]
    t = df.groupby("assigned_agent").agg(
        tickets=("ticket_id", "size"),
        escalation_rate=("esc", "mean"),
        median_hours_to_first_close=("first_close_h", "median"),
        reopen_rate=("reopened", "mean"),
        csat=("csat_score", "mean"),
    )
    t["escalations"] = e.groupby("assigned_agent").size()
    t["bounce_rate"] = e[e["outcome"] != ""].groupby("assigned_agent")["bounced"].mean()
    t["preventable_bounces"] = e.groupby("assigned_agent")["preventable"].sum()
    return t.fillna(0).sort_values("bounce_rate", ascending=False)


# ---------------------------------------------------------------- similarity + known issues
def similar_tickets(df: pd.DataFrame, category: str, description: str, as_of: pd.Timestamp,
                    exclude_id: str | None = None, min_jaccard: float = 0.5) -> tuple[pd.DataFrame, str]:
    """Past tickets similar to this one, using only what was known at `as_of`.

    Match order: same issue pattern -> word overlap within category -> whole category.
    Returns (matches, how_matched).
    """
    hist = df[(df["created_at"] < as_of)]
    if exclude_id:
        hist = hist[hist["ticket_id"] != exclude_id]
    t = template(description)
    same = hist[hist["tmpl"] == t]
    if len(same) >= 5:
        return same, "same issue pattern"
    q = tokens(description)
    cat = hist[hist["category"] == category]
    if q and len(cat):
        sims = cat["description"].map(lambda d: len(q & tokens(d)) / max(len(q | tokens(d)), 1))
        close = cat[sims >= min_jaccard]
        if len(close) >= 5:
            return close, "similar wording"
    return cat, "same category"


def outcome_profile(sim: pd.DataFrame, as_of: pd.Timestamp) -> dict:
    """What happened to similar escalations whose outcome was known by `as_of`."""
    esc = sim[sim["esc"] & (sim["final_closed_at"].notna()) & (sim["final_closed_at"] < as_of) & (sim["outcome"] != "")]
    l1 = sim[~sim["esc"] & sim["final_closed_at"].notna() & (sim["final_closed_at"] < as_of)]
    counts = esc["outcome"].value_counts()
    n = len(esc)
    return {
        "similar_total": len(sim),
        "escalated_known": n,
        "escalation_rate": sim["esc"].mean() if len(sim) else np.nan,
        "outcomes": counts,
        "fixed_share": counts.get("Fixed", 0) / n if n else np.nan,
        "preventable_share": esc["preventable"].mean() if n else np.nan,
        "median_h_escalated": esc["hours_open"].median() if n else np.nan,
        "median_h_l1": l1["hours_open"].median() if len(l1) else np.nan,
        "handoffs": esc["eng_handoffs"].mean() if n else np.nan,
    }


def known_issue_hits(df: pd.DataFrame, description: str, as_of: pd.Timestamp, window_days: int = 30,
                     exclude_id: str | None = None) -> pd.DataFrame:
    """Recent escalations of the same issue pattern that engineering already marked as a
    duplicate of a known issue (outcome known by `as_of`)."""
    t = template(description)
    h = df[(df["tmpl"] == t) & df["esc"] & (df["created_at"] >= as_of - pd.Timedelta(days=window_days))
           & (df["final_closed_at"] < as_of) & (df["outcome"] == "Duplicate of known issue")]
    if exclude_id:
        h = h[h["ticket_id"] != exclude_id]
    return h.sort_values("created_at", ascending=False)


def open_eng_same_issue(df: pd.DataFrame, description: str, as_of: pd.Timestamp, exclude_id: str | None = None) -> pd.DataFrame:
    """Escalations of the same issue pattern that are with engineering right now."""
    t = template(description)
    o = df[(df["tmpl"] == t) & df["esc"] & (df["created_at"] < as_of) & (df["end"] > as_of)]
    if exclude_id:
        o = o[o["ticket_id"] != exclude_id]
    return o
