import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { syncEmbeddings } from "./embeddingEngine.js";
import { purgeConversationalPosts } from "./blogEngine.js";
import { purgeStaleRelationships, purgeStaleConversationMemory } from "./conversationLearningEngine.js";
import { getResearchLab } from "./researchEngine.js";
import { getAgenda } from "./research-agenda.js";
import { runHypothesisQueueReset } from "./archiveHypotheses.js";
import { maybeBootstrapSelfIntegrity } from "./bootstrapSelfIntegrity.js";

const app = express();
const httpServer = createServer(app);

// Allow cross-origin requests from 306 frontends
app.use(cors({
  origin: [
    "https://agent306.ai",
    "https://www.agent306.ai",
    /\.vercel\.app$/,
    /localhost/,
  ],
  methods: ["GET", "POST"],
}));

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      // Purge any conversational posts that leaked from chat (one-time cleanup)
      const purged = purgeConversationalPosts();
      if (purged.purged > 0) console.log(`[Blog] Purged ${purged.purged} conversational posts on startup`);

      // Purge stale Normies conversation memory at the SOURCE (one-time cleanup)
      const convoPurged = purgeStaleConversationMemory();
      if (convoPurged.purgedUsers > 0 || convoPurged.purgedEntries > 0)
        console.log(`[Startup] Purged ${convoPurged.purgedUsers} stale users, ${convoPurged.purgedEntries} stale entries from conversation memory`);

      // Purge stale Normies relationships (one-time cleanup)
      const relPurged = purgeStaleRelationships();
      if (relPurged.purged > 0) console.log(`[Startup] Purged ${relPurged.purged} stale relationships`);

      // One-time hypothesis queue reset (runs at boot, flagged to run once)
      try {
        const didReset = runHypothesisQueueReset();
        if (didReset) {
          console.log("[Startup] Hypothesis queue reset completed");
        }
      } catch (e: any) {
        console.warn("[Startup] Hypothesis queue reset failed (non-fatal):", e.message);
      }

      // Research pipeline health check
      try {
        const lab = getResearchLab();
        const agenda = getAgenda();
        const activeThreads = agenda.threads.filter((t: any) => t.status !== "abandoned" && t.status !== "published");
        console.log(`[Research] Startup: ${lab.hypotheses.length} hypotheses, ${lab.topics.length} topics, ${activeThreads.length} active threads`);
        if (lab.hypotheses.length === 0) console.warn("[Research] WARNING: Zero hypotheses — cold-start seeding will trigger on next daily cycle");
      } catch (e: any) {
        console.warn("[Research] Startup health check failed:", e.message);
      }

      // Spec §4: one-time meta-prompt journal entry telling 306 about her new
      // Self-Integrity dimension and the Insight Ledger write-path. Idempotent.
      try {
        maybeBootstrapSelfIntegrity();
      } catch (e: any) {
        console.warn("[Startup] Self-Integrity bootstrap failed (non-fatal):", e.message);
      }

      // ASI-Evolve: sync embeddings on startup (non-blocking)
      syncEmbeddings()
        .then(r => console.log(`[Embeddings] Synced: ${r.synced} new, ${r.cached} cached`))
        .catch(e => console.warn("[Embeddings] Sync failed:", e.message));
    },
  );
})();
