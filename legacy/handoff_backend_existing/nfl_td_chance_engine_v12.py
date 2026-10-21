#!/usr/bin/env python3
"""Opportunity/event feature builder for NFL anytime-TD research.

Consumes nflfastR / nflverse play-by-play CSV, not a fabricated event dataset.
Does NOT scrape paid resources. Does NOT assert catches/drops based on incompletions.
For the selected prediction cutoff, learns smoothed TD likelihoods on plays from
PRIOR seasons and games before target week, never future games. Exported player-game
xTD is a retrospective expected-count statistic using the same pregame learned rates.

Example:
 python nfl_td_chance_engine_v12.py --pbp nflverse_play_by_play.csv \
   --season 2026 --predict-week 7 --output-prefix /mnt/data/td_event_v12

Columns needed for high quality: season,week,game_id,posteam,defteam,
play_type,receiver, rusher, yardline_100,air_yards, no_play, pass_touchdown,
rush_touchdown,pass_attempt,rush_attempt,desc. Older names accepted.

Requires plays from 2023-2026 for training. With fewer than 1000 eligible train
plays, results are withheld; this script still exports raw opportunity counts.
Not an accurate individual future game TD probability until drive forecasts,
availability, role allocation, defense and calibration are added.
"""
from __future__ import annotations
import argparse, collections, csv, math, os

def num(x,default=None):
 try:
  if x is None or str(x).strip().lower() in ('','na','nan','none','null'):return default
  return float(x)
 except (TypeError,ValueError): return default

def truth(x): return num(x,0)==1

def get(row,*names):
 for key in names:
  if key in row and row[key] not in ('',None):return row[key]
 return ''

def group_bucket(d):
 if d<=2:return '01-02'
 if d<=5:return '03-05'
 if d<=10:return '06-10'
 if d<=20:return '11-20'
 if d<=40:return '21-40'
 return '41+'

def parse(row):
 yr=num(row.get('season'));week=num(row.get('week'))
 dist=num(row.get('yardline_100'))
 if yr is None or week is None or dist is None:return None
 if truth(row.get('no_play')) or get(row,'play_type')=='no_play':return None
 if truth(row.get('qb_spike')):return None
 typ=get(row,'play_type')
 if typ not in ('pass','run'):return None
 if typ=='pass':
  player=get(row,'receiver','receiver_player_name')
  if not player or (not truth(row.get('pass_attempt')) and row.get('pass_attempt') not in ('',None)):
   return None
  air=num(row.get('air_yards'))
  # Proxy: air yards that reach/cross the goal line; not a verified EZ ball placement.
  endzone_proxy=air is not None and air>=dist
  td=num(row.get('pass_touchdown'))
  if td is None:
   td=int(truth(row.get('touchdown')) and not truth(row.get('interception')))
  subtype='goal-line-proxy' if endzone_proxy else 'other-pass'
 else:
  player=get(row,'rusher','rusher_player_name')
  if not player:return None
  td=num(row.get('rush_touchdown'))
  if td is None:td=int(truth(row.get('touchdown')) and not truth(row.get('fumble_lost')))
  subtype='rush'
 key=(subtype,group_bucket(dist))
 if subtype in ('other-pass','goal-line-proxy') and dist>40 and not subtype=='goal-line-proxy':
  # general pass targets still included but many are extremely low-conversion.
  pass
 return {'season':int(yr),'week':int(week),'game_id':str(row.get('game_id','')),
         'player':player,'offense':row.get('posteam',''), 'defense':row.get('defteam',''),
         'yards_to_goal':dist, 'event_type':subtype,'bucket':key[1],
         'air_yards':num(row.get('air_yards')),'endzone_proxy':endzone_proxy if typ=='pass' else False,
         'actual_td':int(td>0),'description':get(row,'desc'), 'play_id':get(row,'play_id')}

def calc(pbp_path,season,predict_week,prefix):
 events=[]
 with open(pbp_path,newline='',encoding='utf8') as f:
  for row in csv.DictReader(f):
   ev=parse(row)
   if ev and (ev['season']<season or (ev['season']==season and ev['week']<predict_week)):
    events.append(ev)
 training=[e for e in events if e['season']>=season-4]
 rates=collections.defaultdict(lambda:[0,0]);base=collections.defaultdict(lambda:[0,0]);
 for e in training:
  k=(e['event_type'],e['bucket']);rates[k][0]+=e['actual_td'];rates[k][1]+=1
  base[e['event_type']][0]+=e['actual_td'];base[e['event_type']][1]+=1
 allow_xTD=len(training)>=1000
 # Empirical-Bayes shrink to pass/run average with 20 pseudoplays;
 # only used when sufficient historical data exists.
 def prob(e):
  k=(e['event_type'],e['bucket']);success,n=rates[k];global_td,global_n=base[e['event_type']]
  if not global_n:return None
  g=global_td/global_n
  return (success+20*g)/(n+20)
 result=[]
 totals=collections.defaultdict(lambda:{'td':0,'events':0,'goal5_rushes':0,'goal10_rushes':0,'redzone_rushes':0,
                                   'goal5_targets':0,'goal10_targets':0,'redzone_targets':0,'endzone_proxy':0,'xTD':0.0})
 for e in events:
  if e['season']!=season:continue
  p=prob(e) if allow_xTD else None
  e['model_play_td_probability']=round(p,6) if p is not None else ''
  e['evidence_status']='AIR_YARDS_PROXY_NOT_CHARTED' if e['endzone_proxy'] else 'PBP_VERIFIED_OPPORTUNITY'
  result.append(e)
  key=(e['week'],e['offense'],e['defense'],e['player'])
  d=totals[key];d['td']+=e['actual_td'];d['events']+=1
  if p is not None:d['xTD']+=p
  rush=e['event_type']=='rush';dist=e['yards_to_goal']
  if rush:
   if dist<=5:d['goal5_rushes']+=1
   if dist<=10:d['goal10_rushes']+=1
   if dist<=20:d['redzone_rushes']+=1
  else:
   if dist<=5:d['goal5_targets']+=1
   if dist<=10:d['goal10_targets']+=1
   if dist<=20:d['redzone_targets']+=1
   if e['endzone_proxy']:d['endzone_proxy']+=1
 def out_csv(path,fields,rows):
  with open(path,'w',newline='',encoding='utf8') as f:
   w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore');w.writeheader();w.writerows(rows)
 eventfile=prefix+'_play_events.csv'
 eventcols=['season','week','game_id','offense','defense','player','event_type','yards_to_goal','air_yards','endzone_proxy','actual_td','model_play_td_probability','evidence_status','description','play_id']
 out_csv(eventfile,eventcols,result)
 data=[]
 for (wk,off,df,player),value in sorted(totals.items()):
  data.append({'week':wk,'team':off,'opponent':df,'player':player,
               **value,'historical_xTD':round(value['xTD'],4) if allow_xTD else '',
               'xTD_status':'AVAILABLE - RETROSPECTIVE' if allow_xTD else 'INSUFFICIENT TRAINING - BLANK'})
 statsfile=prefix+'_weekly_opportunity_features.csv'
 cols=['week','team','opponent','player','events','td','goal5_rushes','goal10_rushes','redzone_rushes','goal5_targets','goal10_targets','redzone_targets','endzone_proxy','historical_xTD','xTD_status']
 out_csv(statsfile,cols,data)
 print(f'Parsed {len(events)} historical eligible plays; {len(result)} 2026-to-date player-play records.')
 print(f'Historical xTD learned: {allow_xTD}. Output: {eventfile}, {statsfile}')
 print('Data note: incomplete pass != drop; endzone air-yards flag is a PROXY; no current-game future leakage.')

if __name__=='__main__':
 a=argparse.ArgumentParser()
 a.add_argument('--pbp',required=True,help='local nflverse/nflfastR play by play CSV')
 a.add_argument('--season',type=int,default=2026)
 a.add_argument('--predict-week',type=int,default=7)
 a.add_argument('--output-prefix',default='/mnt/data/td_chance_v12')
 args=a.parse_args();calc(args.pbp,args.season,args.predict_week,args.output_prefix)
