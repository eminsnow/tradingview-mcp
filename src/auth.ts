import { existsSync } from "fs";
import { chromium, type BrowserContext } from "playwright";
import { CookieJar } from "tough-cookie";
import { saveSession, loadSession } from "./session.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
// Detect Docker via the filesystem marker — more reliable than an env var
// which can leak into the host shell from docker run commands.
const isDocker = existsSync("/.dockerenv") || process.env.DOCKER === "1";

// Sentinel — errors that should not trigger the Playwright fallback
class NoFallbackError extends Error {}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getSession(): Promise<CookieJar> {
  const existing = await loadSession();
  if (existing) {
    console.error("[auth] Loaded existing session from disk");
    return existing;
  }

  if (isDocker) {
    const sessionFile = process.env.TV_SESSION_FILE ?? ".tv_session.json";
    throw new Error(
      `No valid session found. Run the login container first:\n\n` +
      `  # Headless (email/password accounts):\n` +
      `  docker run --rm -it \\\n` +
      `    -v tradingview-mcp-session:/data \\\n` +
      `    -e TV_USERNAME=you@example.com \\\n` +
      `    -e TV_PASSWORD=yourpassword \\\n` +
      `    tradingview-mcp:login\n\n` +
      `  # Interactive (Google/Apple accounts) — run on host, not in Docker:\n` +
      `  node dist/login.js --interactive\n\n` +
      `Then mount the session volume: -v tradingview-mcp-session:/data\n` +
      `Session file expected at: ${sessionFile}`
    );
  }

  console.error("[auth] No valid session found, logging in...");
  return await login();
}

/**
 * Headless login — tries the direct API first, falls back to Playwright.
 * Suitable for email/password accounts. Google/Apple accounts will get a
 * clear error directing them to use --interactive instead.
 */
export async function login(): Promise<CookieJar> {
  const username = process.env.TV_USERNAME;
  const password = process.env.TV_PASSWORD;

  if (!username || !password) {
    throw new Error("TV_USERNAME and TV_PASSWORD environment variables are required");
  }

  console.error("[auth] Attempting direct API login...");
  try {
    return await loginDirect(username, password);
  } catch (err) {
    if (err instanceof NoFallbackError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[auth] Direct login failed (${msg}), falling back to headless browser...`);
    return await loginHeadless(username, password);
  }
}

/**
 * Interactive login — opens a visible browser window and waits for the user
 * to complete the login flow manually. Supports any method: email, Google,
 * Apple, SSO, MFA, etc. Cannot run inside Docker (no display).
 */
export async function loginInteractive(): Promise<CookieJar> {
  if (isDocker) {
    throw new Error(
      "Interactive login requires a display and cannot run inside Docker.\n" +
      "Run this on your host machine instead:\n\n" +
      "  node dist/login.js --interactive\n\n" +
      "The session file will be saved locally. Copy it to the Docker volume:\n" +
      "  docker run --rm \\\n" +
      "    -v tradingview-mcp-session:/data \\\n" +
      "    -v \"$(pwd)/.tv_session.json\":/src/.tv_session.json \\\n" +
      "    alpine cp /src/.tv_session.json /data/.tv_session.json"
    );
  }

  console.error("[auth] Opening browser for interactive login...");
  console.error("[auth] Sign in with any method (email, Google, Apple, etc.).");
  console.error("[auth] The browser will close automatically once you're logged in.");
  console.error("[auth] Timeout: 5 minutes.");

  // Use the user's real installed Chrome and strip Playwright's automation flags
  // so Google OAuth doesn't detect the browser as a bot.
  const stealthArgs = [
    "--window-size=1280,800",
    "--disable-blink-features=AutomationControlled",
  ];
  // ignoreDefaultArgs removes --enable-automation which is the main tell
  const ignoreDefaultArgs = ["--enable-automation"];

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      channel: "chrome",
      args: stealthArgs,
      ignoreDefaultArgs,
    });
    console.error("[auth] Using system Chrome.");
  } catch {
    console.error("[auth] Chrome not found, falling back to Chromium (Google OAuth may be blocked).");
    browser = await chromium.launch({
      headless: false,
      args: stealthArgs,
      ignoreDefaultArgs,
    });
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  // Remove navigator.webdriver — the JS property Google checks first
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    await page.goto("https://www.tradingview.com/", { waitUntil: "domcontentloaded" });

    // Try to open the sign-in modal automatically so the user sees it right away
    const signInSelectors = [
      '[data-name="header-user-menu-sign-in"]',
      'button:has-text("Sign in")',
      'a:has-text("Sign in")',
      '[class*="signIn"]',
    ];
    for (const sel of signInSelectors) {
      try { await page.click(sel, { timeout: 4000 }); break; } catch { /* try next */ }
    }

    console.error("[auth] Waiting for login...");

    // Poll for the sessionid cookie — the definitive signal that TradingView
    // has authenticated the user, regardless of what the UI looks like.
    const jar = await waitForSessionCookie(context, 5 * 60 * 1000);
    console.error("[auth] Login detected — saving session...");
    await saveSession(jar);
    return jar;
  } finally {
    try { await browser.close(); } catch { /* already closed */ }
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function loginDirect(username: string, password: string): Promise<CookieJar> {
  const jar = new CookieJar();

  // Get CSRF token
  const initRes = await fetch("https://www.tradingview.com/", {
    headers: { "User-Agent": UA },
  });
  for (const cookie of initRes.headers.getSetCookie?.() ?? []) {
    await jar.setCookie(cookie, "https://www.tradingview.com");
  }
  const cookies = await jar.getCookies("https://www.tradingview.com");
  const csrfToken = cookies.find((c) => c.key === "csrftoken")?.value;

  // POST credentials
  const body = new URLSearchParams({ username, password, remember: "on" });
  const loginRes = await fetch("https://www.tradingview.com/accounts/signin/", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://www.tradingview.com/",
      "Cookie": cookies.map((c) => `${c.key}=${c.value}`).join("; "),
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    },
    body: body.toString(),
  });

  for (const cookie of loginRes.headers.getSetCookie?.() ?? []) {
    await jar.setCookie(cookie, "https://www.tradingview.com");
  }

  let data: Record<string, unknown>;
  try {
    data = (await loginRes.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected response (status ${loginRes.status})`);
  }

  if (data.error) {
    const msg = String(data.error);
    if (msg.toLowerCase().includes("google") || msg.toLowerCase().includes("apple")) {
      throw new NoFallbackError(
        `This account uses Google/Apple login and has no standalone TradingView password.\n\n` +
        `Use interactive login instead:\n` +
        `  node dist/login.js --interactive\n\n` +
        `Or set a TradingView password:\n` +
        `  tradingview.com → Profile → Settings → Change password`
      );
    }
    throw new Error(msg);
  }

  if (!data.user) {
    throw new Error("Login response missing user — may require CAPTCHA or 2FA; try --interactive");
  }

  console.error("[auth] Direct login successful");
  await saveSession(jar);
  return jar;
}

async function loginHeadless(username: string, password: string): Promise<CookieJar> {
  const args = isDocker ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
  const browser = await chromium.launch({ headless: true, args });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  try {
    await page.goto("https://www.tradingview.com/", { waitUntil: "domcontentloaded" });

    // Dismiss cookie/consent popup if present
    try {
      await page.click('[id="overlap-manager-root"] button:first-child, button:has-text("Accept")', { timeout: 3000 });
    } catch { /* no popup */ }

    // Open sign-in modal
    const signInSelectors = [
      '[data-name="header-user-menu-sign-in"]',
      'button:has-text("Sign in")',
      'a:has-text("Sign in")',
      '[class*="signInButton"]',
    ];
    let opened = false;
    for (const sel of signInSelectors) {
      try { await page.click(sel, { timeout: 5000 }); opened = true; break; } catch { /* try next */ }
    }
    if (!opened) throw new Error("Could not find the Sign in button — TradingView's UI may have changed.");

    // Choose email login
    for (const sel of ['[data-name="login-page-email-button"]', 'button:has-text("Email")', '[class*="emailButton"]']) {
      try { await page.click(sel, { timeout: 5000 }); break; } catch { /* try next */ }
    }

    await page.waitForSelector('input[name="username"], input[autocomplete="username"], input[type="email"]', { timeout: 10000 });
    await page.fill('input[name="username"], input[autocomplete="username"], input[type="email"]', username);
    await page.fill('input[name="password"], input[autocomplete="current-password"]', password);
    await page.click('button[type="submit"]');

    console.error("[auth] Waiting for session cookie...");
    const jar = await waitForSessionCookie(context, 30_000);
    await saveSession(jar);
    return jar;
  } finally {
    await browser.close();
  }
}

async function waitForSessionCookie(context: BrowserContext, timeoutMs: number): Promise<CookieJar> {
  const deadline = Date.now() + timeoutMs;
  let warnedPreAuth = false;
  while (Date.now() < deadline) {
    const cookies = await context.cookies("https://www.tradingview.com");
    const sessionid = cookies.find((c) => c.name === "sessionid");
    if (sessionid) {
      // The sessionid cookie alone is NOT a definitive auth signal — TradingView
      // sets it after username+password but BEFORE 2FA / device verification.
      // Verify the session is fully authenticated by fetching the homepage with
      // these cookies and checking for the `is-authenticated` HTML class.
      // If we close the browser before 2FA completes, the session is invalid.
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      try {
        const res = await fetch("https://www.tradingview.com/", {
          headers: { "User-Agent": UA, Cookie: cookieHeader },
        });
        const html = await res.text();
        if (html.includes("is-authenticated") && !html.includes("is-not-authenticated")) {
          return extractCookies(context);
        }
        if (!warnedPreAuth) {
          console.error("[auth] sessionid present but session not fully authenticated yet — waiting for 2FA / device verification to complete...");
          warnedPreAuth = true;
        }
      } catch {
        // Network hiccup — fall through and retry next iteration
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for login (5 minutes). Please try again.");
}

async function extractCookies(context: BrowserContext): Promise<CookieJar> {
  const playwrightCookies = await context.cookies();
  const jar = new CookieJar();
  for (const c of playwrightCookies) {
    if (!c.domain.includes("tradingview.com")) continue;
    const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
    const cookieStr =
      `${c.name}=${c.value}; Domain=${domain}; Path=${c.path}` +
      (c.expires > 0 ? `; Expires=${new Date(c.expires * 1000).toISOString()}` : "") +
      (c.secure ? "; Secure" : "") +
      (c.httpOnly ? "; HttpOnly" : "");
    // Use the cookie's own subdomain as the URL to avoid domain-mismatch errors
    const cookieHost = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    try {
      await jar.setCookie(cookieStr, `https://${cookieHost}`);
    } catch { /* skip malformed or mismatched cookies */ }
  }
  return jar;
}
