import * as React from "react";
import { dayOf, pulled, useCfb, type CfbGame, type Week } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, Input, LoadingBlock, Segmented } from "@/components/ui";
import { MatchupRow, NotPublished, RatingKey } from "./shared";

type Sort = "kickoff" | "rating";
type Only = "all" | "featured" | "proven";

/** Every game this week with the simulation's spread, total and moneyline picks side by side. */
export default function CfbGames() {
  const week = useCfb<Week>("week.json");
  const [find, setFind] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("kickoff");
  const [only, setOnly] = React.useState<Only>("all");
  if (week.isError) return <NotPublished error={week.error} />;
  if (!week.data) return <Card><LoadingBlock rows={8} className="p-5" /></Card>;
  const all = week.data.games;
  const best = (g: CfbGame) => Math.max(0, ...g.markets.filter((m) => m.market !== "team_total").map((m) => m.score));
  const games = all
    .filter((g) => only === "all" || (only === "featured" ? g.featured : g.markets.some((m) => m.score >= 7 && m.market !== "team_total")))
    .filter((g) => !find || `${g.home} ${g.away} ${g.home_conf ?? ""} ${g.away_conf ?? ""}`.toLowerCase().includes(find.toLowerCase()));
  if (sort === "rating") games.sort((a, b) => best(b) - best(a));
  const groups = new Map<string, CfbGame[]>();
  for (const g of games) {
    const k = sort === "rating" ? "Highest rated first" : dayOf(g.date);
    groups.set(k, [...(groups.get(k) ?? []), g]);
  }
  const books = all.filter((g) => (g.books ?? []).length).length;
  const lastBooks = all.map((g) => g.line.books_at).filter(Boolean).sort().pop();
  return (
    <div className="space-y-5">
      <PageTitle kicker={`College football · Week ${all[0]?.week ?? ""}`} title="All games" />
      <Card>
        <CardHeader title={`${all.length} games`}
          subtitle={<>For each game: the simulation's pick against the spread, on the total points (over/under) and on the moneyline, each rated out of 10.
            Tap a game for every sportsbook's price{books ? ` (last pulled ${pulled(lastBooks)})` : ""}.</>} />
        <RatingKey className="border-b border-line px-4 py-2.5" />
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a team or conference" aria-label="Find a team or conference" className="h-8 max-w-60" />
          <Segmented size="sm" label="Show" value={only} onChange={setOnly} options={[{ value: "all", label: "All" }, { value: "featured", label: "Featured" }, { value: "proven", label: "Has a pick" }]} />
          <Segmented size="sm" label="Sort" value={sort} onChange={setSort} options={[{ value: "kickoff", label: "Kickoff" }, { value: "rating", label: "Top rated" }]} />
        </div>
        {[...groups.entries()].map(([k, gs]) => (
          <div key={k}>
            <div className="label bg-raised/50 px-4 py-1.5">{k}</div>
            <div className="divide-y divide-line/60">{gs.map((g) => <MatchupRow key={g.game_id} g={g} />)}</div>
          </div>
        ))}
        {!games.length && <CardBody className="text-sm text-muted">No games match.</CardBody>}
      </Card>
    </div>
  );
}
