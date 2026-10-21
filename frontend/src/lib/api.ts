export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

import { staticDownload, staticGet, staticPost, type Params } from "./static";

/** True in the hosted website build (VITE_STATIC=1): read-only, pre-rendered data. */
export const STATIC = !!import.meta.env.VITE_STATIC;

export function qs(params: Params = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = undefined;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? body;
      if (typeof detail === "string") message = detail;
      else if (detail && typeof detail === "object" && "errors" in (detail as object))
        message = ((detail as { errors: string[] }).errors || []).join("; ");
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, detail);
  }
  return res.json() as Promise<T>;
}

export const api = STATIC ? {
  get: <T>(path: string, params?: Params) => staticGet<T>(path, params).catch(toApiError),
  post: <T>(path: string, body: unknown) => staticPost<T>(path, body).catch(toApiError),
  download: (path: string, params?: Params) => staticDownload(path, params),
} : {
  get: <T>(path: string, params?: Params) => fetch(`/api${path}${qs(params)}`).then((r) => handle<T>(r)),
  post: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
      handle<T>(r),
    ),
  download: async (path: string, params?: Params) => { window.location.href = `/api${path}${qs(params)}`; },
};

function toApiError(e: unknown): never {
  if (e instanceof Error && "status" in e) throw new ApiError((e as { status: number }).status, e.message);
  throw e;
}
