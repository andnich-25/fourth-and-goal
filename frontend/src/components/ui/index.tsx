import * as React from "react";
import { AlertTriangle, Info, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/format";

/* ---------------------------------------------------------------- Button */
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md" | "icon";
  loading?: boolean;
};
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-xs",
        size === "md" && "h-9 px-4 text-sm",
        size === "icon" && "h-9 w-9",
        variant === "primary" && "bg-accent text-accent-fg hover:bg-accent/90",
        variant === "secondary" && "bg-raised text-fg hover:bg-line",
        variant === "outline" && "border border-line bg-transparent hover:bg-raised",
        variant === "ghost" && "bg-transparent text-muted hover:bg-raised hover:text-fg",
        variant === "danger" && "bg-danger/15 text-danger hover:bg-danger/25",
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

/* ---------------------------------------------------------------- Card */
export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...p} />;
}
export function CardHeader({ title, subtitle, action, icon, className }: {
  title: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5", className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 font-display text-[15px] font-semibold tracking-tight">{icon}{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
export function CardBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 sm:p-5", className)} {...p} />;
}

/* ---------------------------------------------------------------- Badge */
type Tone = "neutral" | "accent" | "warn" | "danger" | "info" | "ok" | "pilot";
export function Badge({ tone = "neutral", className, children, title }: { tone?: Tone; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tone === "neutral" && "border-line bg-raised text-muted",
        tone === "accent" && "border-accent/30 bg-accent/10 text-accent",
        tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
        tone === "danger" && "border-danger/30 bg-danger/10 text-danger",
        tone === "info" && "border-info/30 bg-info/10 text-info",
        tone === "ok" && "border-ok/30 bg-ok/10 text-ok",
        tone === "pilot" && "border-warn/50 bg-warn/15 font-bold uppercase tracking-wider text-warn",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PosBadge({ pos }: { pos: string }) {
  return (
    <span className="inline-flex h-5 min-w-[28px] items-center justify-center rounded border border-line px-1 font-mono text-[10px] font-semibold text-muted">
      {pos}
    </span>
  );
}

/** Team initials badge (logos are not used: licensing unclear). */
export function TeamBadge({ team, size = "sm" }: { team?: string | null; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-label={team ?? "unknown team"}
      className={cn(
        "inline-flex items-center justify-center rounded-md bg-raised font-mono font-bold tracking-tight text-fg ring-1 ring-line",
        size === "sm" && "h-6 w-9 text-[10px]",
        size === "md" && "h-8 w-11 text-xs",
        size === "lg" && "h-12 w-16 text-base",
      )}
    >
      {team ?? "—"}
    </span>
  );
}

/* ---------------------------------------------------------------- Inputs */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input
    ref={ref}
    className={cn("h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm placeholder:text-muted/70 focus-visible:ring-2", className)}
    {...p}
  />
));
Input.displayName = "Input";

export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("h-9 rounded-lg border border-line bg-surface px-2.5 text-sm", className)} {...p}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id: string }) {
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer select-none items-center gap-2 text-sm">
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-accent" : "bg-line")}
      >
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      <span className="text-muted">{label}</span>
    </label>
  );
}

/** Segmented control (radio group semantics, arrow-key friendly via native radios). */
export function Segmented<T extends string | number>({ value, onChange, options, label, size = "md" }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode }[]; label: string; size?: "sm" | "md";
}) {
  const name = React.useId();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <label key={String(o.value)} className="relative">
          <input type="radio" className="peer sr-only" name={name} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span
            className={cn(
              "block cursor-pointer rounded-md font-medium text-muted transition-colors peer-checked:bg-raised peer-checked:text-fg peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
              size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
            )}
          >
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- States */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function LoadingBlock({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-raised text-muted">{icon}</div>}
      <h3 className="font-display text-base font-semibold">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  const offline = /Failed to fetch|NetworkError|ECONNREFUSED|502|504/.test(msg);
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-danger/10 text-danger">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <h3 className="font-display text-base font-semibold">{offline ? "API not reachable" : "Something went wrong"}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted">
        {offline ? (
          <>Start the backend with <code className="font-mono text-fg">cd backend && uvicorn main:app --reload</code>.</>
        ) : (
          msg
        )}
      </p>
      {onRetry && (
        <Button className="mt-4" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", title, children, className }: { tone?: "info" | "warn" | "danger" | "ok"; title?: string; children: React.ReactNode; className?: string }) {
  const Icon = tone === "info" || tone === "ok" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      className={cn(
        "flex gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "info" && "border-info/25 bg-info/5",
        tone === "warn" && "border-warn/30 bg-warn/5",
        tone === "danger" && "border-danger/30 bg-danger/5",
        tone === "ok" && "border-ok/30 bg-ok/5",
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone === "info" && "text-info", tone === "warn" && "text-warn", tone === "danger" && "text-danger", tone === "ok" && "text-ok")} aria-hidden />
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        <div className={cn(title && "mt-0.5", "text-muted [&_strong]:text-fg")}>{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Stat */
export function Stat({ label, value, sub, className, hint }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string; hint?: string }) {
  return (
    <div className={cn("min-w-0", className)} title={hint}>
      <div className="label">{label}</div>
      <div className="num mt-1 font-display text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Table primitives */
export function TableWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("overflow-x-auto", className)}>{children}</div>;
}
export function Th({ className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("whitespace-nowrap border-b border-line px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted", className)} {...p} />;
}
export function Td({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("num whitespace-nowrap border-b border-line/60 px-3 py-2 text-sm", className)} {...p} />;
}
