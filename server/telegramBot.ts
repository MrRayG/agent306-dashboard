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
  return (data?.text ?? data?.reply ?? "").toString();
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
      let reply: string;
      try {
        reply = (await callOwnChatSend(baseUrl, text, "dashboard-main")).trim();
      } catch (err: any) {
        console.error("[Telegram] chat/send failed:", err?.message ?? err);
        reply = "Agent 306 is having a moment — try again in a sec.";
      }
      await tgSendMessage(chatId, reply || "(no response)", messageId);
    } catch (err: any) {
      console.error("[Telegram] webhook handler error:", err?.message ?? err);
    }
  });

  // ── Admin: register the webhook URL with Telegram ────────────────────
  // Call once after deploy: POST /api/telegram/set-webhook { url: "https://<your-app>/api/telegram/webhook" }
  // Requires x-dashboard-secret so randos can't repoint your bot.
  app.post("/api/telegram/set-webhook", async (req: Request, res: Response) => {
    const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET ?? "";
    if (DASHBOARD_SECRET && req.headers["x-dashboard-secret"] !== DASHBOARD_SECRET) {
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
