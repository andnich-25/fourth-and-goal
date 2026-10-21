import sqlite3, tempfile, pathlib, csv, itertools, json
import nfl_full_pbp_engine as m

def go():
 with tempfile.TemporaryDirectory() as td:
  c=m.connect(':memory:')
  # 60,000 artificial training events. TEST ONLY; not actual NFL data.
  batch=[]
  for season in (2023,2024,2025):
   for i in range(20000):
    typ='run' if i%2 else 'pass'
    batch.append((season,i%18+1,f'{season}_0{i//100}',str(i),'DET','GB',typ,'TEST_PLAYER','Mock Player','RB',float(i%38+1),12.0 if typ=='pass' else None,0,int(i%19==0),int(typ=='pass' and 12>=i%38+1),'TEST ONLY'))
  c.executemany('INSERT INTO pbp VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',batch)
  c.commit()
  for week in range(1,7):
   for game in range(1,17):
    for side in (0,1):
     idx= (game*2-1+side)%32
     opp=(game*2-1+(1-side))%32
     team=f'T{idx:02d}';df=f'T{opp:02d}'
     for j in range(5):
      typ='run' if j<3 else 'pass'; dist=[2,4,9,6,15][j]
      pid=f'P{idx:02d}';g=f'2026_{week}_{game}'
      c.execute('INSERT INTO pbp VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (2026,week,g,str(side*10+j),team,df,typ,pid,'Synthetic P','RB',dist,12.0 if typ=='pass' else None,0,int(j==0 and week%2==0),int(typ=='pass' and 12>=dist),'TEST ONLY'))
     c.execute('INSERT INTO roster_week VALUES (?,?,?,?,?,?,?)',(2026,week,f'P{idx:02d}','Synthetic P','RB',team,'ACT'))
     for k in range(6):
      c.execute('INSERT INTO roster_week VALUES (?,?,?,?,?,?,?)',(2026,week,f'B{idx:02d}-{k}','Mock Bench','WR',team,'ACT'))
     c.execute('INSERT INTO player_week VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
       (2026,week,f'P{idx:02d}','Synthetic P','RB',team,df,3,2,0,int(week%2==0),0,0,'REG'))
  c.execute('INSERT INTO sources VALUES (?,?,?,?,?,datetime("now"))',('pbp',2026,'SYNTHETIC','',960))
  c.execute('INSERT INTO sources VALUES (?,?,?,?,?,datetime("now"))',('stats',2026,'SYNTHETIC','',192))
  c.execute('INSERT INTO sources VALUES (?,?,?,?,?,datetime("now"))',('roster',2026,'SYNTHETIC','',1344))
  c.commit()
  result=m.compute(c,td,7)
  assert result['players_weekly_rows']==192, result
  assert result['current_weeks']==list(range(1,7)),result
  with open(pathlib.Path(td)/'2026_ALL_players_weekly_box_and_opportunity.csv') as f:
   r=list(csv.DictReader(f))
  assert len(r)==192
  with open(pathlib.Path(td)/'2026_ALL_offensive_roster_player_weeks.csv') as f:
   all_roster=list(csv.DictReader(f))
  assert len(all_roster)==1344
  assert sum(int(q['has_boxscore_row'])==0 for q in all_roster)==1152
  assert all(int(x['goal5_carries'])==2 for x in r[:10]),r[:10]
  assert all(int(x['redzone_targets'])==2 for x in r[:10])
  assert all(float(x['play_based_xTD'])>0 for x in r)
  print('INTEGRATION PASS:',json.dumps({'event_rows':result['imported_2026_pbp_events'],'players':len(r),'opportunity_check':'valid'},indent=2))
if __name__=='__main__':go()
