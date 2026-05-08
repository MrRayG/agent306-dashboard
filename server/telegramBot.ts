// ─────────────────────────────────────────────────────────────────────────────
// Agent 306 — Telegram Bot
// ─────────────────────────────────────────────────────────────────────────────
// Lets MrRayG chat with Agent 306 from anywhere via Telegram.
// Reuses the exact same /api/chat/send brain so history, actions, memory,
// and persona are identical to the dashboard chat.
//
// How it works:
//   1. User messages @YourBot on Telegram.
//   2. Telegram POSTs to /api/telegram/webhook (this file registers the route).
//   3. We check the caller is in TELEGRAM_ALLOWED_USER_IDS.
//   4. We invoke the chat pipeline the same way /api/chat/send does.
//   5. We post the reply back to Telegram via sendMessage().
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN           — from @BotFather
//   TELEGRAM_ALLOWED_USER_IDS    — comma-separated Telegram numeric user IDs
//                                  (only these users can chat with 306)
// Optional env vars:
//   TELEGRAM_WEBHOOK_SECRET      — shared secret Telegram sends in the
//                                  X-Telegram-Bot-Api-Secret-Token header
//                                  (highly recommended in production)
// ─────────────────────────────────────────────────────────────────────────────

import type { Express, Request, Response } from "express";
import { checkDashboardAuth } from "./dashboardAuth.js";

const TG_API = "https://api.telegram.org";

function token(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

function allowedUserIds(): Set<number> {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );
}

async function tgSendMessage(chatId: number, text: string, replyToMessageId?: number) {
  const t = token();
  if (!t) return;
  // Telegram hard-caps messages at 4096 chars. Split long replies.
  const chunks = chunkText(text, 3900);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await fetch(`${TG_API}/bot${t}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunks[i],
          parse_mode: "Markdown",
          reply_to_message_id: i === 0 ? replyToMessageId : undefined,
          disable_web_page_preview: true,
        }),
      });
    } catch (err: any) {
      console.warn("[Telegram] sendMessage failed:", err?.message ?? err);
    }
  }
}

async function tgSendChatAction(chatId: number, action = "typing") {
  const t = token();
  if (!t) return;
  try {
    await fetch(`${TG_API}/bot${t}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // non-critical
  }
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer to split on a paragraph or sentence boundary
    const slice = remaining.slice(0, max);
    const paraBreak = slice.lastIndexOf("\n\n");
    const sentBreak = slice.lastIndexOf(". ");
    const cut = paraBreak > max * 0.5 ? paraBreak : sentBreak > max * 0.5 ? sentBreak + 1 : max;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

// Call our own /api/chat/send so we reuse the dashboard brain in full:
// history, persona, actions (episodes/blogs/research), memory, everything.
async function callOwnChatSend(baseUrl: string, text: string, sessionId?: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = process.env.DASHBOARD_SECRET ?? "";
  if (secret) headers["x-dashboard-secret"] = secret;

  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, sessionId }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`chat/send ${r.status}: ${body.slice(0, 200)}`);
  }
  const data: any = await r.json();
  // /api/chat/send returns { reply: { role, text, timestamp, mood, needsHelp } }.
  // Fall back through older/alternate shapes just in case.
  const replyText =
    data?.reply?.text ??
    (typeof data?.reply === "string" ? data.reply : undefined) ??
    data?.text ??
    data?.message?.text ??
    "";
  return String(replyText);
}

function selfBaseUrl(req: Request): string {
  // Prefer explicit env override, otherwise derive from the incoming request.
  const override = process.env.PUBLIC_BASE_URL;
  if (override) return override;
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  return `${proto}://${host}`;
}

export function registerTelegramRoutes(app: Express) {
  // ── Webhook: Telegram POSTs every incoming message here ───────────────
  app.post("/api/telegram/webhook", async (req: Request, res: Response) => {
    // Verify Telegram's secret header if configured
    const configuredSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    if (configuredSecret) {
      const sent = req.headers["x-telegram-bot-api-secret-token"];
      if (sent !== configuredSecret) {
        console.warn("[Telegram] Rejected webhook: bad secret header");
        return res.status(401).json({ ok: false });
      }
    }

    // Always 200 quickly so Telegram doesn't retry. Heavy work runs async.
    res.json({ ok: true });

    try {
      const update = req.body ?? {};
      const msg = update.message ?? update.edited_message;
      if (!msg) return;

      const chatId: number = msg.chat?.id;
      const fromId: number = msg.from?.id;
      const text: string = (msg.text ?? "").trim();
      const messageId: number = msg.message_id;

      if (!chatId || !fromId || !text) return;

      // Allowlist — only MrRayG (and anyone he whitelists) can talk to 306
      const allowed = allowedUserIds();
      if (allowed.size > 0 && !allowed.has(fromId)) {
        await tgSendMessage(
          chatId,
          `Agent 306 is private. Your Telegram ID is \`${fromId}\` — ask MrRayG to add you.`,
        );
        return;
      }

      // Built-in slash commands
      if (text.startsWith("/start")) {
        await tgSendMessage(
          chatId,
          "Agent 306 online. Direct line open.\n\nJust type anything — I'll respond like I do in the dashboard. Episodes, blogs, research, and hypotheses can all be triggered from here.",
          messageId,
        );
        return;
      }
      if (text.startsWith("/ping")) {
        await tgSendMessage(chatId, "pong — 306 is up.", messageId);
        return;
      }
      if (text.startsWith("/whoami")) {
        await tgSendMessage(chatId, `Your Telegram ID: \`${fromId}\``, messageId);
        return;
      }
      if (text.startsWith("/help")) {
        await tgSendMessage(
          chatId,
          [
            "*Agent 306 — Telegram commands*",
            "",
            "`/start`  — greeting",
            "`/ping`   — health check",
            "`/whoami` — your Telegram user ID",
            "`/help`   — this message",
            "",
            "Everything else goes straight to Agent 306.",
          ].join("\n"),
          messageId,
        );
        return;
      }

      // Show "typing…" in Telegram while the LLM thinks
      await tgSendChatAction(chatId, "typing");

      // Send to the same brain the dashboard uses.
      // Shared sessionId so Telegram + dashboard appear as one conversation.
      const baseUrl = selfBaseUrl(req);
      console.log(`[Telegram] incoming from ${fromId}: ${text.slice(0, 100)} → POSTing ${baseUrl}/api/chat/send`);
      let reply: string;
      try {
        reply = (await callOwnChatSend(baseUrl, text, "dashboard-main")).trim();
        console.log(`[Telegram] got reply (${reply.length} chars): ${reply.slice(0, 120)}`);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error("[Telegram] chat/send failed:", msg);
        // Surface the actual error to the Telegram user so we can debug without Railway logs.
        reply = `⚠️ Agent 306 hit an error:\n\n\`${msg.slice(0, 400)}\``;
      }
      if (!reply) {
        reply = "(306 returned an empty reply — check Railway logs for the raw response)";
      }
      await tgSendMessage(chatId, reply, messageId);
    } catch (err: any) {
      console.error("[Telegram] webhook handler error:", err?.message ?? err);
    }
  });

  // ── Admin: register the webhook URL with Telegram ────────────────────
  // Call once after deploy: POST /api/telegram/set-webhook { url: "https://<your-app>/api/telegram/webhook" }
  // Requires x-dashboard-secret so randos can't repoint your bot.
  app.post("/api/telegram/set-webhook", async (req: Request, res: Response) => {
    const auth = checkDashboardAuth({ presented: req.headers["x-dashboard-secret"] });
    if (auth.kind === "deny") {
      if (auth.status === 503) {
        return res.status(503).json({
          error: "Service unavailable",
          reason: "DASHBOARD_SECRET is not configured in production — refusing privileged request",
        });
      }
      return res.status(401).json({ error: "Unauthorized" });
    }
    const t = token();
    if (!t) return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN not set" });

    const url = (req.body?.url ?? "").trim();
    if (!url) return res.status(400).json({ error: "url required" });

    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET || undefined;
    try {
      const r = await fetch(`${TG_API}/bot${t}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          secret_token: secretToken,
          allowed_updates: ["message", "edited_message"],
        }),
      });
      const data = await r.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "set-webhook failed" });
    }
  });

  // ── One-click activation page (zero terminal required) ────────────────
  // Visit /telegram/activate?key=<DASHBOARD_SECRET> in a browser, click the button.
  // Shows status + a single button that wires the webhook with Telegram.
  app.get("/telegram/activate", async (req: Request, res: Response) => {
    const providedKey = (req.query.key as string) ?? "";
    const auth = checkDashboardAuth({ presented: providedKey });
    if (auth.kind === "deny") {
      if (auth.status === 503) {
        res.status(503).type("html").send(
          `<html><body style="font-family:system-ui;background:#0b0b0e;color:#f0f0f0;padding:2rem">
            <h2>Service unavailable</h2>
            <p>DASHBOARD_SECRET is not configured in production. The activation page is disabled.</p>
          </body></html>`,
        );
        return;
      }
      res.status(401).type("html").send(
        `<html><body style="font-family:system-ui;background:#0b0b0e;color:#f0f0f0;padding:2rem">
          <h2>Unauthorized</h2>
          <p>Append <code>?key=YOUR_DASHBOARD_SECRET</code> to the URL.</p>
        </body></html>`,
      );
      return;
    }

    const t = token();
    const base = selfBaseUrl(req);
    const webhookUrl = `${base}/api/telegram/webhook`;
    const allowedCount = allowedUserIds().size;
    const hasSecret = !!process.env.TELEGRAM_WEBHOOK_SECRET;

    // Fetch current webhook info
    let botUser = "(unknown)";
    let currentWebhook = "(none)";
    let pendingUpdates = 0;
    let lastError = "";
    if (t) {
      try {
        const [meR, whR] = await Promise.all([
          fetch(`${TG_API}/bot${t}/getMe`),
          fetch(`${TG_API}/bot${t}/getWebhookInfo`),
        ]);
        const me: any = await meR.json();
        const wh: any = await whR.json();
        botUser = me?.result?.username ? `@${me.result.username}` : botUser;
        currentWebhook = wh?.result?.url || "(none)";
        pendingUpdates = wh?.result?.pending_update_count ?? 0;
        lastError = wh?.result?.last_error_message || "";
      } catch (err: any) {
        lastError = err?.message ?? String(err);
      }
    }

    const ok = (cond: boolean) => (cond ? "\u2705" : "\u274c");
    const isLive = currentWebhook === webhookUrl;

    // Escape arbitrary text for safe use inside an HTML attribute value.
    const htmlAttr = (s: string) =>
      String(s).replace(/[&<>"'\r\n]/g, (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
          "\r": "&#13;",
          "\n": "&#10;",
        }[c] as string),
      );

    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Agent 306 — Telegram Activation</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0e;color:#f0f0f0;margin:0;padding:2rem;max-width:720px;margin:0 auto}
  h1{color:#8ef}
  .card{background:#17171d;border:1px solid #2a2a33;border-radius:12px;padding:1.25rem;margin:1rem 0}
  .row{display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #222}
  .row:last-child{border-bottom:none}
  code{background:#000;padding:.15rem .4rem;border-radius:4px;font-size:.85em;word-break:break-all}
  button{background:#4fd1c5;color:#000;border:0;padding:.85rem 1.5rem;font-size:1rem;font-weight:600;border-radius:8px;cursor:pointer;width:100%}
  button:hover{background:#7ee8dc}
  button:disabled{background:#444;color:#888;cursor:not-allowed}
  #result{margin-top:1rem;padding:1rem;border-radius:8px;display:none;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,monospace;font-size:.85em}
  .ok{background:#0d3320;border:1px solid #1f7a4c}
  .err{background:#3a1010;border:1px solid #7a1f1f}
  .muted{color:#888;font-size:.9em}
</style></head>
<body>
  <h1>Agent 306 — Telegram Activation</h1>
  <p class="muted">Click the button below to connect your Telegram bot. No terminal needed.</p>

  <div class="card">
    <div class="row"><span>Bot token configured</span><span>${ok(!!t)}</span></div>
    <div class="row"><span>Allowed user IDs</span><span>${ok(allowedCount > 0)} ${allowedCount} user(s)</span></div>
    <div class="row"><span>Webhook secret set</span><span>${ok(hasSecret)}</span></div>
    <div class="row"><span>Bot username</span><span><code>${botUser}</code></span></div>
    <div class="row"><span>Current webhook</span><span>${isLive ? "\u2705 Live" : "\u26a0\ufe0f Not set"}</span></div>
    <div class="row"><span>Pending updates</span><span>${pendingUpdates}</span></div>
    ${lastError ? `<div class="row"><span>Last Telegram error</span><span style="color:#f88">${lastError}</span></div>` : ""}
  </div>

  <div class="card">
    <div class="muted" style="margin-bottom:.75rem">This will register the following URL with Telegram:</div>
    <code>${webhookUrl}</code>
  </div>

  <button id="activateBtn"
    data-key="${htmlAttr(providedKey)}"
    data-url="${htmlAttr(webhookUrl)}"
    ${!t || allowedCount === 0 ? "disabled" : ""}>
    ${isLive ? "Re-activate webhook" : "Activate Telegram bot"}
  </button>
  ${!t ? '<p class="muted">⚠️ Set <code>TELEGRAM_BOT_TOKEN</code> in Railway first.</p>' : ""}
  ${allowedCount === 0 ? '<p class="muted">⚠️ Set <code>TELEGRAM_ALLOWED_USER_IDS</code> in Railway first.</p>' : ""}

  <div id="result"></div>

  <p class="muted" style="margin-top:2rem">After activating, open your bot in Telegram and send <code>/ping</code>.</p>

<script>
  const btn = document.getElementById("activateBtn");
  const out = document.getElementById("result");
  btn.addEventListener("click", async () => {
    const dashKey = btn.dataset.key || "";
    const hookUrl = btn.dataset.url || "";
    btn.disabled = true;
    btn.textContent = "Activating\u2026";
    out.style.display = "block";
    out.className = "";
    out.textContent = "Calling Telegram\u2026";
    try {
      const headers = { "content-type": "application/json" };
      if (dashKey) headers["x-dashboard-secret"] = dashKey;
      const r = await fetch("/api/telegram/set-webhook", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ url: hookUrl }),
      });
      const data = await r.json();
      if (data && data.ok) {
        out.className = "ok";
        out.textContent = "\u2705 Success!\n\n" + JSON.stringify(data, null, 2) + "\n\nNow message your bot on Telegram and send /ping";
        btn.textContent = "Activated \u2014 reload to see status";
      } else {
        out.className = "err";
        out.textContent = "\u274c Failed\n\n" + JSON.stringify(data, null, 2);
        btn.disabled = false;
        btn.textContent = "Try again";
      }
    } catch (e) {
      out.className = "err";
      out.textContent = "\u274c Error: " + (e.message || e);
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
</script>
</body></html>`);
  });

  // ── Status: check current webhook registration ────────────────────────
  app.get("/api/telegram/status", async (_req: Request, res: Response) => {
    const t = token();
    if (!t) return res.json({ configured: false });
    try {
      const [meR, whR] = await Promise.all([
        fetch(`${TG_API}/bot${t}/getMe`),
        fetch(`${TG_API}/bot${t}/getWebhookInfo`),
      ]);
      const me = await meR.json();
      const wh = await whR.json();
      res.json({
        configured: true,
        allowedUserCount: allowedUserIds().size,
        secretHeaderEnabled: !!process.env.TELEGRAM_WEBHOOK_SECRET,
        bot: me?.result,
        webhook: wh?.result,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "status failed" });
    }
  });
}
