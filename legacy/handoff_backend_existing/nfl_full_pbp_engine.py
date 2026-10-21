#!/usr/bin/env python3
"""NFL touchdown opportunity database + xTD engine, 2023-2026.

Uses nflverse open CSV releases. No extra packages. SQLite for fast incremental reads.
Raw CSV releases retained; each game/season play is indexed in SQLite.
No Venom premium data is copied into the model.

Data honesty:
 * goal-line rush == rush attempt with yardline_100 <= 5
 * red-zone target == named receiver from LOS <= 20
 * end-zone target proxy == pass air_yards >= yardline_100 (NOT charted true EZ target)
 * incompletion != dropped ball
 * xTD is historically estimated play conversion probability, not TD prediction per game
 * never includes 2026 week >= 7 in Week 7 testing.
"""
import argparse, csv, gzip, json, math, os, sqlite3, sys, time, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

PBP_URL='https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{year}.csv'
STATS_URL='https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{year}.csv'
ROSTER_URL='https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{year}.csv'
USER_AGENT='NFL-Opportunity-Research/1.0 (+nflverse CC-BY-4.0)'


def number(v, default=None):
    try:
        if v is None or str(v).strip().lower() in ('','na','nan','null','none'):return default
        return float(v)
    except (ValueError,TypeError):return default

def nint(v):
    n=number(v)
    return int(n) if n is not None else 0

def yes(v):return str(v).strip().lower() in ('1','true','t','yes')

def value(row,*keys):
    for k in keys:
        v=row.get(k)
        if v is not None and str(v).strip() and str(v).lower() not in ('nan','none','na'):
            return str(v).strip()
    return ''

def csv_reader(path):
    handler=gzip.open if str(path).endswith('.gz') else open
    f=handler(path,'rt',newline='',encoding='utf-8-sig')
    return f,csv.DictReader(f)

def fetch_year(year,kind,directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    path=directory/f'{kind}_{year}.csv'
    if path.exists() and path.stat().st_size>10000:
        print(f'Using cached {path} ({path.stat().st_size:,} bytes)')
        return path
    url=({'pbp':PBP_URL,'stats':STATS_URL,'roster':ROSTER_URL}[kind]).format(year=year)
    tmp=path.with_suffix('.download')
    try:
        req=urllib.request.Request(url,headers={'User-Agent':USER_AGENT})
        with urllib.request.urlopen(req,timeout=90) as resp, open(tmp,'wb') as out:
            while True:
                chunk=resp.read(1024*1024)
                if not chunk:break
                out.write(chunk)
        if tmp.stat().st_size<10000: raise RuntimeError(f'Download too small: {tmp.stat().st_size} bytes')
        with open(tmp,'rb') as f:
            if f.read(32).lower().lstrip().startswith((b'<!doctype',b'<html')):raise RuntimeError('Received HTML instead of CSV')
        tmp.replace(path)
        print(f'Downloaded {path}: {path.stat().st_size:,} bytes')
        return path
    except Exception:
        if tmp.exists():tmp.unlink()
        raise RuntimeError(f'Could not download {url}. Place the actual CSV at {path} and rerun.')


def connect(path):
    c=sqlite3.connect(path)
    c.execute('PRAGMA journal_mode=WAL')
    c.execute('PRAGMA synchronous=NORMAL')
    c.executescript('''
    CREATE TABLE IF NOT EXISTS sources(kind TEXT,season INT,filename TEXT,source_url TEXT,rows_imported INT,imported_at TEXT,PRIMARY KEY(kind,season));
    CREATE TABLE IF NOT EXISTS pbp(
      season INT,week INT,game_id TEXT,play_id TEXT,offense TEXT,defense TEXT,
      event_type TEXT,player_id TEXT,player_name TEXT,position TEXT,yards_to_goal REAL,
      air_yards REAL,completed INT,td INT,ez_proxy INT,description TEXT,
      PRIMARY KEY(season,game_id,play_id,event_type,player_id)
    );
    CREATE TABLE IF NOT EXISTS roster_week(
      season INT,week INT,player_id TEXT,player_name TEXT,position TEXT,team TEXT,status TEXT,
      PRIMARY KEY(season,week,player_id,team)
    );
    CREATE TABLE IF NOT EXISTS player_week(
      season INT,week INT,player_id TEXT,player_name TEXT,position TEXT,team TEXT,
      opponent TEXT,carries INT,targets INT,receptions INT,rush_tds INT,rec_tds INT,
      pass_tds INT,season_type TEXT,
      PRIMARY KEY(season,week,player_id,team)
    );
    CREATE INDEX IF NOT EXISTS idx_pbp_time ON pbp(season,week);
    CREATE INDEX IF NOT EXISTS idx_pbp_player ON pbp(season,week,player_id);
    CREATE INDEX IF NOT EXISTS idx_pbp_defense ON pbp(season,week,defense);
    CREATE INDEX IF NOT EXISTS idx_pbp_game ON pbp(game_id);
    CREATE INDEX IF NOT EXISTS idx_player_week ON player_week(season,week,player_id);
    ''')
    return c


def parse_pbp(row,season,max_week=None):
    if value(row,'season_type','game_type') not in ('REG',''):
        return None
    week=nint(row.get('week'))
    if not week or (max_week is not None and season==2026 and week>max_week):return None
    if yes(row.get('no_play')) or yes(row.get('two_point_attempt')) or yes(row.get('qb_spike')):return None
    if value(row,'play_type') not in ('pass','run'):return None
    d=number(row.get('yardline_100'))
    if d is None or not 1<=d<=99:return None
    kind=value(row,'play_type')
    if kind=='pass':
        pid=value(row,'receiver_player_id','receiver_id')
        player=value(row,'receiver_player_name','receiver')
        pos=value(row,'receiver_player_position')
        if not pid and not player:return None
        # An NFL pass target has a named receiver. Uncatchable targets still count.
        if value(row,'pass_attempt') and not yes(row.get('pass_attempt')):return None
        air=number(row.get('air_yards'))
        ez=1 if air is not None and air>=d else 0
        td=1 if yes(row.get('pass_touchdown')) else 0
        complete=1 if yes(row.get('complete_pass')) else 0
    else:
        pid=value(row,'rusher_player_id','rusher_id')
        player=value(row,'rusher_player_name','rusher')
        pos=value(row,'rusher_player_position')
        if not pid and not player:return None
        if value(row,'rush_attempt') and not yes(row.get('rush_attempt')):return None
        air=None;ez=0;td=1 if yes(row.get('rush_touchdown')) else 0;complete=0
    game=value(row,'game_id');play=value(row,'play_id')
    if not game or not play:return None
    return (season,week,game,play,value(row,'posteam'),value(row,'defteam'),kind,
        pid if pid else 'NAME:'+player,player,pos,d,air,complete,td,ez,value(row,'desc'))


def ingest_pbp(c,path,year,max_week=None):
    c.execute('DELETE FROM pbp WHERE season=?',(year,))
    seen=Counter();batch=[];rows=0
    f,r=csv_reader(path)
    with f:
        required={'season','week','game_id','play_id','posteam','defteam','play_type','yardline_100'}
        if not required.issubset(r.fieldnames or []): raise ValueError(f'Invalid PBP CSV {path}: missing {required-set(r.fieldnames or [])}')
        for line in r:
            e=parse_pbp(line,year,max_week)
            if e is None:continue
            batch.append(e);seen[e[6]]+=1
            if len(batch)>=10000:
                c.executemany('INSERT OR REPLACE INTO pbp VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',batch)
                rows+=len(batch);batch.clear()
        if batch:
            c.executemany('INSERT OR REPLACE INTO pbp VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',batch);rows+=len(batch)
    c.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,datetime("now"))',('pbp',year,str(path),PBP_URL.format(year=year),rows))
    c.commit();print(f'Imported PBP {year}: {rows:,} player-event rows {dict(seen)}')
    return rows


def parse_player_stats(row,year,max_week=None):
    if value(row,'season_type') not in ('REG',''):return None
    week=nint(row.get('week'))
    if not week or (max_week is not None and year==2026 and week>max_week):return None
    pid=value(row,'player_id','gsis_id')
    if not pid:return None
    pos=value(row,'position')
    if pos not in ('QB','RB','WR','TE','FB'):return None
    return (year,week,pid,value(row,'player_display_name','player_name'),pos,
       value(row,'recent_team','team'),value(row,'opponent_team','opponent'),
       nint(value(row,'carries','rushing_attempts')),nint(row.get('targets')),
       nint(row.get('receptions')),nint(row.get('rushing_tds')),
       nint(row.get('receiving_tds')),nint(row.get('passing_tds')),'REG')

def ingest_player_stats(c,path,year,max_week=None):
    c.execute('DELETE FROM player_week WHERE season=?',(year,));rows=0;batch=[]
    f,r=csv_reader(path)
    with f:
        if not {'week','player_id'}.issubset(set(r.fieldnames or [])):
            raise ValueError(f'Invalid weekly player stats CSV {path}: {r.fieldnames}')
        for line in r:
            t=parse_player_stats(line,year,max_week)
            if t is not None:batch.append(t)
            if len(batch)>=10000:
                c.executemany('INSERT OR REPLACE INTO player_week VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',batch)
                rows+=len(batch);batch.clear()
        if batch:
            c.executemany('INSERT OR REPLACE INTO player_week VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',batch);rows+=len(batch)
    c.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,datetime("now"))',('stats',year,str(path),STATS_URL.format(year=year),rows))
    c.commit();print(f'Imported weekly player stats {year}: {rows:,} player-week rows')
    return rows


def ingest_rosters(c,path,year,max_week=None):
    """Actual weekly rosters, including zero-stat players; preserve availability status."""
    c.execute('DELETE FROM roster_week WHERE season=?',(year,));rows=0;batch=[]
    f,r=csv_reader(path)
    with f:
        required={'week','gsis_id'}
        if not required.issubset(set(r.fieldnames or [])):
            raise ValueError(f'Invalid weekly rosters CSV {path}, missing {required-set(r.fieldnames or [])}')
        for line in r:
            if value(line,'game_type') not in ('REG',''):continue
            week=nint(line.get('week'))
            if not week or (max_week is not None and year==2026 and week>max_week):continue
            pid=value(line,'gsis_id')
            team=value(line,'team','team_abbr')
            if not pid or not team:continue
            name=value(line,'full_name','player_name','football_name')
            pos=value(line,'position')
            if pos not in ('QB','RB','WR','TE','FB'):continue
            status=value(line,'status','status_description_abbr')
            batch.append((year,week,pid,name,pos,team,status))
            if len(batch)>=10000:
                c.executemany('INSERT OR REPLACE INTO roster_week VALUES (?,?,?,?,?,?,?)',batch)
                rows+=len(batch);batch.clear()
        if batch:
            c.executemany('INSERT OR REPLACE INTO roster_week VALUES (?,?,?,?,?,?,?)',batch);rows+=len(batch)
    c.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,datetime("now"))',('roster',year,str(path),ROSTER_URL.format(year=year),rows))
    c.commit();print(f'Imported weekly offensive rosters {year}: {rows:,} player-week rows')
    return rows


def category(event_type,d,air):
    if d<=2:b='01-02'
    elif d<=5:b='03-05'
    elif d<=10:b='06-10'
    elif d<=20:b='11-20'
    elif d<=40:b='21-40'
    else:b='41-99'
    if event_type=='pass':
        z='EZ_PROXY' if air is not None and air>=d else 'NON_EZ'
        return ('pass',b,z)
    return ('run',b,'CARRY')


def build_rates(c):
    # Independent pre-2026 rates; 2026 Week 1-6 never in estimator training.
    q=c.execute('SELECT event_type,yards_to_goal,air_yards,td FROM pbp WHERE season BETWEEN 2023 AND 2025')
    rates=defaultdict(lambda:[0,0]);family=defaultdict(lambda:[0,0]);total=0
    for t,d,a,td in q:
        group=category(t,d,a)
        rates[group][0]+=td;rates[group][1]+=1
        family[t][0]+=td;family[t][1]+=1;total+=1
    if total<50000:
        raise RuntimeError(f'Insufficient real historical observations ({total:,}). Need all PBP seasons 2023-25; refusing to fabricate xTD.')
    def estimate(t,d,a):
        k=category(t,d,a);s,n=rates[k];fs,fn=family[t]
        p0=fs/fn if fn else 0.03
        # Shrink bucket estimate toward historic event-family baseline.
        return (s+40*p0)/(n+40)
    return estimate,rates,family,total


def dump_csv(path,header,rows):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    with open(path,'w',newline='',encoding='utf-8') as f:
        w=csv.writer(f);w.writerow(header);w.writerows(rows)


def compute(c,outdir,asof_week=7,year=2026):
    out=Path(outdir);out.mkdir(parents=True,exist_ok=True)
    estimate,rates,family,total=build_rates(c)
    # Enforce real imported season through as-of week minus 1, disallow partial 2026 claiming complete league.
    src=c.execute('SELECT rows_imported FROM sources WHERE kind="pbp" AND season=?',(year,)).fetchone()
    ps=c.execute('SELECT rows_imported FROM sources WHERE kind="stats" AND season=?',(year,)).fetchone()
    if not src or not ps:raise RuntimeError(f'Missing {year} verified imports (PBP and weekly stats).')
    roster_ok=c.execute('SELECT rows_imported FROM sources WHERE kind="roster" AND season=?',(year,)).fetchone()
    if not roster_ok or roster_ok[0]<1000:
        raise RuntimeError('Full player registry requires 2026 weekly_rosters CSV (>=1000 offensive roster player-weeks)')
    available_weeks=[x[0] for x in c.execute('SELECT DISTINCT week FROM pbp WHERE season=? AND week<? ORDER BY week',(year,asof_week))]
    if not available_weeks or max(available_weeks)!=asof_week-1:raise RuntimeError(f'Current PBP weeks available {available_weeks}, expected through Week {asof_week-1}.')
    pop=c.execute('SELECT COUNT(DISTINCT offense),COUNT(DISTINCT game_id) FROM pbp WHERE season=? AND week<?',(year,asof_week)).fetchone()
    if pop[0]<30 or pop[1]<70:raise RuntimeError(f'Incomplete NFL play-by-play: {pop[0]} teams and {pop[1]} games (expected roughly 32 teams / 80+ games).')

    # Build position crosswalk directly from real NFLverse weekly player records.
    roster={r[0]:(r[1],r[2]) for r in c.execute('SELECT player_id,player_name,position FROM player_week WHERE season=? AND week<?',(year,asof_week))}
    # Name matching is a fallback for historic rows without gsis ids; never infer names not present.
    by_name={v[0]:v[1] for v in roster.values() if v[0]}
    bucket_rows=[]
    for k,(s,n) in sorted(rates.items()):
        bucket_rows.append([*k,s,n,round(estimate(k[0],2 if k[1]=='01-02' else 4 if k[1]=='03-05' else 8 if k[1]=='06-10' else 15 if k[1]=='11-20' else 30 if k[1]=='21-40' else 65, 99 if k[2]=='EZ_PROXY' else 0),5)])
    dump_csv(out/'historic_xtd_conversion_rates.csv',['event_type','field_position_bucket','airyard_flag','touchdowns','opportunities','smoothed_td_rate'],bucket_rows)

    wk=defaultdict(lambda:Counter());opp_week=defaultdict(lambda:Counter());team_wk=defaultdict(lambda:Counter());
    dfpos=defaultdict(lambda:Counter());games=defaultdict(set);events=[]
    cur=c.execute('''SELECT season,week,game_id,play_id,offense,defense,event_type,player_id,player_name,
         position,yards_to_goal,air_yards,completed,td,ez_proxy,description
         FROM pbp WHERE season=? AND week<? ORDER BY week,game_id,play_id''',(year,asof_week))
    for s,w,g,p,off,df,t,pid,name,pos,d,air,complete,td,ez,desc in cur:
        if not off or not df:continue
        games[df].add(g)
        pos=roster.get(pid,('',pos))[1] or pos or by_name.get(name,'UNKNOWN')
        if pos not in ('QB','RB','WR','TE','FB'):pos='UNKNOWN'
        x=estimate(t,d,air)
        e=Counter();e['attempts']=1;e['td']=td;e['xTD']=x
        e['goal5_carries']=int(t=='run' and d<=5)
        e['goal10_carries']=int(t=='run' and d<=10)
        e['rz_carries']=int(t=='run' and d<=20)
        e['goal5_targets']=int(t=='pass' and d<=5)
        e['goal10_targets']=int(t=='pass' and d<=10)
        e['rz_targets']=int(t=='pass' and d<=20)
        e['ez_target_proxy']=int(t=='pass' and ez==1)
        e['missed_rz_targets']=int(t=='pass' and d<=20 and not td)
        e['missed_goal5_carries']=int(t=='run' and d<=5 and not td)
        for key in (('player',w,off,df,pid,name,pos),):wk[key].update(e)
        dfpos[(w,df,off,pos)].update(e)
        team_wk[(w,off)].update(e)
        events.append([s,w,g,p,off,df,pid,name,pos,t,d,'' if air is None else air,ez,complete,td,round(x,6),round(x-td,6),desc])
    dump_csv(out/'2026_scoring_play_events.csv',
      ['season','week','game_id','play_id','offense','defense','player_id','player','position','play_type','yards_to_goal','air_yards','end_zone_target_PROXY','completed','td','play_xTD','missed_expected_TD','play_description'], events)

    cols=['opportunities','touchdowns','xTD','goal5_carries','goal10_carries','rz_carries','goal5_targets','goal10_targets','rz_targets','ez_target_proxy','missed_rz_targets','missed_goal5_carries']
    def pull(d,k):return round(d[k],4) if k=='xTD' else int(d[k])
    player_rows=[]
    for (kind,w,off,df,pid,name,pos),r in sorted(wk.items(),key=lambda z:(z[0][1],z[0][2],z[0][5])):
        player_rows.append([year,w,off,df,pid,name,pos]+[pull(r,k) for k in cols])
    dump_csv(out/'2026_player_week_scoring_opportunities.csv',['season','week','team','opponent','player_id','player','position']+cols,player_rows)

    defense_rows=[]
    for (w,df,off,pos),r in sorted(dfpos.items()):
        defense_rows.append([year,w,df,off,pos]+[pull(r,k) for k in cols])
    dump_csv(out/'2026_defense_position_allowed_week.csv',['season','week','defense','opponent','position']+cols,defense_rows)

    games_meta=defaultdict(set)
    for w,df,off,pos in dfpos: games_meta[(w,df)].add(off)
    # Defensive prior-six-game counts, not six calendar weeks.
    by_def=defaultdict(lambda:defaultdict(lambda:Counter()))
    by_def_games=defaultdict(lambda:defaultdict(set))
    for (w,df,off,pos),r in dfpos.items():
        by_def[df][(w,pos)].update(r)
        by_def_games[df][w].add(off)
    last6=[]
    for df in sorted(by_def):
        weeks=sorted(by_def_games[df],reverse=True)[:6]
        if not weeks:continue
        for pos in ('QB','RB','WR','TE','FB','UNKNOWN'):
            summ=Counter()
            for w in weeks:summ.update(by_def[df].get((w,pos),Counter()))
            last6.append([df,pos,len(weeks),','.join(map(str,sorted(weeks)))]+[pull(summ,k) for k in cols])
    dump_csv(out/'2026_defense_last6_by_position.csv',['defense','offensive_position','games','weeks']+cols,last6)

    # Full-league player game ledger from official weekly player stats, including ZERO-TD games.
    plays_by_p={(week,pid,team):r for (kind,week,team,opp,pid,name,pos),r in wk.items()}
    player_full=[]
    for w,pid,name,pos,team,opp,car,targets,rec,rt,ct,pt in c.execute('''SELECT week,player_id,player_name,position,team,opponent,carries,targets,receptions,rush_tds,rec_tds,pass_tds
                          FROM player_week WHERE season=? AND week<? ORDER BY week,team,player_name''',(year,asof_week)):
        r=plays_by_p.get((w,pid,team),Counter())
        player_full.append([year,w,team,opp,pid,name,pos,car,targets,rec,rt,ct,pt,rt+ct,int(rt+ct>0),
                            pull(r,'goal5_carries'),pull(r,'goal10_carries'),pull(r,'rz_carries'),
                            pull(r,'goal5_targets'),pull(r,'goal10_targets'),pull(r,'rz_targets'),
                            pull(r,'ez_target_proxy'),pull(r,'xTD')])
    dump_csv(out/'2026_ALL_players_weekly_box_and_opportunity.csv',
      ['season','week','team','opponent','player_id','player','position','rush_attempts','targets','receptions','rushing_tds','receiving_tds','passing_tds','player_anytime_tds','scored_anytime','goal5_carries','goal10_carries','redzone_carries','goal5_targets','goal10_targets','redzone_targets','endzone_target_PROXY','play_based_xTD'],player_full)
    # Include weekly roster players with zero touches; retain statuses, no false eligibility.
    by_stats={(r[1],r[4],r[2]):r for r in player_full}
    roster_rows=[];roster_weeks=set()
    for w,pid,name,pos,team,status in c.execute("""SELECT week,player_id,player_name,position,team,status FROM roster_week
                        WHERE season=? AND week<? ORDER BY week,team,player_name""",(year,asof_week)):
        orig=by_stats.get((w,pid,team));roster_weeks.add(w)
        roster_rows.append([year,w,team,pid,name,pos,status,1 if orig else 0,
                           orig[13] if orig else 0,orig[14] if orig else 0,
                           orig[15] if orig else 0,orig[18] if orig else 0,
                           orig[19] if orig else 0,orig[20] if orig else 0,
                           orig[22] if orig else 0])
    if max(roster_weeks or [0])<asof_week-1 or len(roster_rows)<1000:
        raise RuntimeError(f'Weekly roster release is incomplete ({len(roster_rows)} offensive player-weeks)')
    dump_csv(out/'2026_ALL_offensive_roster_player_weeks.csv',
        ['season','week','team','player_id','player','position','roster_status','has_boxscore_row',
         'anytime_touchdowns','scored_anytime','goal5_carries','rz_carries','goal5_targets','goal10_targets','play_based_xTD'],roster_rows)

    status={'season':year,'prediction_week':asof_week,'train_seasons':[2023,2024,2025],
            'independent_pbp_training_events':total,'imported_2026_pbp_events':len(events),
            'imported_2026_offenses':pop[0],'imported_2026_games':pop[1],
            'current_weeks':available_weeks,'players_weekly_rows':len(player_full),'offensive_roster_player_weeks':len(roster_rows),
            'player_opportunity_rows':len(player_rows),'defense_rows':len(defense_rows),
            'NOT_CHARTED':'End zone target uses air_yards >= yardline_100 proxy; incompletions are NOT labeled drops',
            'DATA_SOURCE':'https://github.com/nflverse/nflverse-data/releases',
            'BACKTEST_WARNING':'Historical opportunity xTD is NOT a calibrated full-game touchdown probability.'}
    (out/'build_status.json').write_text(json.dumps(status,indent=2))
    print('FULL DATABASE GENERATED:',json.dumps(status,indent=2))
    return status


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--data-dir',default='nfl_data')
    ap.add_argument('--out-dir',default='nfl_results')
    ap.add_argument('--db',default='nfl_touchdown.sqlite')
    ap.add_argument('--start-year',type=int,default=2023)
    ap.add_argument('--season',type=int,default=2026)
    ap.add_argument('--predict-week',type=int,default=7)
    ap.add_argument('--offline',action='store_true',help='Only use local CSV files; never download')
    ap.add_argument('--smoke-test',action='store_true',help='Run parser classification tests')
    args=ap.parse_args()
    if args.smoke_test:
        run_smoke_tests();return
    if args.season!=2026:raise ValueError('This release builds a 2026 current-season board (training 2023-25)')
    c=connect(args.db)
    for yr in range(args.start_year,args.season+1):
        for kind in (('pbp','stats','roster') if yr==args.season else ('pbp','stats')):
            try:
                path=Path(args.data_dir)/f'{kind}_{yr}.csv'
                if not args.offline:path=fetch_year(yr,kind,args.data_dir)
                if not path.exists():raise FileNotFoundError(f'Missing {path}')
                ({'pbp':ingest_pbp,'stats':ingest_player_stats,'roster':ingest_rosters}[kind])(c,path,yr,args.predict_week-1)
            except Exception as ex:
                print(f'IMPORT ERROR: {ex}',file=sys.stderr)
                print('No full-league output produced. Source CSV files are required.',file=sys.stderr)
                sys.exit(2)
    try:compute(c,args.out_dir,args.predict_week,args.season)
    except Exception as e:
        print(f'CALCULATION BLOCKED: {e}',file=sys.stderr);sys.exit(3)
    finally:c.close()


def run_smoke_tests():
    base={'season':'2026','week':'4','game_id':'2026_04_ARI_NYG','play_id':'181',
          'season_type':'REG','posteam':'ARI','defteam':'NYG','play_type':'pass',
          'yardline_100':'4','pass_attempt':'1','receiver_player_id':'id-w','receiver_player_name':'Michael Wilson',
          'receiver_player_position':'WR','air_yards':'5','complete_pass':'0','pass_touchdown':'0'}
    e=parse_pbp(base,2026,6)
    assert e is not None and e[14]==1 and e[13]==0
    assert category('pass',4,5)==('pass','03-05','EZ_PROXY')
    assert category('pass',4,2)==('pass','03-05','NON_EZ')
    assert parse_pbp(dict(base,no_play='1'),2026,6) is None
    assert parse_pbp(dict(base,week='7'),2026,6) is None
    rush=dict(base,play_type='run',rusher_player_id='id-r',rusher_player_name='Jahmyr Gibbs',rusher_player_position='RB',rush_attempt='1',rush_touchdown='1')
    assert parse_pbp(rush,2026,6)[13]==1
    assert category('run',4,None)==('run','03-05','CARRY')
    print('PASS: verified parser invariants (scoring, proxy, exclusions, cutoff).')

if __name__=='__main__':main()
