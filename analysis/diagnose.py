"""Reproduces every number in the write-up and draws its figures.

Run:  python analysis/diagnose.py   -> prints findings, writes writeup/fig_*.png
"""
import sys
from pathlib import Path

import matplotlib
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
from core import PREVENTABLE, PULL, ROOT, agent_table, known_issue_hits, load, weekly_scorecard  # noqa: E402

OUT = ROOT / "writeup"
OUT.mkdir(exist_ok=True)
BLUE, ORANGE, GRAY, INK, MUTED = "#2a78d6", "#eb6834", "#a3a29d", "#0b0b0b", "#52514e"
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False, "axes.edgecolor": "#c9c8c3",
                     "axes.labelcolor": MUTED, "xtick.color": MUTED, "ytick.color": MUTED, "axes.titleweight": "bold",
                     "axes.titlesize": 10, "axes.titlelocation": "left"})

df = load()
e = df[df["esc"]]
P = lambda x: f"{x:.0%}"  # noqa: E731


def section(t):
    print(f"\n=== {t}")


# 1. Is the backlog real, and where does it come from? ------------------------------------
section("Volume and backlog")
m = df.groupby(df.created_at.dt.month).agg(n=("ticket_id", "size"), mean_h=("hours_open", "mean"))
print(m)
print(f"Tickets created Jul -> Sep: {m.n[7]} -> {m.n[9]} ({m.n[9] / m.n[7] - 1:+.0%})")
print(f"Mean hours open per ticket Jul -> Sep: {m.mean_h[7]:.0f} -> {m.mean_h[9]:.0f} ({m.mean_h[9] / m.mean_h[7] - 1:+.0%}) (Sep is understated: still-open tickets are cut off at the pull)")
days = pd.date_range("2026-07-02 18:00", "2026-09-30 18:00", freq="D")
daily_open = pd.Series([((df.created_at <= t) & (df.end > t)).sum() for t in days], index=days)
print("Average tickets open per day by month:", daily_open.groupby(daily_open.index.month).mean().round(1).to_dict())
aug_first, sep_last = daily_open["2026-08-01":"2026-08-14"].mean(), daily_open["2026-09-17":"2026-09-30"].mean()
print(f"Open tickets, first half Aug vs last half Sep: {aug_first:.0f} -> {sep_last:.0f} ({sep_last / aug_first - 1:+.0%})")
print(f"Open at pull: {df.final_closed_at.isna().sum()} ({(df.final_closed_at.isna() & df.esc).sum()} have been to engineering)")
nl1 = df[~df.esc].groupby(df.created_at.dt.month).first_close_h.median()
print("Median hours to close, non-escalated, by month:", nl1.round(1).to_dict())
print("Median first response hours by month:", df.groupby(df.created_at.dt.month).frt_h.median().round(1).to_dict())
cat = pd.crosstab(df.category, df.created_at.dt.month)
cat["growth"] = cat[9] / cat[7] - 1
print(cat.sort_values(9, ascending=False))
print("Tier by month:", pd.crosstab(df.client_tier, df.created_at.dt.month).to_dict())

# 2. Escalations are a third of tickets but most of the open time ---------------------------
section("Escalations")
hrs = df.hours_open.sum()
print(f"Escalated: {len(e)} of {len(df)} ({P(len(e) / len(df))}) but {P(e.hours_open.sum() / hrs)} of all ticket-hours open")
print(f"Median hours open: escalated {e.hours_open.median():.0f} vs L1-only {df[~df.esc].hours_open.median():.0f}")
oc = e.outcome.value_counts()
print(oc, f"\nFixed: {P(oc['Fixed'] / len(e))}; returned/not-a-bug: {P(1 - oc['Fixed'] / len(e))}")
prev = e[e.preventable]
print(f"Preventable (config + insufficient info + how-to): {len(prev)} ({P(len(prev) / len(e))} of escalations)")
by_out = e.groupby("outcome").agg(n=("ticket_id", "size"), handoffs=("eng_handoffs", "mean"), median_h=("hours_open", "median"),
                                  csat=("csat_score", "mean"), hours=("hours_open", "sum"))
print(by_out.round(2))
print("By handoffs:", e.groupby("eng_handoffs").hours_open.median().round(0).to_dict())
print(f"Handoffs per escalation: {e.eng_handoffs.mean():.2f}; with 2+ handoffs: {(e.eng_handoffs >= 2).sum()}")
ci = e[e.outcome.str.startswith(("Config", "Insufficient"))]
print(f"Config+insufficient: {len(ci)} tickets, {P(ci.hours_open.sum() / hrs)} of all ticket-hours; avg handoffs {ci.eng_handoffs.mean():.1f}; CSAT {ci.csat_score.mean():.2f} vs fixed {e[e.outcome == 'Fixed'].csat_score.mean():.2f}")
l1_mean = df[~df.esc].hours_open.mean()
for lbl, sub in [("config+insufficient", ci), ("all preventable", prev), ("all non-fixed", e[e.bounced])]:
    save = sub.hours_open.sum() - len(sub) * l1_mean
    print(f"If {lbl} ({len(sub)}) were handled like an L1 ticket: -{save:,.0f} ticket-hours = -{save / hrs:.0%} average open backlog")
print("Outcome mix by month:\n", pd.crosstab(e.created_at.dt.month, e.outcome, normalize="index").round(2))
dup = e[e.outcome == "Duplicate of known issue"]
print("Duplicates by category & month:\n", pd.crosstab(dup.category, dup.created_at.dt.month))
print("Duplicates, top issues:\n", dup.tmpl.value_counts().head(4))
bc = e.groupby("category").agg(n=("ticket_id", "size"), bounce=("bounced", "mean"))
print("Bounce rate by category (range):", bc[bc.n >= 20].bounce.round(2).to_dict())

# 3. Agents --------------------------------------------------------------------------------
section("Agents")
at = agent_table(df)
print(at.round(2))
k = df[df.assigned_agent == "Karan B"]
rest = df[df.assigned_agent != "Karan B"]
print(f"Karan B: median first close {k.first_close_h.median():.1f}h vs rest {rest.first_close_h.median():.1f}h; reopen {P(k.reopened.mean())} vs {P(rest.reopened.mean())}; "
      f"{k.reopened.sum()} of {df.reopened.sum()} reopened tickets ({P(k.reopened.sum() / df.reopened.sum())}) from {P(len(k) / len(df))} of volume; CSAT {k.csat_score.mean():.2f} vs {rest.csat_score.mean():.2f}")
r = df[df.assigned_agent == "Rahul T"]
re_ = e[e.assigned_agent == "Rahul T"]
print(f"Rahul T: escalates {P(r.esc.mean())} vs team {P(df[df.assigned_agent != 'Rahul T'].esc.mean())}; bounce {P(re_.bounced.mean())}; "
      f"how-to escalations {(re_.outcome == 'Not a bug - how-to').sum()} of {(e.outcome == 'Not a bug - how-to').sum()}")
best = at.bounce_rate.min()
print(f"Agent bounce-rate range {P(at.bounce_rate.min())}–{P(at.bounce_rate.max())}")
print(f"Reopened tickets: {df.reopened.sum()} ({P(df.reopened.mean())}), {P(df[df.reopened].hours_open.sum() / hrs)} of ticket-hours; CSAT reopened {df[df.reopened].csat_score.mean():.2f} vs not {df[~df.reopened].csat_score.mean():.2f}")
print("Channel/tier/priority checks:")
print(df.groupby("channel").agg(n=("ticket_id", "size"), esc=("esc", "mean"), reopen=("reopened", "mean")).round(2))
print(df.groupby("priority").agg(n=("ticket_id", "size"), frt=("frt_h", "median"), med_h=("hours_open", "median")).round(1))

# 4. Backtest of the v0's automatic signals --------------------------------------------------
section("v0 backtest (what the tool would have flagged, using only data known at the time)")
non_eng = e[e.category.isin(["How-to / feature request", "Cab delay / no-show complaint", "Driver / vehicle compliance docs"])]
print(f"Escalations in 'not engineering' categories: {len(non_eng)} ({P(non_eng.bounced.mean())} bounced)")
flag = e.apply(lambda r: len(known_issue_hits(df, r.description, r.created_at, 30, r.ticket_id)) > 0, axis=1)
d = e.outcome == "Duplicate of known issue"
print(f"Known-issue flag: fires on {flag.sum()} escalations; catches {(flag & d).sum()} of {d.sum()} duplicates ({P((flag & d).sum() / d.sum())}); "
      f"precision {P((flag & d).sum() / flag.sum())} vs base rate {P(d.mean())}")

# 5. Scorecard -------------------------------------------------------------------------------
section("Weekly scorecard")
sc = weekly_scorecard(df)
print(sc.round(2).to_string())
sc.to_csv(OUT / "weekly_scorecard.csv", index=False)

# ---------------------------------------------------------------------------- figures
full = sc[sc.week < pd.Timestamp("2026-09-28").date()]
fig, ax = plt.subplots(1, 2, figsize=(7.2, 2.4))
ax[0].plot(full.week, full.created, color=BLUE, lw=2, marker="o", ms=4)
ax[0].set_title("Tickets created per week")
ax[0].set_ylim(0)
ax[1].plot(daily_open.index, daily_open.values, color=GRAY, lw=1.5, label="All open tickets")
eo = pd.Series([((df.created_at <= t) & (df.end > t) & df.esc).sum() for t in days], index=days)
ax[1].plot(eo.index, eo.values, color=ORANGE, lw=2, label="…of which escalated")
ax[1].set_title("Open tickets per day")
ax[1].legend(frameon=False, fontsize=8)
ax[1].set_ylim(0)
for a in ax:
    a.tick_params(axis="x", labelrotation=0)
    a.xaxis.set_major_formatter(matplotlib.dates.DateFormatter("%d %b"))
    a.xaxis.set_major_locator(matplotlib.dates.MonthLocator())
fig.tight_layout()
fig.savefig(OUT / "fig_backlog.png", dpi=200)

order = ["Fixed", "Config issue - returned to L1", "Insufficient info - returned to L1", "Not a bug - how-to",
         "Duplicate of known issue", "Not reproducible"]
o = by_out.reindex(order)
fig, ax = plt.subplots(1, 2, figsize=(7.2, 2.3), gridspec_kw={"width_ratios": [1.3, 1]})
cols = [BLUE if i == "Fixed" else ORANGE if i in PREVENTABLE else GRAY for i in order]
short = ["Fixed", "Config issue", "Insufficient info", "Not a bug: how-to", "Duplicate (known)", "Not reproducible"]
ax[0].barh(short, o.n, color=cols, height=0.6)
ax[0].invert_yaxis()
for i, v in enumerate(o.n):
    ax[0].text(v + 3, i, f"{v}", va="center", fontsize=8, color=INK)
ax[0].set_title("486 escalations: engineering's verdict")
ax[1].barh(short, o.median_h / 24, color=cols, height=0.6)
ax[1].invert_yaxis()
ax[1].set_yticklabels([])
for i, (v, h) in enumerate(zip(o.median_h / 24, o.handoffs)):
    ax[1].text(v + 0.1, i, f"{v:.1f} d · {h:.1f} handoffs", va="center", fontsize=8, color=INK)
ax[1].set_title("Median days open")
ax[1].set_xlim(0, 8.5)
fig.tight_layout()
fig.savefig(OUT / "fig_escalations.png", dpi=200)

fig, ax = plt.subplots(1, 2, figsize=(7.2, 2.4))
for name, row in at.iterrows():
    for i, (x, y, star) in enumerate([(row.median_hours_to_first_close, row.reopen_rate, "Karan B"),
                                      (row.escalation_rate, row.bounce_rate, "Rahul T")]):
        ax[i].scatter(x, y, s=40, color=ORANGE if name == star else GRAY, zorder=3)
        if name == star or (i == 1 and name == "Vikram S"):
            ax[i].annotate(name, (x, y), xytext=(5, -3), textcoords="offset points", fontsize=8, color=INK)
ax[0].annotate("other 7 agents", (21, 0.105), fontsize=7, color=MUTED)
ax[0].set_xlabel("Median hours to first close")
ax[0].set_ylabel("Reopen rate")
ax[0].set_title("Fast closes get reopened")
ax[1].set_xlabel("Share of tickets escalated")
ax[1].set_ylabel("Escalations returned unfixed")
ax[1].set_title("Over-escalation bounces back")
for a in ax:
    a.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1, decimals=0))
ax[1].xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1, decimals=0))
fig.tight_layout()
fig.savefig(OUT / "fig_agents.png", dpi=200)
print("\nfigures written to", OUT)
