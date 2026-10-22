/* Who is actually expected to play. Roster status alone lists every active player, including backup quarterbacks
   and deep reserves; the site only analyzes the projected starting QB of each team (most pass attempts per game
   among active QBs) and other players with a real role (at least MIN_SNAP of offensive snaps recently). */
export const MIN_SNAP = 0.3;

type RoleRow = { player_id: string; team: string; position: string; eligible: number | boolean; evidence?: Record<string, number | null> };

/** Team -> projected starting QB, from any prop rows that carry pass attempts per game. */
export function starterQbs(rows: Iterable<RoleRow>): Map<string, string> {
  const best = new Map<string, { id: string; att: number }>();
  for (const r of rows) {
    if (r.position !== "QB" || !r.eligible) continue;
    const att = r.evidence?.attempts_pg;
    if (att == null) continue;
    const cur = best.get(r.team);
    if (!cur || att > cur.att) best.set(r.team, { id: r.player_id, att });
  }
  return new Map([...best].map(([t, v]) => [t, v.id]));
}

export function likelyToPlay(p: { player_id: string; team: string; position: string; snap?: number | null }, qbs: Map<string, string>): boolean {
  if (p.position === "QB") return !qbs.has(p.team) || qbs.get(p.team) === p.player_id;
  return p.snap == null || p.snap >= MIN_SNAP;
}
