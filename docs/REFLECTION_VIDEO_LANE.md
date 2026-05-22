# Reflection Video Lane (PR #417)

A draft-only reflection lane that activates the dormant xAI `grok-imagine-video`
client to attach a short, vertical (9:16) video clip to a [306 REFLECTION]
tweet draft.

**The lane never auto-posts.** It generates a video, persists the MP4 under
the durable data dir, attaches the path to a tweet draft, and shows a preview
in the dashboard. The operator publishes manually.

## Why it exists

`server/videoEngine.ts` has shipped a working xAI client for months
(`generateBurnVideo`), but the entire video pipeline was dormant — the only
caller targeted a removed on-chain image API. The product surface that
naturally benefits from a visual companion is the reflection post: a single
introspective tweet that already lives in the manual / draft-only lane and
already has format + claim guards.

## Safety envelope

| Property                              | Value                          |
|---------------------------------------|--------------------------------|
| Feature flag default                  | `REFLECTION_VIDEO_ENABLED=false` |
| Auto-post                             | Never                          |
| Draft store mutation                  | JSON-backed, additive fields   |
| Daily cost cap                        | 3 videos / UTC day (env-tunable) |
| Promotion gate touched                | No                             |
| `applyRecommendation` touched         | No                             |
| Existing `generateBurnVideo`          | Unmodified                     |

## Files changed

- `server/videoEngine.ts` — adds `generateReflectionVideo`,
  `buildReflectionVideoPrompt`, `resolveReflectionVideoPath`, daily-cap
  helpers, separate `reflectionVideos` counter.
- `server/reflectionPostEngine.ts` — adds `generateReflectionPostWithVideo`
  which calls the existing text generator first, then optionally tries the
  video; failures attach a warning to the text draft rather than nuking it.
- `server/tweetDrafts.ts` — extends `TweetDraft` with optional
  `videoPath / videoFile / videoRequestId / videoDurationSec / videoWarning /
  mediaType` (JSON-backed — no migration).
- `server/routes.ts` — extends `/api/engines/reflection/generate` to accept
  `includeVideo` + `visualPrompt`; adds `GET /api/reflection-videos/:file`
  (path-traversal-safe preview), `GET /api/reflection-videos/_status` (daily
  cap), and `POST /api/tweet-drafts/:id/publish-with-video` (uploads MP4 +
  tweets + marks draft posted).
- `server/xPostScheduler.ts` — `QueuedPost` gains optional `videoPath`;
  `prepareMediaForPost` uploads `video/mp4` when set (image lane untouched).
- `client/src/pages/CommandCenter.tsx` — "Include reflection video" toggle
  + inline preview after generation.
- `client/src/pages/Drafts.tsx` — preview attached video and surface video
  warnings on reflection draft cards.
- `.env.example` — documents the three new env vars + `XAI_API_KEY` alias.

## Env vars

| Name                              | Default | Meaning                                |
|-----------------------------------|---------|----------------------------------------|
| `REFLECTION_VIDEO_ENABLED`        | `false` | Master flag.                           |
| `REFLECTION_VIDEO_DAILY_CAP`      | `3`     | Hard daily cap (UTC).                  |
| `REFLECTION_VIDEO_DURATION_SEC`   | `8`     | Clip length in seconds.                |
| `GROK_API_KEY` / `XAI_API_KEY`    | —       | xAI credential. Used directly — never  |
|                                   |         | through OpenRouter headers.            |

## How to test manually

1. Set `REFLECTION_VIDEO_ENABLED=true` and `GROK_API_KEY=…` in `.env`.
2. `npm run dev` and open Command Center.
3. On the **306 Reflection** card, tick **Include reflection video**.
4. Click **Generate Now**. The card stays visible while the xAI poll runs
   (up to 5 minutes). On success an inline `<video>` preview appears.
5. Open **Drafts** and confirm the [306 REFLECTION] card shows the same
   attached video + duration.
6. To publish: `POST /api/tweet-drafts/<draftId>/publish-with-video` —
   uploads the MP4 via X v1 media upload (`mimeType: "video/mp4"`), tweets
   the draft body, and marks the draft posted.

## Failure paths

- **Flag off** — `generateReflectionVideo` returns a warning, the text
  draft saves with `videoWarning="REFLECTION_VIDEO_ENABLED=false …"`.
- **No key** — same path; warning explains which env var is missing.
- **Daily cap reached** — same path; warning includes counter `(used/cap)`.
- **xAI start / poll fails or times out** — same path; warning includes
  the underlying HTTP status or `status=expired|failed|timeout`.
- **MP4 missing on disk at publish time** — `publish-with-video` returns
  HTTP 409 with a clear "video file missing" message rather than silently
  posting text-only.

## Security notes

- `GET /api/reflection-videos/:file` resolves the filename via
  `resolveReflectionVideoPath`, which:
  - Rejects any filename containing `/`, `\`, or `..`
  - Rejects any filename that isn't `.mp4`
  - Confirms the resolved path is contained in `<DATA_DIR>/reflection_videos/`
- The xAI auth uses `GROK_API_KEY ?? XAI_API_KEY` directly. OpenRouter
  headers (`HTTP-Referer`, `X-Title`) are deliberately NOT sent — xAI
  rejects them.

## Non-goals (intentional)

- No image-to-video. Pure text-to-video in v1.
- No auto-post path. Engine schedulers do not read `videoPath` from drafts.
- No auto-promote of the draft into the X auto-post queue.
- No farcaster upload path. Reflection-video publish is X-only in v1.
