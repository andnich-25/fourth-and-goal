/* Shared runner for the Ask pages' optional AI mode (NFL, NBA, college football). The visitor's own key stays in this
   browser and goes only to api.anthropic.com; Claude answers only through tools that run the site's own answer
   functions, so every number it quotes comes from the published data. */
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "@/lib/aiKey";

export type AiTurn = { role: "user" | "assistant"; text: string };
export type AiTools = Parameters<Anthropic["beta"]["messages"]["toolRunner"]>[0]["tools"];

/** How every sport's AI answers "why" questions: a detailed write-up from tool numbers only. */
export const WRITEUP_RULES = `Explaining a pick or a matchup ("why is X favored", "why this pick", "why is it rated 8", "break down this game", "who wins", "case for the upset", "compare X and Y", "how confident are you"):
- Call the explain tools first; their write_up sections hold the model's real inputs (simulation results, ratings, team and player stats, injuries, schemes, line vs model, the backtest record of that tier). Call more tools when the question has several parts.
- Write a detailed, readable write-up with short headed sections, in this order when the data has it: The verdict (who or what the model favors, by how much, and its chance); Why (the 3-6 numbers that drive it, each compared with the other side or the league); The line vs the model (book line and price, model number, the gap); Track record (how that tier or rating band did on unseen games: sample size, win rate, return); What could go wrong (the case against, injuries, small samples, unproven markets); Bottom line (pick or not, and why).
- Quote numbers exactly as the tools give them, with their units and sample sizes. Never round up, estimate, or add a factor, stat or news item the tools did not return. If something is not in the data (weather, a coach's comments, an injury after the last update), say the site does not have it.
- Be honest about what is and is not a pick: only proven tiers or ratings are picks, and say so when a lean is information only.`;

export async function runAi(key: string, system: string, tools: AiTools, question: string, history: AiTurn[], onStatus?: (s: string) => void): Promise<string> {
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    tools,
    messages: [...history.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: question }],
    max_iterations: 10,
  });
  for await (const msg of runner) {
    const used = msg.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name);
    if (used.length) onStatus?.(`Checking ${used.join(", ").replace(/_/g, " ")}…`);
  }
  const final = await runner.done();
  if (final.stop_reason === "refusal") return "The AI declined to answer that one. Try the built-in answer instead.";
  return final.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
}
