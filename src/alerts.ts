import { CookieJar } from "tough-cookie";
import { getSession } from "./auth.js";
import { fetchGet } from "./client.js";
import type { Alert } from "./types.js";

const ALERTS_BASE = "https://pricealerts.tradingview.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// ─── Types matching the TradingView Alerts REST API ──────────────────────────

interface AlertSeriesValue {
  type: "value";
  value: number;
}
interface AlertSeriesBarset {
  type: "barset";
}
interface AlertSeriesStudy {
  type: "study";
  study: string;            // e.g. "Script@tv-scripting-101"
  offsets_by_plot?: Record<string, number>;
  inputs?: Record<string, unknown>;
  pine_id?: string;         // e.g. "USER;dc5b4797f2424a64bdc7f0e31fa6803d"
  pine_version?: string;    // e.g. "48.0"
}
type AlertSeries = AlertSeriesValue | AlertSeriesBarset | AlertSeriesStudy;

interface AlertCondition {
  type: string;             // "cross" | "cross_up" | "cross_down" | "greater" | "less" | "alert_cond" | "pine_alert" | "moving_up_percents" | ...
  frequency: string;        // "on_first_fire" | "once_per_bar" | "once_per_bar_close" | "every_time"
  alert_cond_id?: string;   // e.g. "plot_45" — only for alert_cond / pine_alert
  series?: AlertSeries[];
  cross_interval?: boolean;
  resolution?: string;
}

interface AlertRecord {
  alert_id?: number;
  id?: string;              // create_alert response uses this
  name: string | null;
  message: string;
  symbol: string;
  resolution: string;
  condition?: AlertCondition;
  conditions?: AlertCondition[];
  expiration: string | null;
  active: boolean;
  create_time?: string;
  last_fire_time?: string | null;
  popup?: boolean;
  email?: boolean;
  mobile_push?: boolean;
  sound_file?: string | null;
  sound_duration?: number;
  sms_over_email?: boolean;
  web_hook?: string | null;
  auto_deactivate?: boolean;
}

interface AlertsListResponse {
  s: string;
  r: AlertRecord[] | null;
  errmsg?: string;
}
interface AlertWriteResponse {
  s: string;
  id?: string;
  r?: AlertRecord;
  errmsg?: string;
}
interface AlertBatchResponse {
  s: string;
  errmsg?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _jar: CookieJar | null = null;
async function getJar(): Promise<CookieJar> {
  if (!_jar) _jar = await getSession();
  return _jar;
}
async function cookieHeader(jar: CookieJar): Promise<string> {
  const cookies = await jar.getCookies("https://www.tradingview.com");
  return cookies.map((c) => `${c.key}=${c.value}`).join("; ");
}

/** Alerts endpoints expect text/plain bodies even though they're JSON. */
async function alertsPost<T>(path: string, body: unknown): Promise<T> {
  const jar = await getJar();
  const url = `${ALERTS_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      "Content-Type": "text/plain;charset=UTF-8",
      Referer: "https://www.tradingview.com/",
      Cookie: await cookieHeader(jar),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { s: string; errmsg?: string };
  if (data.s !== "ok") throw new Error(data.errmsg ?? `POST ${path} returned s=${data.s}`);
  return data as T;
}

/**
 * Build TradingView's extended-symbol JSON envelope.
 * Heuristic:
 *  - Perpetual futures (e.g. "BYBIT:BTCUSDT.P", "BINANCE:NAORISUSDT.P"):
 *      session=regular, currency-id=XTVCUSDT
 *  - Spot / index / forex: adjustment=splits, currency-id=USD
 * Override by passing `extendedSymbol` directly to the create function.
 */
function buildExtendedSymbol(symbol: string): string {
  const isPerp = symbol.includes(".P") || symbol.endsWith("PERP");
  const envelope = isPerp
    ? { "currency-id": "XTVCUSDT", session: "regular", symbol }
    : { symbol, adjustment: "splits", "currency-id": "USD" };
  return `=${JSON.stringify(envelope)}`;
}

/**
 * Extract plain "EXCHANGE:TICKER" from TV's extended-symbol envelope.
 * Examples:
 *   `={"symbol":"BYBIT:BTCUSDT.P",...}` → "BYBIT:BTCUSDT.P"
 *   `WATCHLIST:202865833`                → "WATCHLIST:202865833"
 *   `BINANCE:ETHUSDT`                    → "BINANCE:ETHUSDT"
 */
function parseSymbol(raw: string): string {
  if (!raw) return raw;
  if (raw.startsWith("=")) {
    try {
      const obj = JSON.parse(raw.slice(1));
      if (obj && typeof obj.symbol === "string") return obj.symbol;
    } catch {
      /* fall through */
    }
  }
  return raw;
}

/** Classify alert by TradingView's UI taxonomy (price / technicals / watchlist). */
function classifyType(r: AlertRecord): "price" | "technicals" | "watchlist" {
  const cond = r.condition ?? r.conditions?.[0];
  const sym = r.symbol ?? "";
  if (sym.startsWith("WATCHLIST:")) return "watchlist";
  const t = cond?.type ?? "";
  // Pine alerts + study-condition alerts → technicals.
  if (t === "alert_cond" || t === "pine_alert") return "technicals";
  // Some price-conditions reference an indicator series via `study` — those are
  // "technicals" in TV's UI even though the condition is "cross"/"less"/etc.
  if (cond?.series?.some((s) => s.type === "study")) return "technicals";
  // Percent-change and channel-exit conditions are computed via TV's indicator
  // pipeline (rolling percent-change window / parallel-channel detector), so
  // TV's UI groups them under Technicals even though they have no user-script.
  if (t === "moving_up_percents" || t === "moving_down_percents" || t === "exit_channel") {
    return "technicals";
  }
  return "price";
}

function mapRecord(r: AlertRecord): Alert {
  const cond = r.condition ?? r.conditions?.[0];
  const valueSeries = cond?.series?.find((s) => s.type === "value") as
    | AlertSeriesValue
    | undefined;
  return {
    id: String(r.alert_id ?? r.id ?? ""),
    name: r.name ?? r.message,
    symbol: r.symbol,
    symbol_plain: parseSymbol(r.symbol),
    condition: cond?.type ?? "unknown",
    type: classifyType(r),
    resolution: r.resolution,
    price: valueSeries?.value,
    active: r.active,
    expiration: r.expiration ?? undefined,
    message: r.message,
    created_at: r.create_time ?? "",
    last_fired_at: r.last_fire_time ?? undefined,
  };
}

// ─── Read operations ─────────────────────────────────────────────────────────

async function listAlertsRaw(): Promise<AlertRecord[]> {
  const data = await fetchGet<AlertsListResponse>(`${ALERTS_BASE}/list_alerts`);
  if (data.s !== "ok") throw new Error(data.errmsg ?? "Failed to list alerts");
  return data.r ?? [];
}

export interface ListAlertsFilter {
  /** true = active only, false = inactive only, undefined = all */
  active?: boolean;
  /** Match a specific plain symbol (e.g. "BYBIT:BTCUSDT.P") OR a substring */
  symbol?: string;
  /** Whether `symbol` is an exact match (default) or a substring (`contains`) */
  symbol_match?: "exact" | "contains";
  /** Match alert resolution exactly: "1", "5", "60", "240", "D", "W", ... */
  resolution?: string;
  /** Filter by TV UI classification */
  type?: "price" | "technicals" | "watchlist" | "all";
  /** Case-insensitive substring match against name + message */
  name_contains?: string;
  /** Cap result count (default 200; use 0 / negative for no cap) */
  limit?: number;
  /** Return only id+name+symbol+condition+active (no message/timestamps) — useful for large lists */
  minimal?: boolean;
}

export async function listAlerts(filter: ListAlertsFilter = {}): Promise<Alert[] | Partial<Alert>[]> {
  let alerts = (await listAlertsRaw()).map(mapRecord);

  if (filter.active !== undefined) {
    alerts = alerts.filter((a) => a.active === filter.active);
  }
  if (filter.symbol) {
    const needle = filter.symbol;
    const mode = filter.symbol_match ?? "exact";
    alerts = alerts.filter((a) => {
      const sp = a.symbol_plain ?? "";
      const sr = a.symbol ?? "";
      if (mode === "contains") {
        return sp.toLowerCase().includes(needle.toLowerCase())
          || sr.toLowerCase().includes(needle.toLowerCase());
      }
      return sp === needle || sr === needle;
    });
  }
  if (filter.resolution) {
    alerts = alerts.filter((a) => a.resolution === filter.resolution);
  }
  if (filter.type && filter.type !== "all") {
    alerts = alerts.filter((a) => a.type === filter.type);
  }
  if (filter.name_contains) {
    const needle = filter.name_contains.toLowerCase();
    alerts = alerts.filter(
      (a) =>
        (a.name ?? "").toLowerCase().includes(needle) ||
        (a.message ?? "").toLowerCase().includes(needle)
    );
  }

  const limit = filter.limit ?? 200;
  if (limit > 0 && alerts.length > limit) {
    alerts = alerts.slice(0, limit);
  }

  if (filter.minimal) {
    return alerts.map((a) => ({
      id: a.id,
      name: a.name,
      symbol_plain: a.symbol_plain,
      condition: a.condition,
      type: a.type,
      resolution: a.resolution,
      active: a.active,
      last_fired_at: a.last_fired_at,
    }));
  }

  return alerts;
}

export async function getAlert(id: string): Promise<Alert> {
  const records = await listAlertsRaw();
  const record = records.find((r) => String(r.alert_id ?? r.id ?? "") === id);
  if (!record) throw new Error(`Alert ${id} not found`);
  return mapRecord(record);
}

/**
 * Get the full raw record for one alert — needed for cloning, includes the full
 * `conditions` array (with study reference for Pine alerts, all inputs, etc.).
 */
export async function getAlertRaw(id: string): Promise<AlertRecord> {
  const records = await listAlertsRaw();
  const r = records.find((x) => String(x.alert_id ?? x.id ?? "") === id);
  if (!r) throw new Error(`Alert ${id} not found`);
  return r;
}

// ─── Create ──────────────────────────────────────────────────────────────────

export type SimpleConditionType = "cross" | "cross_up" | "cross_down" | "greater" | "less";

/** One trigger within a multi-condition alert. All conditions must be true for the alert to fire (AND semantics, mirrors TV UI's "Add condition" button). */
export interface SimpleCondition {
  condition: SimpleConditionType;
  value: number;
  /**
   * Sent to TV as the condition's `resolution` field, but in practice TV
   * normalizes all conditions of a price-cross-style alert to 1m polling
   * (`cross_interval: true`) regardless of what we pass. Kept for forward
   * compatibility but typically omitted — the alert-level resolution rules.
   */
  resolution?: string;
  /** Override frequency for this condition only. Defaults to the alert frequency. */
  frequency?: "on_first_fire" | "once_per_bar" | "once_per_bar_close" | "every_time";
}

export interface CreateAlertParams {
  symbol: string;                         // e.g. "BYBIT:BTCUSDT.P"
  /** Single-condition shorthand (mutually exclusive with `conditions`). */
  condition?: SimpleConditionType;
  value?: number;
  /** Multi-condition (AND) form. Each entry becomes a separate trigger; the alert fires only when all are simultaneously true. Mirrors TV UI's "Add condition" button. */
  conditions?: SimpleCondition[];
  resolution?: string;                    // "1", "5", "15", "60", "240", "D", "W" — default "60"
  message?: string;
  name?: string | null;
  expiration?: string | null;             // ISO 8601, e.g. "2026-06-30T23:59:59Z"
  frequency?: "on_first_fire" | "once_per_bar" | "once_per_bar_close" | "every_time";
  active?: boolean;
  notifications?: {
    popup?: boolean;
    email?: boolean;
    mobile_push?: boolean;
    sms_over_email?: boolean;
    sound?: boolean;
  };
  web_hook?: string | null;               // webhook URL
  extendedSymbol?: string;                // override envelope (advanced)
}

export async function createAlert(p: CreateAlertParams): Promise<Alert> {
  const resolution = p.resolution ?? "60";
  const symbolExt = p.extendedSymbol ?? buildExtendedSymbol(p.symbol);
  const defaultFreq = p.frequency ?? "on_first_fire";

  // Normalize to a unified list. Accept either:
  //   { condition, value }                — single trigger (back-compat)
  //   { conditions: [{condition, value}, …] } — multi-trigger (AND)
  let triggers: SimpleCondition[];
  if (p.conditions && p.conditions.length > 0) {
    if (p.condition !== undefined || p.value !== undefined) {
      throw new Error(
        "create_alert: pass either { condition, value } OR { conditions: [...] }, not both"
      );
    }
    triggers = p.conditions;
  } else {
    if (p.condition === undefined || p.value === undefined) {
      throw new Error(
        "create_alert: must provide either { condition, value } or { conditions: [...] }"
      );
    }
    triggers = [{ condition: p.condition, value: p.value }];
  }

  const conditionPayload = triggers.map((t) => ({
    type: t.condition,
    frequency: t.frequency ?? defaultFreq,
    series: [
      { type: "barset" },
      { type: "value", value: t.value },
    ],
    resolution: t.resolution ?? resolution,
  }));

  const defaultMessage = triggers
    .map((t) => `${t.condition} ${t.value}`)
    .join(" AND ");

  const payload = {
    payload: {
      symbol: symbolExt,
      resolution,
      message: p.message ?? `${p.symbol} ${defaultMessage}`,
      sound_file: p.notifications?.sound === false ? null : "alert/fired",
      sound_duration: 0,
      popup: p.notifications?.popup ?? true,
      expiration: p.expiration ?? null,
      auto_deactivate: true,
      email: p.notifications?.email ?? true,
      sms_over_email: p.notifications?.sms_over_email ?? false,
      mobile_push: p.notifications?.mobile_push ?? true,
      web_hook: p.web_hook ?? null,
      name: p.name ?? null,
      conditions: conditionPayload,
      active: p.active ?? true,
      ignore_warnings: true,
    },
  };
  const data = await alertsPost<AlertWriteResponse>("/create_alert", payload);
  if (!data.r) throw new Error("create_alert returned ok but no record");
  return mapRecord({ ...data.r, alert_id: data.r.alert_id ?? Number(data.id) });
}

/**
 * Create a Pine-indicator (alert_cond) alert. The hard fields (study spec,
 * inputs, plot offsets, alert_cond_id) must be provided — usually copied from
 * an existing alert via `get_alert_raw`. Most users should use `clone_alert`
 * instead, which copies all of that from a source alert automatically.
 */
export interface CreatePineAlertParams {
  symbol: string;
  resolution: string;
  message: string;
  name?: string | null;
  expiration?: string | null;
  active?: boolean;
  notifications?: CreateAlertParams["notifications"];
  web_hook?: string | null;
  /** "plot_NN" — index of the alertcondition() in the Pine script */
  alert_cond_id: string;
  /** Pine script identity (from list_scripts → id, e.g. "USER;abc...") */
  pine_id: string;
  /** Pine script version (from list_scripts → version, e.g. "48.0") */
  pine_version: string;
  /** All input values, keyed "in_0", "in_1", … plus optional pineFeatures */
  inputs: Record<string, unknown>;
  /** Defaults to {plot_0: 0, plot_1: 0, …} for plot indices 0..40 */
  offsets_by_plot?: Record<string, number>;
  extendedSymbol?: string;
}

export async function createPineAlert(p: CreatePineAlertParams): Promise<Alert> {
  const symbolExt = p.extendedSymbol ?? buildExtendedSymbol(p.symbol);
  const offsets = p.offsets_by_plot ?? Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`plot_${i}`, 0])
  );
  const payload = {
    payload: {
      symbol: symbolExt,
      resolution: p.resolution,
      message: p.message,
      sound_file: "alert/fired",
      sound_duration: 0,
      popup: p.notifications?.popup ?? true,
      expiration: p.expiration ?? null,
      auto_deactivate: true,
      email: p.notifications?.email ?? true,
      sms_over_email: p.notifications?.sms_over_email ?? false,
      mobile_push: p.notifications?.mobile_push ?? true,
      web_hook: p.web_hook ?? null,
      name: p.name ?? null,
      conditions: [
        {
          type: "alert_cond",
          frequency: "on_first_fire",
          alert_cond_id: p.alert_cond_id,
          series: [
            {
              type: "study",
              study: "Script@tv-scripting-101",
              offsets_by_plot: offsets,
              inputs: p.inputs,
              pine_id: p.pine_id,
              pine_version: p.pine_version,
            },
          ],
          resolution: p.resolution,
        },
      ],
      active: p.active ?? true,
      ignore_warnings: true,
    },
  };
  const data = await alertsPost<AlertWriteResponse>("/create_alert", payload);
  if (!data.r) throw new Error("create_alert returned ok but no record");
  return mapRecord({ ...data.r, alert_id: data.r.alert_id ?? Number(data.id) });
}

/**
 * Clone an existing alert to one or more new symbols, copying its full
 * condition spec (including Pine study reference + all inputs for alert_cond).
 *
 * The source alert's symbol, resolution, message, web_hook, and notification
 * settings are reused; only the symbol is replaced. Pass `messageOverride` to
 * change the message (e.g. when the message embeds the symbol via "{{ticker}}"
 * it doesn't need changing, but for plain-text messages you may want to).
 */
export interface CloneAlertParams {
  source_id: string;
  target_symbols: string[];
  messageOverride?: string;
  resolutionOverride?: string;
  active?: boolean;
}

export async function cloneAlert(p: CloneAlertParams): Promise<Alert[]> {
  const source = await getAlertRaw(p.source_id);
  if (!source.conditions || source.conditions.length === 0) {
    throw new Error(`Source alert ${p.source_id} has no conditions to clone`);
  }
  const created: Alert[] = [];
  for (const sym of p.target_symbols) {
    const symbolExt = buildExtendedSymbol(sym);
    const payload = {
      payload: {
        symbol: symbolExt,
        resolution: p.resolutionOverride ?? source.resolution,
        message: p.messageOverride ?? source.message,
        sound_file: source.sound_file ?? "alert/fired",
        sound_duration: source.sound_duration ?? 0,
        popup: source.popup ?? true,
        expiration: source.expiration ?? null,
        auto_deactivate: source.auto_deactivate ?? true,
        email: source.email ?? true,
        sms_over_email: source.sms_over_email ?? false,
        mobile_push: source.mobile_push ?? true,
        web_hook: source.web_hook ?? null,
        name: source.name ?? null,
        conditions: source.conditions.map((c) => ({
          ...c,
          resolution: p.resolutionOverride ?? c.resolution,
        })),
        active: p.active ?? true,
        ignore_warnings: true,
      },
    };
    const data = await alertsPost<AlertWriteResponse>("/create_alert", payload);
    if (!data.r) throw new Error(`Clone to ${sym} returned ok but no record`);
    created.push(mapRecord({ ...data.r, alert_id: data.r.alert_id ?? Number(data.id) }));
  }
  return created;
}

// ─── Bulk lifecycle ──────────────────────────────────────────────────────────

export async function deleteAlerts(ids: string[]): Promise<void> {
  await alertsPost<AlertBatchResponse>("/delete_alerts", {
    payload: { alert_ids: ids.map((s) => Number(s)) },
  });
}

export async function stopAlerts(ids: string[]): Promise<void> {
  await alertsPost<AlertBatchResponse>("/stop_alerts", {
    payload: { alert_ids: ids.map((s) => Number(s)) },
  });
}

export async function restartAlerts(ids: string[]): Promise<void> {
  await alertsPost<AlertBatchResponse>("/restart_alerts", {
    payload: { alert_ids: ids.map((s) => Number(s)) },
  });
}
