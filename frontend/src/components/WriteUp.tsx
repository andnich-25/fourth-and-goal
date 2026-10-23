import type { Section } from "@/lib/writeup";

/** A detailed write-up: one heading per section, each with its sentences. */
export function WriteUp({ sections }: { sections: Section[] }) {
  if (!sections.length) return null;
  return (
    <div className="divide-y divide-line/60 border-b border-line">
      {sections.map((s) => (
        <section key={s.title} className="px-4 py-3 sm:px-5">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{s.title}</h3>
          <ul className="space-y-1 text-sm leading-relaxed">{s.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}
