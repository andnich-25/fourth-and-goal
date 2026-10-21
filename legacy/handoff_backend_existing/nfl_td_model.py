"""NFL Anytime TD research model v0.1 (2026 pilot + expandable NFLverse loader)

Usage:
  python nfl_td_model.py --input nfl_2026_verified_pilot_player_games.csv --out-dir .
  python nfl_td_model.py --nflverse --out-dir .      # requires internet and pip install nflreadpy

Careful: pilot covers SELECTED players only; results are not league-wide or Venom-backtested.
Inputs: past rushing attempts, receptions, red zone when available (future expansion),
          and prior opponent positional TD concessions (only when full-league stats are supplied).
The current initial evaluation intentionally excludes unpublished historical Venom metrics.
"""
from __future__ import annotations
import argparse, os, math
import pandas as pd
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

# Fixed position priors: model hyperparameters, not observed facts.
POS_PRIOR={'RB':0.36,'WR':0.24,'TE':0.19,'QB':0.12}
CURRENT_WEEK_7={
    'NE':'CHI','CHI':'NE','PIT':'NO','NO':'PIT','IND':'MIN','MIN':'IND',
    'MIA':'NYJ','NYJ':'MIA','CIN':'BAL','BAL':'CIN','CLE':'TEN','TEN':'CLE',
    'TB':'CAR','CAR':'TB','SF':'ATL','ATL':'SF','NYG':'HOU','HOU':'NYG',
    'DEN':'ARI','ARI':'DEN','LAR':'LV','LV':'LAR','GB':'DET','DET':'GB',
    'KC':'SEA','SEA':'KC','DAL':'PHI','PHI':'DAL',
}
# *Only* the estimates directly visible in the user's Venom screenshots.
VENOM_PROBS={
    'Jahmyr Gibbs':(.58,90.3), 'Christian McCaffrey':(.55,80.5),
    'Derrick Henry':(.50,71.4), 'Kenneth Walker III':(.49,69.3),
    'Amon-Ra St. Brown':(.40,58.6),'Matthew Golden':(.35,53.0),
    'Christian Watson':(None,52.7),
}
# Defensive evidence from the user's screenshot: GB 10 RB TDs / 6 GP, Detroit 9 TE TDs / 5 GP.
VENOM_DEFENSE={'GB':{'RB':10/6}, 'DET':{'TE':9/5}}

FEATURES=['lag_rush_att','lag_rec','lag_td_rate','lag_opportunities','lag_touch_trend','is_rb','is_wr','is_te','opp_pos_td_pg']

def load_nflverse(season=2026, until_week=6):
    """Reads the FULL weekly league player set; no future weeks should enter the backtest.
    Requires internet access on the running machine and pip install nflreadpy.
    """
    import nflreadpy as nfl
    raw=nfl.load_player_stats([season], summary_level='week').to_pandas()
    needed=['season','week','player_display_name','team','position','opponent_team']
    for c in needed:
        if c not in raw.columns: raise ValueError(f'nflverse missing required field: {c}')
    raw=raw[(raw.season==season)&(raw.week<=until_week)&(raw.position.isin(['RB','WR','TE','QB']))].copy()
    if 'season_type' in raw.columns: raw=raw[raw.season_type=='REG']
    alias = lambda options: next((c for c in options if c in raw.columns),None)
    carry=alias(['carries','rushing_attempts']); receptions=alias(['receptions'])
    rush_tds=alias(['rushing_tds','rushing_touchdowns']); rec_tds=alias(['receiving_tds','receiving_touchdowns'])
    for field,v in [('carries',carry),('receptions',receptions),('rushing_tds',rush_tds),('receiving_tds',rec_tds)]:
        if v is None: raise ValueError('NFLverse schema does not contain '+field)
    out=raw[['season','week','team','position','opponent_team']].copy()
    out['player']=raw['player_display_name'];out['rush_att']=pd.to_numeric(raw[carry],errors='coerce').fillna(0)
    out['receptions']=pd.to_numeric(raw[receptions],errors='coerce').fillna(0)
    out['rushing_tds']=pd.to_numeric(raw[rush_tds],errors='coerce').fillna(0)
    out['receiving_tds']=pd.to_numeric(raw[rec_tds],errors='coerce').fillna(0)
    out['anytime_td']=((out.rushing_tds+out.receiving_tds)>0).astype(int)
    out['source_url']='https://github.com/nflverse/nflverse-data/releases/tag/stats_player'
    # Identity guard: two players with identical display names on different teams remain separate.
    if 'player_id' in raw.columns: out['player_key']=raw['player_id'].astype(str).to_numpy()
    else: out['player_key']=out['player'].astype(str)+'|'+out['team'].astype(str)
    return out.reset_index(drop=True)

def read_data(path):
    d=pd.read_csv(path)
    mandatory=['week','player','team','position','rush_att','receptions','rushing_tds','receiving_tds']
    missing=[c for c in mandatory if c not in d.columns]
    if missing: raise ValueError(f'Missing required input columns: {missing}')
    for c in ['rush_att','receptions','rushing_tds','receiving_tds']:
        d[c]=pd.to_numeric(d[c],errors='coerce').fillna(0).clip(lower=0)
    d['week']=d['week'].astype(int)
    d['anytime_td']=((d['rushing_tds']+d['receiving_tds'])>0).astype(int)
    if 'player_key' not in d: d['player_key']=d['player']+'|'+d['team']
    return d

def def_rolling_features(full_df):
    """Returns defensive positional TD averages computed ONLY from games before a week's kickoff.
    Enabled only with full NFLverse player data; cannot estimate reliably from the pilot cohort.
    """
    x=full_df.copy()
    if 'opponent_team' not in x.columns: return {}
    x['tds']=x.rushing_tds+x.receiving_tds
    tds=x.groupby(['week','opponent_team','position'],observed=True)['tds'].sum().to_dict()
    # Using offensive team-game count ensures defenders with 0 TD allowed contribute a game.
    valid_games=set(x[['week','opponent_team']].dropna().itertuples(index=False,name=None))
    defense={}
    for week in range(2,8):
        for team in x.opponent_team.dropna().unique():
            n=sum(1 for w,t in valid_games if w<week and t==team)
            for pos in ['RB','WR','TE','QB']:
                td=sum(tds.get((w,team,pos),0) for w in range(1,week))
                # Shrink opponent TD allowed/game to a preregistered role prior (heuristic),
                # to prevent extreme estimates from tiny Week 1–2 samples.
                prior_tds={'RB':0.78,'WR':0.82,'TE':0.30,'QB':0.20}[pos]
                defense[(week,team,pos)]=(td+4*prior_tds)/(n+4)
    return defense

def feature_row(prior, position):
    t=prior.tail(4).sort_values('week')
    weights=np.array([0.75**(len(t)-1-i) for i in range(len(t))],dtype=float)
    if len(t): weights=weights/weights.sum()
    def wavg(s): return float(np.average(t[s].to_numpy(),weights=weights)) if len(t) else 0.0
    att=wavg('rush_att');rec=wavg('receptions')
    scored=wavg('anytime_td')
    # Shrink previous anytime successes towards a fixed position prior, since 2-3 games are noisy.
    rate=(len(t)*scored+3*POS_PRIOR.get(position,.20))/(len(t)+3)
    opp=att+rec
    if len(t)>1:
        mid=len(t)//2
        trend=float(t.iloc[mid:]['rush_att'].add(t.iloc[mid:]['receptions']).mean()-t.iloc[:mid]['rush_att'].add(t.iloc[:mid]['receptions']).mean())
    else: trend=0.
    return [att,rec,rate,opp,trend,float(position=='RB'),float(position=='WR'),float(position=='TE')],rate

def make_history(data,asof_week=None):
    d=data.sort_values(['week','player_key']).copy()
    maxw=int(d.week.max()) if asof_week is None else asof_week-1
    examples=[]
    defenses=def_rolling_features(d) if 'opponent_team' in d.columns else {}
    for (key,team),player_df in d.groupby(['player_key','team'],sort=False):
        player_df=player_df.sort_values('week')
        for r in player_df.itertuples():
            prior=player_df[player_df.week<r.week]
            if prior.empty: continue
            x,baseline=feature_row(prior,r.position)
            opponent=getattr(r,'opponent_team',None)
            default_allowed={'RB':0.78,'WR':0.82,'TE':0.30,'QB':0.20}.get(r.position,.5)
            x.append(defenses.get((int(r.week),opponent,r.position),default_allowed))
            examples.append(dict(week=int(r.week),player=r.player,player_key=key,team=team,position=r.position,
                                 opponent=getattr(r,'opponent_team',None), any_td=int(r.anytime_td),
                                 raw_td=int(r.rushing_tds+r.receiving_tds),baseline=float(baseline),
                                 **dict(zip(FEATURES,x))))
    return pd.DataFrame(examples)

def fit_model(train):
    model=make_pipeline(StandardScaler(),LogisticRegression(C=0.35,max_iter=750,solver='lbfgs'))
    model.fit(train[FEATURES].to_numpy(),train.any_td)
    return model

def evaluate(holdout):
    y=holdout.any_td.to_numpy(dtype=int)
    output={'n':int(len(holdout)),'scoring_games':int(y.sum()),'base_rate':float(y.mean())}
    for label,col in [('algorithm','p_model'),('baseline','baseline')]:
        p=holdout[col].clip(.01,.99).to_numpy()
        output[label+'_brier']=float(brier_score_loss(y,p))
        output[label+'_log_loss']=float(log_loss(y,p,labels=[0,1]))
        output[label+'_auc']=float(roc_auc_score(y,p)) if len(np.unique(y))>1 else None
        for k in [3,5,10]:
            selected=holdout.sort_values(['week',col],ascending=[True,False]).groupby('week').head(k)
            output[label+f'_top{k}_hits']=int(selected.any_td.sum())
            output[label+f'_top{k}_picks']=int(len(selected))
            output[label+f'_top{k}_rate']=float(selected.any_td.mean())
    return output

def backtest(df):
    history=make_history(df)
    estimates=[]
    for week in range(3,7):
        train=history[history.week<week].copy()
        test=history[history.week==week].copy()
        if test.empty or train.any_td.nunique()<2: continue
        m=fit_model(train)
        test['p_model']=m.predict_proba(test[FEATURES].to_numpy())[:,1]
        test['training_rows']=len(train)
        estimates.append(test)
    if not estimates: raise RuntimeError('Insufficient weekly data for historical evaluation')
    result=pd.concat(estimates,ignore_index=True).sort_values(['week','p_model'],ascending=[True,False])
    return result,evaluate(result)

def week7_scores(df):
    df=df.copy()
    history=make_history(df)
    if history.any_td.nunique()<2: raise RuntimeError('No training data')
    model=fit_model(history)
    scores=[]
    defenses=def_rolling_features(df) if 'opponent_team' in df.columns else {}
    for (key,team),t in df.groupby(['player_key','team']):
        pos=t.iloc[-1].position
        if team not in CURRENT_WEEK_7: continue
        x,b=feature_row(t,pos)
        default_allowed={'RB':0.78,'WR':0.82,'TE':0.30,'QB':0.20}.get(pos,.5)
        x.append(defenses.get((7,CURRENT_WEEK_7[team],pos),default_allowed))
        proba=float(model.predict_proba(np.asarray(x,dtype=float).reshape(1,-1))[:,1][0])
        last_week=int(t.week.max())
        vp,vs=VENOM_PROBS.get(t.iloc[-1].player,(None,None))
        scores.append(dict(player=t.iloc[-1].player,team=team,opponent=CURRENT_WEEK_7[team],position=pos,
                           weekly_model_probability=proba,venom_probability=vp,venom_score=vs,
                           prior_week_games=len(t),last_game_week=last_week,
                           raw_prior_scoring_rate=float(t.anytime_td.mean()),
                           projected_rush_att=x[0],projected_receptions=x[1],
                           opponent_pos_tds_per_game_from_venom=VENOM_DEFENSE.get(CURRENT_WEEK_7[team],{}).get(pos),
                           full_league_prior_opponent_pos_td_pg=defenses.get((7,CURRENT_WEEK_7[team],pos))))
    out=pd.DataFrame(scores).sort_values('weekly_model_probability',ascending=False)
    return out

def save_run(df,odir):
    os.makedirs(odir,exist_ok=True)
    test,report=backtest(df)
    tests=os.path.join(odir,'nfl_2026_walk_forward_pilot_backtest.csv')
    test.to_csv(tests,index=False)
    picks=week7_scores(df)
    picks.to_csv(os.path.join(odir,'nfl_2026_week7_pilot_candidates.csv'),index=False)
    import json
    with open(os.path.join(odir,'nfl_2026_pilot_metrics.json'),'w') as f:
        json.dump(report,f,indent=2)
    print(json.dumps(report,indent=2))
    print('\nWeek 7 (PILOT COHORT ONLY, NO DEFENSE/VENOM ADJUSTMENTS):\n',picks[['player','team','opponent','weekly_model_probability','venom_probability','last_game_week']].head(16).to_string(index=False))
    return test,report,picks

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',default='nfl_2026_verified_pilot_player_games.csv')
    parser.add_argument('--nflverse',action='store_true',help='Fetch full league data from NFLverse (requires internet)')
    parser.add_argument('--out-dir',default='.')
    args=parser.parse_args()
    data=load_nflverse() if args.nflverse else read_data(args.input)
    if args.nflverse:
        data.to_csv(os.path.join(args.out_dir,'nfl_2026_nflverse_full_week1_6.csv'),index=False)
    save_run(data,args.out_dir)
