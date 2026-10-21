"""NFL anytime-TD selective research policy (v1.1), October 21, 2026.

Purpose: audit selective top-N hit rates alongside v0.1 while avoiding inflated
'probabilities'. A player's score is a role/opportunity ranking, NOT a calibrated
individual touchdown probability. Designed to be reproduced on a full league
weekly dataset (seasonal weeks require real pregame active roster coverage).

Example:
  python nfl_td_selective_v11.py --input nfl_2026_verified_pilot_player_games.csv \
      --out /mnt/data

Do not market pilot hit rates as prospective accuracy: only 26 hand-picked players.
"""
from __future__ import annotations
import argparse, json, math, os
import numpy as np
import pandas as pd
from nfl_td_model import read_data, make_history, feature_row, CURRENT_WEEK_7, VENOM_PROBS


def wilson_interval(hits: int, total: int, z: float = 1.959963984540054):
    if total == 0:
        return (None,None)
    p = hits / total
    denominator = 1 + z*z/total
    center = (p + z*z/(2*total))/denominator
    margin = z*math.sqrt(p*(1-p)/total + z*z/(4*total*total))/denominator
    return (float(max(0,center-margin)),float(min(1,center+margin)))


def aggregate_backtest(full: pd.DataFrame):
    h=make_history(full)
    h=h[h.week.between(3,6)].copy()
    if h.empty: raise ValueError('No eligible player-week rows in Weeks 3-6')
    policies={
        'Opportunity (rush attempts + receptions)': 'lag_opportunities',
        'Smoothed recent TD rate': 'baseline',
    }
    rows=[]; picks=[]
    for policy,metric in policies.items():
        for k in [1,2,3,5,10]:
            selection=(h.sort_values(['week',metric,'player_key'],ascending=[True,False,True])
                       .groupby('week',sort=True).head(k).copy())
            selection['policy']=policy
            selection['slots_per_week']=k
            hits=int(selection.any_td.sum());total=int(len(selection));lo,hi=wilson_interval(hits,total)
            rows.append({'policy':policy,'slots_per_week':k,'hits':hits,'picks':total,
                         'hit_rate':hits/total,'wilson95_low':lo,'wilson95_high':hi,
                         'comparison_note':'EXPLORATORY, elite-player cohort; not prospective validation'})
            picks.append(selection)
    out=pd.DataFrame(rows)
    details=pd.concat(picks,ignore_index=True)
    week_summary=(details[(details.policy=='Opportunity (rush attempts + receptions)')&(details.slots_per_week==2)]
                  .groupby('week').agg(hits=('any_td','sum'),selections=('any_td','size')).reset_index())
    return out, details, week_summary


def week7_candidate_ranking(full: pd.DataFrame):
    rows=[]
    for (player,team), t in full.groupby(['player','team'],sort=False):
        if team not in CURRENT_WEEK_7:continue
        t=t.sort_values('week')
        if t.empty:continue
        p=t.iloc[-1]['position'];f,raw_p=feature_row(t,p)
        vp,vs=VENOM_PROBS.get(player,(None,None))
        rows.append({'player':player,'team':team,'opp':CURRENT_WEEK_7[team],
                     'position':p,'last_played_week':int(t.week.max()),
                     'pregame_recent_rush_attempts':round(f[0],2),
                     'pregame_recent_receptions':round(f[1],2),
                     'pregame_recent_opportunities':round(f[3],2),
                     'pregame_smoothed_td_rate':round(raw_p,3),
                     'venom_displayed_anytime_td_probability':vp,
                     'venom_displayed_score':vs,
                     'status':'RESEARCH ONLY; injuries/lineups not verified; no calibrated probability'})
    return pd.DataFrame(rows).sort_values(['pregame_recent_opportunities','player'],ascending=[False,True]).reset_index(drop=True)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--input',default='/mnt/data/nfl_2026_verified_pilot_player_games.csv')
    p.add_argument('--out',default='/mnt/data')
    a=p.parse_args()
    os.makedirs(a.out,exist_ok=True)
    full=read_data(a.input)
    metrics,details,weeks=aggregate_backtest(full)
    forecast=week7_candidate_ranking(full)
    metrics.to_csv(os.path.join(a.out,'nfl_v11_backtest_policy_metrics.csv'),index=False)
    details.to_csv(os.path.join(a.out,'nfl_v11_backtest_all_picks.csv'),index=False)
    weeks.to_csv(os.path.join(a.out,'nfl_v11_week_by_week_top2.csv'),index=False)
    forecast.to_csv(os.path.join(a.out,'nfl_v11_week7_opportunity_watchlist.csv'),index=False)
    print(metrics.to_string(index=False,float_format=lambda v:f'{v:.3f}'))
    print('\nWEEKLY TOP TWO:',weeks.to_string(index=False))
    print('\n2026 week 7 candidate watchlist (NOT probabilities):\n',forecast.head(12).to_string(index=False))

if __name__=='__main__':main()
