#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import * as alerts from "./alerts.js";
import * as watchlists from "./watchlists.js";
import * as market from "./market.js";
import * as screener from "./screener.js";
import * as news from "./news.js";
import * as layouts from "./layouts.js";
import * as ohlcv from "./ohlcv.js";
import * as scripts from "./scripts.js";
import * as account from "./account.js";
import { resetSession } from "./client.js";
import { SCREENER_FIELDS } from "./screener.js";

const server = new Server(
  { name: "tradingview-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Alerts ──────────────────────────────────────────────────────────────
    {
      name: "list_alerts",
      description:
        "List TradingView alerts with optional filters (active state, symbol, resolution, type). " +
        "Mirrors TV's UI filter panel: 'Active only' / 'Inactive only' / 'All', current symbol, " +
        "current time interval, alert type (price/technicals/watchlist). " +
        "Default returns ALL alerts capped at 200 — use filters to narrow large lists.",
      inputSchema: {
        type: "object",
        properties: {
          active: {
            type: "boolean",
            description: "true = active only, false = inactive only, omit = all",
          },
          symbol: {
            type: "string",
            description: "Filter by symbol (e.g. 'BYBIT:BTCUSDT.P'). See symbol_match for fuzzy.",
          },
          symbol_match: {
            type: "string",
            enum: ["exact", "contains"],
            description: "How to compare 'symbol' — exact (default) or substring",
          },
          resolution: {
            type: "string",
            description: "Filter by exact bar resolution: '1','5','15','60','240','D','W',etc.",
          },
          type: {
            type: "string",
            enum: ["price", "technicals", "watchlist", "all"],
            description:
              "TV UI tab classification — price (cross/cross_up/etc.), technicals (Pine indicator alerts), watchlist (alerts on watchlist symbol)",
          },
          name_contains: {
            type: "string",
            description: "Case-insensitive substring match against name + message",
          },
          limit: {
            type: "number",
            description: "Cap result count (default 200; 0 = no cap, use carefully — full list is ~280KB)",
          },
          minimal: {
            type: "boolean",
            description:
              "Return slim record (id+name+symbol+condition+type+resolution+active+last_fired_at) — recommended when listing 50+ alerts",
          },
        },
        required: [],
      },
    },
    {
      name: "get_alert",
      description: "Get details of a specific alert by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Alert ID" } },
        required: ["id"],
      },
    },
    {
      name: "create_alert",
      description:
        "Create a simple price-condition alert (cross, cross_up, cross_down, greater, less). " +
        "For Pine-indicator composite alerts (VD-RALLY, Long Capitulation Setup, etc.) use clone_alert instead.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "EXCHANGE:TICKER e.g. BYBIT:BTCUSDT.P" },
          condition: {
            type: "string",
            enum: ["cross", "cross_up", "cross_down", "greater", "less"],
            description: "Price condition type",
          },
          value: { type: "number", description: "Threshold value" },
          resolution: {
            type: "string",
            description: "Bar resolution: '1', '5', '15', '60', '240', 'D', 'W'. Default '60' (1H).",
          },
          message: { type: "string", description: "Alert message text" },
          name: { type: "string", description: "Optional display name" },
          expiration: {
            type: "string",
            description: "ISO 8601 expiry, e.g. 2026-06-30T23:59:59Z. null/omitted = no expiry.",
          },
          frequency: {
            type: "string",
            enum: ["on_first_fire", "once_per_bar", "once_per_bar_close", "every_time"],
            description: "How often to fire. Default on_first_fire.",
          },
          webhook_url: { type: "string", description: "Optional webhook URL to POST on fire" },
        },
        required: ["symbol", "condition", "value"],
      },
    },
    {
      name: "clone_alert",
      description:
        "Clone an existing alert (Pine indicator composite or simple price) to one or more new " +
        "symbols, reusing its full condition spec (study reference + all Pine inputs, plot_N " +
        "mapping, etc.). Best way to fan out a VD-RALLY composite alarm across a watchlist.",
      inputSchema: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "ID of the source alert to clone" },
          target_symbols: {
            type: "array",
            items: { type: "string" },
            description: "List of EXCHANGE:TICKER symbols to create the cloned alert on",
          },
          message_override: {
            type: "string",
            description: "Replace source message. Leave empty to keep source message verbatim (recommended if it uses {{ticker}} placeholders).",
          },
          resolution_override: {
            type: "string",
            description: "Optional resolution override, e.g. '240' for 4H",
          },
          active: { type: "boolean", description: "Start active (default true)" },
        },
        required: ["source_id", "target_symbols"],
      },
    },
    {
      name: "delete_alert",
      description: "Delete one or more alerts by ID (batch).",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Alert IDs to delete",
          },
        },
        required: ["ids"],
      },
    },
    {
      name: "stop_alert",
      description: "Deactivate (pause) one or more alerts without deleting them.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["ids"],
      },
    },
    {
      name: "restart_alert",
      description: "Re-activate one or more previously stopped alerts.",
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
        },
        required: ["ids"],
      },
    },

    // ── Watchlists ───────────────────────────────────────────────────────────
    {
      name: "list_watchlists",
      description: "List all TradingView watchlists",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_watchlist",
      description: "Get a watchlist and its symbols by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "create_watchlist",
      description: "Create a new watchlist",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "Initial symbols in EXCHANGE:TICKER format",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "rename_watchlist",
      description: "Rename an existing watchlist",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
    },
    {
      name: "add_symbols",
      description: "Add symbols to a watchlist",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          symbols: { type: "array", items: { type: "string" } },
        },
        required: ["id", "symbols"],
      },
    },
    {
      name: "remove_symbols",
      description: "Remove symbols from a watchlist",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          symbols: { type: "array", items: { type: "string" } },
        },
        required: ["id", "symbols"],
      },
    },
    {
      name: "delete_watchlist",
      description: "Delete a watchlist by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },

    // ── Market Data ──────────────────────────────────────────────────────────
    {
      name: "get_quote",
      description: "Get real-time price quote(s) for one or more symbols",
      inputSchema: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "Symbols in EXCHANGE:TICKER format, e.g. ['NASDAQ:AAPL', 'BINANCE:BTCUSDT']",
          },
        },
        required: ["symbols"],
      },
    },
    {
      name: "get_symbol_info",
      description: "Get detailed fundamental and technical info for a symbol",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol in EXCHANGE:TICKER format" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "get_ohlcv",
      description: "Get historical OHLCV (candlestick) data for a symbol",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol in EXCHANGE:TICKER format" },
          resolution: {
            type: "string",
            description: "Timeframe: 1m 3m 5m 15m 30m 45m 1h 2h 3h 4h 1D 1W 1M",
          },
          countback: { type: "number", description: "Number of bars to fetch (default 300)" },
          from: { type: "number", description: "Start time as Unix timestamp (seconds)" },
          to: { type: "number", description: "End time as Unix timestamp (seconds)" },
        },
        required: ["symbol", "resolution"],
      },
    },

    // ── Screener ─────────────────────────────────────────────────────────────
    {
      name: "screen_stocks",
      description: "Screen US stocks using filters (market cap, P/E, RSI, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            type: "array",
            description: "Filter conditions",
            items: {
              type: "object",
              properties: {
                left: { type: "string", description: "Field name, e.g. 'market_cap_basic'" },
                operation: { type: "string", description: "Operator: greater, less, equal, in_range, in" },
                right: { description: "Value or [min, max] for in_range" },
              },
              required: ["left", "operation", "right"],
            },
          },
          columns: { type: "array", items: { type: "string" }, description: "Fields to return" },
          sort: {
            type: "object",
            properties: {
              sortBy: { type: "string" },
              sortOrder: { type: "string", enum: ["asc", "desc"] },
            },
          },
          range: {
            type: "array",
            items: { type: "number" },
            description: "[offset, limit], e.g. [0, 25]",
          },
        },
        required: [],
      },
    },
    {
      name: "screen_crypto",
      description: "Screen crypto assets using filters",
      inputSchema: {
        type: "object",
        properties: {
          filters: { type: "array", items: { type: "object" } },
          columns: { type: "array", items: { type: "string" } },
          sort: { type: "object" },
          range: { type: "array", items: { type: "number" } },
        },
        required: [],
      },
    },
    {
      name: "screen_forex",
      description: "Screen forex pairs using filters",
      inputSchema: {
        type: "object",
        properties: {
          filters: { type: "array", items: { type: "object" } },
          columns: { type: "array", items: { type: "string" } },
          sort: { type: "object" },
          range: { type: "array", items: { type: "number" } },
        },
        required: [],
      },
    },
    {
      name: "get_screener_fields",
      description: "List available screener field names by category",
      inputSchema: { type: "object", properties: {}, required: [] },
    },

    // ── News & Ideas ─────────────────────────────────────────────────────────
    {
      name: "get_news",
      description: "Get latest news headlines for a symbol",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol in EXCHANGE:TICKER format, e.g. NASDAQ:AAPL" },
          count: { type: "number", description: "Number of headlines to return (default 20)" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "search_ideas",
      description: "Search published TradingView chart ideas by symbol or keyword",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Filter by symbol, e.g. NASDAQ:AAPL" },
          query: { type: "string", description: "Keyword filter" },
          sort: { type: "string", enum: ["recent", "trending"], description: "Sort order (default: recent)" },
          page: { type: "number", description: "Page number (default 1)" },
        },
        required: [],
      },
    },
    {
      name: "get_trending_ideas",
      description: "Get trending/popular TradingView chart ideas",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "number", description: "Page number (default 1)" },
        },
        required: [],
      },
    },

    // ── Chart Layouts ────────────────────────────────────────────────────────
    {
      name: "list_layouts",
      description: "List all saved TradingView chart layouts",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_layout",
      description: "Get details of a saved chart layout including its URL",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Layout ID" } },
        required: ["id"],
      },
    },

    // ── Pine Scripts ─────────────────────────────────────────────────────────
    {
      name: "list_scripts",
      description: "List Pine Script indicators and strategies",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["saved", "published", "all"],
            description: "saved = your saved/favorited scripts; published = your published scripts; all = entire public library (default: saved)",
          },
          limit: { type: "number", description: "Max results (default 100)" },
        },
        required: [],
      },
    },
    {
      name: "get_script",
      description: "Get the Pine Script source code for a script by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Script ID (scriptIdPart), e.g. STD;RSI" },
          version: { type: "string", description: "Script version (uses latest if omitted)" },
        },
        required: ["id"],
      },
    },

    // ── Account ──────────────────────────────────────────────────────────────
    {
      name: "get_account",
      description: "Get your TradingView account details",
      inputSchema: { type: "object", properties: {}, required: [] },
    },

    // ── Session ──────────────────────────────────────────────────────────────
    {
      name: "reset_session",
      description: "Clear the cached session and force re-authentication on next request",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

// ─── Tool handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      // ── Alerts ─────────────────────────────────────────────────────────────
      case "list_alerts": {
        const parsed = z.object({
          active: z.boolean().optional(),
          symbol: z.string().optional(),
          symbol_match: z.enum(["exact", "contains"]).optional(),
          resolution: z.string().optional(),
          type: z.enum(["price", "technicals", "watchlist", "all"]).optional(),
          name_contains: z.string().optional(),
          limit: z.number().optional(),
          minimal: z.boolean().optional(),
        }).parse(args ?? {});
        const result = await alerts.listAlerts(parsed);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_alert": {
        const { id } = z.object({ id: z.string() }).parse(args);
        const result = await alerts.getAlert(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "create_alert": {
        const parsed = z.object({
          symbol: z.string(),
          condition: z.enum(["cross", "cross_up", "cross_down", "greater", "less"]),
          value: z.number(),
          resolution: z.string().optional(),
          message: z.string().optional(),
          name: z.string().nullable().optional(),
          expiration: z.string().nullable().optional(),
          frequency: z
            .enum(["on_first_fire", "once_per_bar", "once_per_bar_close", "every_time"])
            .optional(),
          webhook_url: z.string().nullable().optional(),
        }).parse(args);
        const result = await alerts.createAlert({
          ...parsed,
          web_hook: parsed.webhook_url ?? null,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "clone_alert": {
        const parsed = z.object({
          source_id: z.string(),
          target_symbols: z.array(z.string()).min(1),
          message_override: z.string().optional(),
          resolution_override: z.string().optional(),
          active: z.boolean().optional(),
        }).parse(args);
        const result = await alerts.cloneAlert({
          source_id: parsed.source_id,
          target_symbols: parsed.target_symbols,
          messageOverride: parsed.message_override,
          resolutionOverride: parsed.resolution_override,
          active: parsed.active,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "delete_alert": {
        const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(args);
        await alerts.deleteAlerts(ids);
        return { content: [{ type: "text", text: `Deleted ${ids.length} alert(s).` }] };
      }
      case "stop_alert": {
        const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(args);
        await alerts.stopAlerts(ids);
        return { content: [{ type: "text", text: `Stopped ${ids.length} alert(s).` }] };
      }
      case "restart_alert": {
        const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(args);
        await alerts.restartAlerts(ids);
        return { content: [{ type: "text", text: `Restarted ${ids.length} alert(s).` }] };
      }

      // ── Watchlists ──────────────────────────────────────────────────────────
      case "list_watchlists": {
        const result = await watchlists.listWatchlists();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_watchlist": {
        const { id } = z.object({ id: z.string() }).parse(args);
        const result = await watchlists.getWatchlist(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "create_watchlist": {
        const { name: wlName, symbols } = z.object({
          name: z.string(),
          symbols: z.array(z.string()).optional(),
        }).parse(args);
        const result = await watchlists.createWatchlist(wlName, symbols);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "rename_watchlist": {
        const { id, name: wlName } = z.object({ id: z.string(), name: z.string() }).parse(args);
        const result = await watchlists.renameWatchlist(id, wlName);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "add_symbols": {
        const { id, symbols } = z.object({ id: z.string(), symbols: z.array(z.string()) }).parse(args);
        const result = await watchlists.addSymbols(id, symbols);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "remove_symbols": {
        const { id, symbols } = z.object({ id: z.string(), symbols: z.array(z.string()) }).parse(args);
        const result = await watchlists.removeSymbols(id, symbols);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "delete_watchlist": {
        const { id } = z.object({ id: z.string() }).parse(args);
        await watchlists.deleteWatchlist(id);
        return { content: [{ type: "text", text: `Watchlist ${id} deleted.` }] };
      }

      // ── Market Data ─────────────────────────────────────────────────────────
      case "get_quote": {
        const { symbols } = z.object({ symbols: z.array(z.string()) }).parse(args);
        const result = await market.getQuote(symbols);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_symbol_info": {
        const { symbol } = z.object({ symbol: z.string() }).parse(args);
        const result = await market.getSymbolInfo(symbol);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_ohlcv": {
        const { symbol, resolution, countback, from, to } = z.object({
          symbol: z.string(),
          resolution: z.string(),
          countback: z.number().optional(),
          from: z.number().optional(),
          to: z.number().optional(),
        }).parse(args);
        const result = await ohlcv.getOHLCV(symbol, resolution, { countback, from, to });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Screener ────────────────────────────────────────────────────────────
      case "screen_stocks": {
        const opts = z.object({
          filters: z.array(z.object({
            left: z.string(),
            operation: z.string(),
            right: z.unknown(),
          })).optional(),
          columns: z.array(z.string()).optional(),
          sort: z.object({ sortBy: z.string(), sortOrder: z.enum(["asc", "desc"]) }).optional(),
          range: z.tuple([z.number(), z.number()]).optional(),
        }).parse(args);
        const result = await screener.screenStocks(opts as screener.ScreenerOptions);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "screen_crypto": {
        const opts = z.object({
          filters: z.array(z.object({ left: z.string(), operation: z.string(), right: z.unknown() })).optional(),
          columns: z.array(z.string()).optional(),
          sort: z.object({ sortBy: z.string(), sortOrder: z.enum(["asc", "desc"]) }).optional(),
          range: z.tuple([z.number(), z.number()]).optional(),
        }).parse(args);
        const result = await screener.screenCrypto(opts as screener.ScreenerOptions);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "screen_forex": {
        const opts = z.object({
          filters: z.array(z.object({ left: z.string(), operation: z.string(), right: z.unknown() })).optional(),
          columns: z.array(z.string()).optional(),
          sort: z.object({ sortBy: z.string(), sortOrder: z.enum(["asc", "desc"]) }).optional(),
          range: z.tuple([z.number(), z.number()]).optional(),
        }).parse(args);
        const result = await screener.screenForex(opts as screener.ScreenerOptions);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_screener_fields": {
        return { content: [{ type: "text", text: JSON.stringify(SCREENER_FIELDS, null, 2) }] };
      }

      // ── News & Ideas ────────────────────────────────────────────────────────
      case "get_news": {
        const { symbol, count } = z.object({
          symbol: z.string(),
          count: z.number().optional(),
        }).parse(args);
        const result = await news.getNews(symbol, count);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "search_ideas": {
        const opts = z.object({
          symbol: z.string().optional(),
          query: z.string().optional(),
          sort: z.enum(["recent", "trending"]).optional(),
          page: z.number().optional(),
        }).parse(args ?? {});
        const result = await news.searchIdeas(opts);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_trending_ideas": {
        const { page } = z.object({ page: z.number().optional() }).parse(args ?? {});
        const result = await news.getTrendingIdeas(page);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Chart Layouts ───────────────────────────────────────────────────────
      case "list_layouts": {
        const result = await layouts.listLayouts();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_layout": {
        const { id } = z.object({ id: z.string() }).parse(args);
        const result = await layouts.getLayout(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Pine Scripts ────────────────────────────────────────────────────────
      case "list_scripts": {
        const { filter, limit } = z.object({
          filter: z.enum(["saved", "published", "all"]).optional(),
          limit: z.number().optional(),
        }).parse(args ?? {});
        const result = await scripts.listScripts({ filter, limit });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_script": {
        const { id, version } = z.object({
          id: z.string(),
          version: z.string().optional(),
        }).parse(args);
        const result = await scripts.getScript(id, version);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Account ─────────────────────────────────────────────────────────────
      case "get_account": {
        const result = await account.getAccount();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Session ─────────────────────────────────────────────────────────────
      case "reset_session": {
        resetSession();
        return { content: [{ type: "text", text: "Session cleared. Will re-authenticate on next request." }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TradingView MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
