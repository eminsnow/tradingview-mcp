export interface Alert {
  id: string;
  name: string;
  symbol: string;
  /** Plain "EXCHANGE:TICKER" extracted from TV's extended-symbol envelope */
  symbol_plain?: string;
  condition: string;
  /** Matches TV's UI tabs in the alerts panel */
  type?: "price" | "technicals" | "watchlist";
  resolution?: string;
  price?: number;
  active: boolean;
  expiration?: string;
  message?: string;
  created_at?: string;
  last_fired_at?: string;
}

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface SessionData {
  cookies: SerializedCookie[];
  savedAt: string;
}

export interface SerializedCookie {
  key: string;
  value: string;
  domain: string;
  path: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

// Market data
export interface Quote {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  change_abs: number;
  market_cap?: number;
  description?: string;
  exchange?: string;
  type?: string;
}

export interface OHLCVBar {
  time: number;   // Unix timestamp (seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Screener
export interface ScreenerResult {
  s: string;      // symbol
  d: unknown[];   // column values in requested order
}

export interface ScreenerResponse {
  data: ScreenerResult[];
  totalCount: number;
}

// News & Ideas
export interface NewsItem {
  id: string;
  title: string;
  published: number;
  source: string;
  urgency: number;
  link: string;
  relatedSymbols?: string[];
}

export interface Idea {
  id: string;
  title: string;
  author: string;
  symbol: string;
  published: number;
  views: number;
  likes: number;
  url: string;
}

// Economic calendar
export interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  date: string;
  impact: "low" | "medium" | "high";
  actual?: string;
  forecast?: string;
  previous?: string;
}

// Chart layouts
export interface Layout {
  id: string;
  name: string;
  symbol?: string;
  resolution?: string;
  created_at?: string;
  modified_at?: string;
}

// Drawings
export interface Drawing {
  id: string;
  type: string;
  points?: unknown[];
  options?: Record<string, unknown>;
}

// Pine scripts
export interface PineScript {
  id: string;
  name: string;
  version?: string;
  modified_at?: string;
}

// Account
export interface UserAccount {
  id: number;
  username: string;
  email?: string;
  plan?: string;
  avatar?: string;
}
