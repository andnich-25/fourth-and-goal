import * as React from "react";
import { num } from "@/lib/format";
import { useCfb, type Teams } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Card, CardHeader, Input, LoadingBlock, TableWrap, Td, Th } from "@/components/ui";
import { NotPublished } from "./shared";

export default function CfbTeams() {
  const t = useCfb<Teams>("teams.json");
  const [q, setQ] = React.useState("");
  if (t.isError) return <NotPublished error={t.error} />;
  const rows = (t.data?.teams ?? []).filter((x) => !q || `${x.team} ${x.conference ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-5">
      <PageTitle kicker={`College football ${t.data?.season ?? ""}`} title="Teams" />
      <Card>
        <CardHeader title="Power ratings" subtitle="Expected points for and against an average FBS team on a neutral field, opponent-adjusted. ATS and O/U are this season against the closing line." />
        <div className="border-b border-line p-3"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a team or conference" aria-label="Find a team" /></div>
        {!t.data ? <LoadingBlock rows={8} className="p-5" /> : (
          <TableWrap>
            <table className="w-full text-sm">
              <thead><tr>
                <Th>#</Th><Th>Team</Th><Th className="text-right">W-L</Th><Th className="text-right">ATS</Th><Th className="text-right">O/U</Th>
                <Th className="text-right">Net</Th><Th className="text-right">Pts for</Th><Th className="text-right">Pts against</Th>
                <Th className="text-right">Yds/play</Th><Th className="text-right">Allowed</Th><Th className="text-right">Plays</Th>
              </tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.team_id} className="border-t border-line/60">
                    <Td className="tabular-nums text-muted">{x.power_rank}</Td>
                    <Td><div className="font-medium">{x.team}</div><div className="text-xs text-muted">{x.conference}</div></Td>
                    <Td className="text-right tabular-nums">{x.w}-{x.l}</Td>
                    <Td className="text-right tabular-nums">{x.ats_w}-{x.ats_l}{x.ats_p ? `-${x.ats_p}` : ""}</Td>
                    <Td className="text-right tabular-nums">{x.over}-{x.under}</Td>
                    <Td className="text-right font-semibold tabular-nums">{x.net != null ? `${x.net > 0 ? "+" : ""}${num(x.net, 1)}` : "–"}</Td>
                    <Td className="text-right tabular-nums">{num(x.pts_for, 1)}</Td>
                    <Td className="text-right tabular-nums">{num(x.pts_against, 1)}</Td>
                    <Td className="text-right tabular-nums">{num(x.ypp_for, 2)}</Td>
                    <Td className="text-right tabular-nums">{num(x.ypp_against, 2)}</Td>
                    <Td className="text-right tabular-nums">{num(x.plays, 0)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
