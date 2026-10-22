/* The visitor's own Anthropic API key for the Ask page's optional AI mode: kept only in this browser. */
export const KEY_STORE = "fg-anthropic-key";
export const MODEL = "claude-opus-5-5";
export const loadKey = () => { try { return localStorage.getItem(KEY_STORE) ?? ""; } catch { return ""; } };
export const saveKey = (k: string) => { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { /* storage unavailable */ } };
