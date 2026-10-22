"""Defensive schemes and how offenses beat them.

What each defense runs, from charting data published by nflverse:
  * FTN charting (this season): pass rushers, blitzers, men in the box, play action, motion, screens, RPOs.
  * NGS participation: man or zone and the coverage shell (Cover 0, 1, 2, 3, 4, 6, 2-man). nflverse publishes it
    after a season ends, so the current season falls back to last season's coverage until it appears.

How offenses beat them: EPA per play allowed in each situation (against the blitz, against play action, deep passes,
runs into a stacked box, against man or zone...) compared with the league. Small samples are pulled toward the league
(a defense needs about SHRINK plays in a split before its own number counts for half).

Which of these numbers mean anything: every metric is checked on last season the way tendencies.py checks touchdown
traits, odd weeks against even weeks across the 32 defenses. A scheme rate (blitz %, man %) that repeats is a real
trait; an EPA split that does not repeat is mostly noise and is labelled that way. Nothing here changes a pick.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import ingest, paths, sources

SHRINK = 40            # plays of league average mixed into each defense's split
MIN_PLAYS = 15         # a split needs this many plays to be called out
STRONG, SOME = 0.5, 0.25

PBP_COLS = ["game_id", "play_id", "season_type", "week", "posteam", "defteam", "down", "ydstogo", "play_type", "qb_dropback",
            "qb_scramble", "pass_length", "pass_location", "air_yards", "run_location", "run_gap", "epa", "success",
            "qb_hit", "sack", "two_point_attempt", "pass", "rush"]
FTN_COLS = ["nflverse_game_id", "nflverse_play_id", "n_defense_box", "is_motion", "is_play_action", "is_screen_pass", "is_rpo",
            "is_qb_out_of_pocket", "n_blitzers", "n_pass_rushers"]
PART_COLS = ["nflverse_game_id", "play_id", "defense_man_zone_type", "defense_coverage_type", "was_pressure"]

COVER_LABEL = {"COVER_0": "Cover 0", "COVER_1": "Cover 1", "COVER_2": "Cover 2", "2_MAN": "2-Man", "COVER_3": "Cover 3",
               "COVER_4": "Cover 4 (quarters)", "COVER_6": "Cover 6", "COVER_9": "Cover 9"}

# split -> (label, which plays, needs)
SPLITS: dict[str, tuple[str, str, str]] = {
    "vs_blitz": ("Passes against the blitz", "dropback & blitz", "ftn"),
    "vs_four": ("Passes against a 4-man rush or fewer", "dropback & ~blitz", "ftn"),
    "play_action": ("Play-action passes", "dropback & pa", "ftn"),
    "no_play_action": ("Straight dropbacks (no play action)", "dropback & ~pa", "ftn"),
    "motion": ("Plays with pre-snap motion", "scrimmage & motion", "ftn"),
    "screen": ("Screen passes", "dropback & screen", "ftn"),
    "rpo": ("RPOs", "scrimmage & rpo", "ftn"),
    "out_of_pocket": ("QB out of the pocket (boots, scrambles)", "dropback & oop", "ftn"),
    "deep": ("Deep passes (20+ air yards)", "aimed & deep", "pbp"),
    "intermediate": ("Intermediate passes (10-19 air yards)", "aimed & mid", "pbp"),
    "short": ("Short passes (under 10 air yards)", "aimed & short", "pbp"),
    "middle": ("Passes over the middle", "aimed & loc_middle", "pbp"),
    "outside": ("Passes outside the numbers", "aimed & loc_outside", "pbp"),
    "run_stacked": ("Runs into a stacked box (8+)", "run & stacked", "ftn"),
    "run_light": ("Runs against a light box (6 or fewer)", "run & light", "ftn"),
    "run_outside": ("Outside runs (end)", "run & r_end", "pbp"),
    "run_inside": ("Inside runs (guard, center)", "run & r_inside", "pbp"),
    "third_down_pass": ("Third-down passes", "dropback & third", "pbp"),
    "vs_man": ("Passes against man coverage", "dropback & man", "cov"),
    "vs_zone": ("Passes against zone coverage", "dropback & zone", "cov"),
    "vs_cover1": ("Passes against Cover 1", "dropback & c1", "cov"),
    "vs_cover2": ("Passes against Cover 2 / 2-Man", "dropback & c2", "cov"),
    "vs_cover3": ("Passes against Cover 3", "dropback & c3", "cov"),
    "vs_cover4": ("Passes against quarters (Cover 4/6)", "dropback & c4", "cov"),
}
# scheme rates: label, numerator mask, denominator mask
RATES: dict[str, tuple[str, str, str]] = {
    "blitz_rate": ("Blitz rate (5+ rushers or a DB/LB blitz)", "dropback & blitz", "dropback & charted"),
    "rushers": ("Average pass rushers", "", ""),
    "stacked_box_rate": ("Runs faced with 8+ in the box", "run & stacked", "run & charted"),
    "light_box_rate": ("Runs faced with 6 or fewer in the box", "run & light", "run & charted"),
    "pressure_rate": ("Sack or QB hit on dropbacks", "dropback & hit", "dropback"),
    "man_rate": ("Man coverage", "dropback & man", "dropback & covered"),
    "zone_rate": ("Zone coverage", "dropback & zone", "dropback & covered"),
}


def _bool(s: pd.Series) -> pd.Series:
    return s.astype(str).str.upper().isin(["TRUE", "1", "1.0"])


def load(season: int, raw: Path, ftn: Path | None, part: Path | None) -> pd.DataFrame:
    """Regular-season scrimmage plays of one season, with charting columns where they exist."""
    p = pd.read_csv(raw / sources.local_name("pbp", season), usecols=lambda c: c in PBP_COLS, low_memory=False)
    p = p[(p.season_type == "REG") & p.play_type.isin(["pass", "run"]) & (p.two_point_attempt != 1) & p.epa.notna()
          & p.posteam.notna() & p.defteam.notna()].copy()
    if ftn is not None and ftn.exists():
        f = pd.read_csv(ftn, usecols=lambda c: c in FTN_COLS, low_memory=False)
        f = f.rename(columns={"nflverse_game_id": "game_id", "nflverse_play_id": "play_id"}).drop_duplicates(["game_id", "play_id"])
        p = p.merge(f, on=["game_id", "play_id"], how="left")
    if part is not None and part.exists():
        c = pd.read_csv(part, usecols=lambda c: c in PART_COLS, low_memory=False)
        c = c.rename(columns={"nflverse_game_id": "game_id"}).drop_duplicates(["game_id", "play_id"])
        p = p.merge(c, on=["game_id", "play_id"], how="left")
    return p


def masks(p: pd.DataFrame) -> dict[str, pd.Series]:
    t = pd.Series(True, index=p.index)
    f = pd.Series(False, index=p.index)
    charted = p["n_pass_rushers"].notna() if "n_pass_rushers" in p else f
    blitz = ((p.get("n_pass_rushers", np.nan) >= 5) | (p.get("n_blitzers", 0) >= 1)) & charted
    box = p.get("n_defense_box", pd.Series(np.nan, index=p.index))
    air = p.air_yards
    cov = p.get("defense_coverage_type", pd.Series(np.nan, index=p.index)).astype("string")
    mz = p.get("defense_man_zone_type", pd.Series(np.nan, index=p.index)).astype("string")
    flag = lambda col: _bool(p[col]) & charted if col in p else f  # noqa: E731
    return {
        "scrimmage": t, "dropback": p.qb_dropback == 1, "run": (p.play_type == "run") & (p.qb_scramble != 1),
        "aimed": (p.play_type == "pass") & air.notna(), "charted": charted, "blitz": blitz, "~blitz": charted & ~blitz,
        "pa": flag("is_play_action"), "~pa": charted & ~flag("is_play_action"), "motion": flag("is_motion"),
        "screen": flag("is_screen_pass"), "rpo": flag("is_rpo"), "oop": flag("is_qb_out_of_pocket"),
        "stacked": charted & (box >= 8), "light": charted & (box <= 6) & (box > 0),
        "deep": air >= 20, "mid": (air >= 10) & (air < 20), "short": air < 10,
        "loc_middle": p.pass_location == "middle", "loc_outside": p.pass_location.isin(["left", "right"]),
        "r_end": p.run_gap == "end", "r_inside": p.run_gap.isna() & p.run_location.eq("middle") | p.run_gap.eq("guard"),
        "third": p.down == 3, "hit": (p.qb_hit == 1) | (p.sack == 1),
        "covered": mz.isin(["MAN_COVERAGE", "ZONE_COVERAGE"]).fillna(False),
        "man": mz.eq("MAN_COVERAGE").fillna(False), "zone": mz.eq("ZONE_COVERAGE").fillna(False),
        "c1": cov.isin(["COVER_1", "COVER_0"]).fillna(False), "c2": cov.isin(["COVER_2", "2_MAN"]).fillna(False),
        "c3": cov.eq("COVER_3").fillna(False), "c4": cov.isin(["COVER_4", "COVER_6"]).fillna(False),
    }


def _mask(m: dict, expr: str) -> pd.Series:
    out = None
    for part in expr.split(" & "):
        x = m[part]
        out = x if out is None else out & x
    return out.fillna(False).astype(bool)


def split_table(p: pd.DataFrame, side: str) -> pd.DataFrame:
    """EPA, success and play count per team (side = defteam or posteam) per split; league row under team '_league'."""
    m = masks(p)
    rows = []
    for key, (_, expr, _) in SPLITS.items():
        sel = p[_mask(m, expr)]
        if sel.empty:
            continue
        g = sel.groupby(side).agg(n=("epa", "size"), epa=("epa", "sum"), succ=("success", "sum")).reset_index()
        g["split"] = key
        rows.append(g.rename(columns={side: "team"}))
        rows.append(pd.DataFrame([{"team": "_league", "n": len(sel), "epa": sel.epa.sum(), "succ": sel.success.sum(), "split": key}]))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(columns=["team", "n", "epa", "succ", "split"])


def rate_table(p: pd.DataFrame) -> pd.DataFrame:
    m = masks(p)
    rows = []
    for key, (_, num, den) in RATES.items():
        if key == "rushers":
            sel = p[_mask(m, "dropback & charted")]
            if len(sel):
                rows += [{"team": t, "metric": key, "value": v, "n": k} for t, (v, k) in
                         sel.groupby("defteam").n_pass_rushers.agg(["mean", "size"]).iterrows()]
                rows.append({"team": "_league", "metric": key, "value": sel.n_pass_rushers.mean(), "n": len(sel)})
            continue
        d = _mask(m, den)
        if not d.any():
            continue
        nmask = _mask(m, num)
        g = pd.DataFrame({"team": p.defteam, "num": nmask & d, "den": d})[d].groupby("team").agg(num=("num", "sum"), den=("den", "sum"))
        rows += [{"team": t, "metric": key, "value": r.num / r.den, "n": int(r.den)} for t, r in g.iterrows() if r.den]
        rows.append({"team": "_league", "metric": key, "value": g.num.sum() / g.den.sum(), "n": int(g.den.sum())})
    return pd.DataFrame(rows)


def coverage_mix(p: pd.DataFrame) -> dict[str, dict[str, float]]:
    if "defense_coverage_type" not in p:
        return {}
    d = p[(p.qb_dropback == 1) & p.defense_coverage_type.isin(list(COVER_LABEL))]
    if d.empty:
        return {}
    mix = d.groupby("defteam").defense_coverage_type.value_counts(normalize=True)
    out = {t: {COVER_LABEL[k]: round(float(v), 3) for k, v in mix[t].items()} for t in d.defteam.unique()}
    out["_league"] = {COVER_LABEL[k]: round(float(v), 3) for k, v in d.defense_coverage_type.value_counts(normalize=True).items()}
    return out


def repeatability(p: pd.DataFrame, side: str = "defteam") -> dict[str, dict]:
    """Odd-week vs even-week correlation across teams for every split (EPA) and, for defenses, every scheme rate."""
    out = {}
    halves = [p[p.week % 2 == 1], p[p.week % 2 == 0]]
    st = [split_table(h, side) for h in halves]
    for key in SPLITS:
        a, b = (s[(s.split == key) & (s.team != "_league") & (s.n >= MIN_PLAYS)].set_index("team") for s in st)
        j = a.join(b, lsuffix="_a", rsuffix="_b", how="inner")
        if len(j) >= 16:
            r = _corr(j.epa_a / j.n_a, j.epa_b / j.n_b)
            if r is not None:
                out[key] = {"r": round(r, 2), "teams": len(j), "label": _label(r)}
    if side != "defteam":
        return out
    rt = [rate_table(h) for h in halves]
    for key in RATES:
        a, b = (r[(r.metric == key) & (r.team != "_league")].set_index("team") for r in rt)
        if a.empty or b.empty:
            continue
        j = a.join(b, lsuffix="_a", rsuffix="_b", how="inner")
        if len(j) >= 16:
            r = _corr(j.value_a, j.value_b)
            if r is not None:
                out[key] = {"r": round(r, 2), "teams": len(j), "label": _label(r)}
    return out


def _corr(a, b) -> float | None:
    a, b = np.asarray(a, float), np.asarray(b, float)
    return None if a.std() == 0 or b.std() == 0 else float(np.corrcoef(a, b)[0, 1])


def _label(r: float) -> str:
    return "repeats" if r >= STRONG else "somewhat repeats" if r >= SOME else "mostly noise"


def _profiles(sp: pd.DataFrame, rates: pd.DataFrame, rep: dict, side: str) -> dict[str, dict]:
    league = sp[sp.team == "_league"].set_index("split")
    teams = {}
    for t, g in sp[sp.team != "_league"].groupby("team"):
        splits = []
        for _, r in g.iterrows():
            lg = league.loc[r.split]
            lg_epa = lg.epa / lg.n
            shrunk = (r.epa + SHRINK * lg_epa) / (r.n + SHRINK)
            splits.append({"split": r.split, "label": SPLITS[r.split][0], "plays": int(r.n), "epa": round(float(r.epa / r.n), 3),
                           "epa_shrunk": round(float(shrunk), 3), "league_epa": round(float(lg_epa), 3),
                           "success": round(float(r.succ / r.n), 3), "league_success": round(float(lg.succ / lg.n), 3),
                           "diff": round(float(shrunk - lg_epa), 3), "repeat": rep.get(r.split, {}).get("label")})
        teams[t] = {"splits": sorted(splits, key=lambda s: list(SPLITS).index(s["split"]))}
        if side == "defteam" and not rates.empty:
            rr = rates[rates.team == t]
            lr = rates[rates.team == "_league"].set_index("metric").value
            teams[t]["rates"] = {m: {"label": RATES[m][0], "value": round(float(v), 3), "league": round(float(lr[m]), 3),
                                     "plays": int(n), "repeat": rep.get(m, {}).get("label")}
                                 for m, v, n in zip(rr.metric, rr.value, rr.n)}
    # league rank (1 = allows the most EPA for a defense, gains the most for an offense)
    for key in SPLITS:
        vals = sorted(((v["splits"], s["epa_shrunk"]) for v in teams.values() for s in v["splits"] if s["split"] == key and s["plays"] >= MIN_PLAYS),
                      key=lambda x: -x[1])
        for rank, (lst, val) in enumerate(vals, 1):
            for s in lst:
                if s["split"] == key:
                    s["rank"], s["of"] = rank, len(vals)
    return teams


def _weak_spots(d: dict, n=3) -> tuple[list, list]:
    ok = [s for s in d["splits"] if s["plays"] >= MIN_PLAYS]
    weak = sorted([s for s in ok if s["diff"] > 0.02], key=lambda s: -s["diff"])[:n]
    strong = sorted([s for s in ok if s["diff"] < -0.02], key=lambda s: s["diff"])[:n]
    return weak, strong


def _usage(p: pd.DataFrame) -> dict[str, dict[str, float]]:
    """How often each offense calls each split, so matchups can say 'they lean on it'."""
    m = masks(p)
    base = {"dropback": _mask(m, "dropback"), "scrimmage": _mask(m, "scrimmage"), "run": _mask(m, "run"), "aimed": _mask(m, "aimed")}
    out: dict[str, dict[str, float]] = {}
    for key, (_, expr, _) in SPLITS.items():
        first = expr.split(" & ")[0]
        num, den = _mask(m, expr), base[first]
        if "charted" in m and SPLITS[key][2] == "ftn":
            den = den & m["charted"].fillna(False)
        if SPLITS[key][2] == "cov":
            den = den & m["covered"]
        g = pd.DataFrame({"team": p.posteam, "num": num & den, "den": den})[den].groupby("team")[["num", "den"]].sum()
        if g.den.sum() == 0:
            continue
        for t, r in g.iterrows():
            out.setdefault(t, {})[key] = round(float(r.num / r.den), 3) if r.den else 0.0
        out.setdefault("_league", {})[key] = round(float(g.num.sum() / g.den.sum()), 3)
    return out


# scheme a defense leans on -> the split that shows how an offense does against it
SCHEME_SPLIT = {"blitz_rate": "vs_blitz", "man_rate": "vs_man", "zone_rate": "vs_zone", "stacked_box_rate": "run_stacked",
                "light_box_rate": "run_light"}
SHELL_SPLIT = {"Cover 1": "vs_cover1", "Cover 0": "vs_cover1", "Cover 2": "vs_cover2", "2-Man": "vs_cover2", "Cover 3": "vs_cover3",
               "Cover 4 (quarters)": "vs_cover4", "Cover 6": "vs_cover4"}


def matchup(offense: str, defense: str, res: dict, n=4) -> list[dict]:
    """What this defense leans on (scheme rates repeat) and how this offense has done against it, best for the offense first."""
    o, d = res["offenses"].get(offense), res["defenses"].get(defense)
    if not o or not d:
        return []
    osp = {s["split"]: s for s in o["splits"]}
    out = []
    lean = [(m, r["value"], r["league"], r["label"]) for m, r in d.get("rates", {}).items() if m in SCHEME_SPLIT and r["value"] > r["league"] * 1.1]
    shells = d.get("coverage_mix", {})
    lg = res.get("league_coverage_mix", {})
    lean += [(k, v, lg.get(k, 0), k) for k, v in shells.items() if k in SHELL_SPLIT and v >= 0.15 and v > lg.get(k, 0) * 1.1]
    for key, rate, league, label in lean:
        sp = osp.get(SCHEME_SPLIT.get(key) or SHELL_SPLIT.get(key))
        if not sp or sp["plays"] < MIN_PLAYS:
            continue
        out.append({"scheme": label, "defense_rate": round(rate, 3), "league_rate": round(league, 3), "split": sp["split"],
                    "label": sp["label"], "offense_epa": sp["epa_shrunk"], "league_epa": sp["league_epa"], "diff": sp["diff"],
                    "offense_rank": sp.get("rank"), "of": sp.get("of"), "plays": sp["plays"],
                    "repeat": res.get("offense_repeatability", {}).get(sp["split"], {}).get("label"),
                    "edge": "offense" if sp["diff"] > 0.02 else "defense" if sp["diff"] < -0.02 else "even"})
    return sorted(out, key=lambda x: -abs(x["diff"]))[:n]


def build(season: int, raw: Path, log=print) -> dict:
    ftn_now = raw / f"ftn_{season}.csv"
    part_now, part_prev = raw / f"participation_{season}.csv", raw / f"participation_{season - 1}.csv"
    ftn_prev = raw / f"ftn_{season - 1}.csv"
    cur = load(season, raw, ftn_now, part_now)
    if cur.empty:
        return {"season": season, "available": False, "reason": "No play-by-play for this season yet."}
    cov_now = "defense_man_zone_type" in cur and cur.defense_man_zone_type.notna().sum() > 500
    prev = load(season - 1, raw, ftn_prev, part_prev) if (raw / sources.local_name("pbp", season - 1)).exists() else pd.DataFrame()
    cov_src = cur if cov_now else prev
    rep = repeatability(prev) if not prev.empty else {}
    orep = repeatability(prev, "posteam") if not prev.empty else {}

    dsp, osp = split_table(cur, "defteam"), split_table(cur, "posteam")
    if not cov_now and not prev.empty:   # coverage splits come from last season until this season's charting is published
        keep = [k for k, v in SPLITS.items() if v[2] == "cov"]
        dsp = pd.concat([dsp[~dsp.split.isin(keep)], (x := split_table(prev, "defteam"))[x.split.isin(keep)]], ignore_index=True)
        osp = pd.concat([osp[~osp.split.isin(keep)], (y := split_table(prev, "posteam"))[y.split.isin(keep)]], ignore_index=True)
    rates = rate_table(cur)
    if not cov_now and not prev.empty:
        pr = rate_table(prev)
        rates = pd.concat([rates[~rates.metric.isin(["man_rate", "zone_rate"])], pr[pr.metric.isin(["man_rate", "zone_rate"])]], ignore_index=True)
    defenses = _profiles(dsp, rates, rep, "defteam")
    offenses = _profiles(osp, pd.DataFrame(), rep, "posteam")
    mix = coverage_mix(cov_src)
    for t, d in defenses.items():
        d["weak_spots"], d["strengths"] = _weak_spots(d)
        d["coverage_mix"] = mix.get(t, {})
    cov_season = season if cov_now else season - 1
    for side in (defenses, offenses):
        for v in side.values():
            for sp in v["splits"]:
                sp["season"] = cov_season if SPLITS[sp["split"]][2] == "cov" else season
    for t, o in offenses.items():
        good = [s for s in o["splits"] if s["plays"] >= MIN_PLAYS]
        o["best"] = sorted(good, key=lambda s: -s["diff"])[:3]
        o["worst"] = sorted(good, key=lambda s: s["diff"])[:3]
    charted_weeks = sorted(int(w) for w in cur.loc[cur.n_pass_rushers.notna(), "week"].unique()) if "n_pass_rushers" in cur else []
    res = {"season": season, "available": True, "through_week": int(cur.week.max()), "charted_weeks": charted_weeks,
           "coverage_season": season if cov_now else (season - 1 if mix else None),
           "coverage_note": None if cov_now else (f"Man/zone and coverage shells are from {season - 1}: nflverse publishes "
                                                  f"this charting after the season ends. Coaching changes can make them stale."),
           "league_coverage_mix": mix.get("_league", {}), "repeatability": rep, "offense_repeatability": orep, "repeat_season": season - 1 if rep else None,
           "defenses": defenses, "offenses": offenses, "usage": _usage(cur),
           "method": ("EPA per play allowed in each situation, pulled toward the league average by "
                      f"{SHRINK} plays so a handful of snaps can't make a defense look broken. A weak spot is a situation where "
                      "the defense allows more than the league and the split repeated from odd to even weeks last season. "
                      "Sources: nflverse play-by-play, FTN charting, NGS participation.")}
    return res


def run(season: int, download: bool = False, log=print) -> dict:
    raw = paths.raw_dir()
    if download:
        for kind, yr in (("ftn", season), ("ftn", season - 1), ("participation", season), ("participation", season - 1)):
            try:
                ingest.download(kind, yr, raw, log, max_age_hours=12 if yr == season else None)
            except RuntimeError as ex:   # this season's participation file appears only after the season
                log(f"schemes: {kind} {yr} not available ({str(ex)[:80]})")
    res = build(season, raw, log)
    out = paths.results_dir() / f"schemes_{season}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, separators=(",", ":"), default=float))
    if res.get("available"):
        log(f"schemes: {len(res['defenses'])} defenses through week {res['through_week']}, charting weeks {res['charted_weeks'][-1:] or 'none'}, "
            f"coverage from {res['coverage_season']}")
    return res


def load_result(season: int) -> dict | None:
    f = paths.results_dir() / f"schemes_{season}.json"
    return json.loads(f.read_text()) if f.exists() else None
