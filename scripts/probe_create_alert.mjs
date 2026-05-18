// Probe script — open TradingView with saved session, capture network traffic
// while the user manually creates an alert in the visible Chromium window.
//
// Usage:
//   node scripts/probe_create_alert.mjs
//
// Output: ./alert_capture.log (JSON-lines, one per relevant request/response)

import { chromium } from "playwright";
import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync } from "fs";

const SESSION_FILE = process.env.TV_SESSION_FILE
  || "/Users/emina/dev/tradingview-mcp/.tv_session.json";
const LOG_FILE = process.env.LOG_FILE
  || "/Users/emina/dev/tradingview-mcp/alert_capture.log";

// Load saved tough-cookie JSON jar and convert to Playwright cookie format
async function loadCookies() {
  const raw = JSON.parse(await readFile(SESSION_FILE, "utf-8"));
  const cookies = Array.isArray(raw) ? raw : (raw.cookies ?? []);
  return cookies.map((c) => ({
    name: c.key || c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path || "/",
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
    expires: typeof c.expires === "number" ? c.expires : -1,
    sameSite: "Lax",
  }));
}

async function main() {
  if (!existsSync(SESSION_FILE)) {
    console.error(`Session file not found: ${SESSION_FILE}`);
    process.exit(1);
  }

  await writeFile(LOG_FILE, "");
  console.error(`[probe] Logging to ${LOG_FILE}`);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--window-size=1400,900"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies(await loadCookies());

  // Capture ALL requests + responses against tradingview.com domains.
  // We'll focus on pricealerts.tradingview.com but log everything in case
  // alerts go through a different host (e.g. www.tradingview.com/study_alerts).
  context.on("request", async (req) => {
    const url = req.url();
    if (!url.includes("tradingview.com")) return;
    const method = req.method();
    if (method === "GET") return; // ignore GETs to reduce noise
    const isAlertish =
      url.includes("alert") ||
      url.includes("pricealert") ||
      url.includes("study_alert") ||
      url.includes("notif");
    if (!isAlertish && method !== "POST") return;
    const postData = req.postData();
    const headers = req.headers();
    const entry = {
      kind: "request",
      ts: new Date().toISOString(),
      url,
      method,
      headers: { "content-type": headers["content-type"], referer: headers["referer"] },
      postData,
    };
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
    if (isAlertish) {
      console.error(`[probe] >> ${method} ${url}`);
      if (postData) console.error(`         body: ${postData.slice(0, 400)}${postData.length > 400 ? '…' : ''}`);
    }
  });

  context.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("tradingview.com")) return;
    const status = res.status();
    const isAlertish =
      url.includes("alert") || url.includes("pricealert") || url.includes("study_alert");
    if (!isAlertish) return;
    let body = null;
    try {
      const text = await res.text();
      body = text.length > 2000 ? text.slice(0, 2000) + "…[truncated]" : text;
    } catch { /* binary or stream */ }
    const entry = {
      kind: "response",
      ts: new Date().toISOString(),
      url,
      status,
      body,
    };
    await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
    console.error(`[probe] << ${status} ${url}`);
  });

  const page = await context.newPage();
  console.error("[probe] Opening tradingview.com chart...");
  await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });

  console.error("");
  console.error("============================================================");
  console.error("  Chromium açık. Şimdi sırayla şunları yap:");
  console.error("");
  console.error("  1. Chart'a istediğin coin'i yükle (örn. BYBIT:NAORISUSDT.P)");
  console.error("  2. Üstte Alarm (saat ikonu) → Add alert (Alt+A)");
  console.error("  3. İLK ALARM: 'Price' condition'la basit bir alarm");
  console.error("     (örn. BTCUSDT.P > 80000, message='test cross') → Create");
  console.error("  4. İKİNCİ ALARM: Volatility Direction göstergesi yüklü grafikte");
  console.error("     Condition='Screener: Volatility Direction v2' indikatörü");
  console.error("     → 'Long Capitulation Setup' veya benzeri composite şart");
  console.error("     → mesaj boş bırakabilirsin → Create");
  console.error("  5. Bittiğinde browser'ı kapat (X), ben durduracağım.");
  console.error("");
  console.error("============================================================");
  console.error("");

  // Wait for browser to close
  await new Promise((resolve) => {
    browser.on("disconnected", resolve);
  });

  console.error("[probe] Browser closed. Capture saved to:", LOG_FILE);
}

main().catch((e) => { console.error(e); process.exit(1); });
