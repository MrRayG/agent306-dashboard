# Skill Governance — Agent 306

This doc describes the **Skill Governance** layer Agent 306 uses to
register internal capabilities ("skills") without widening any runtime
authority. It is a **registry + validation layer only** — it does not
add any new runtime behavior.

The pilot entry is the `promotion-boundary-audit` skill, which wraps
the existing `server/eval/promotionBoundaryAudit.ts` helper and the
`scripts/auditPromotionBoundary.ts` CLI. Both wrapped files are
**unchanged** by this layer's introduction.

## Why this exists

Agent 306 already runs as a propose-only agent: it cannot write
`status: applied` except through a single, gated write site in
`server/selfRecommendationEngine.ts`, and it cannot publish, post, or
delete anywhere. The Skill Governance layer's job is to make that
contract **declarative and machine-checkable** at the level of each
named capability:

- A registered skill must declare its declared write surfaces. Every
  declared write surface must be `false`. (`writes.*`)
- A registered skill must declare its promotion authority. The only
  allowed value is `"none"`. (`promotion_authority`)
- A registered skill must declare its policy envelope:
  `policy.propose_only: true`, `policy.expands_autonomy: false`.
- A registered skill must declare `read_only: true`.

The validator (`npm run skills:validate`) refuses any card that widens
any of these fields. CI runs the validator inside the existing
`agent306-safety-gates` job, alongside the promotion-boundary audit.

## What this layer does NOT do

- **It does not promote anything.** A passing validator run is a CI
  signal that the registry is well-formed. It is not authorisation to
  widen the propose-only contract, promote a hypothesis, or expand
  agent autonomy.
- **It does not add runtime behavior.** No scheduler hook, cron,
  app-boot wiring, UI control, API endpoint, or monitor consults the
  registry today.
- **It does not modify any of the listed protected files.** See
  "Non-widening guarantees" below.

## Layout

```
skills/
├── README.md
├── registry.yaml                            # append-only, version: 1
├── schema/skillcard.schema.json             # documented JSON Schema
└── <skill-id>/
    ├── SKILL.md                             # human/agent-facing procedure
    └── SKILLCARD.yaml                       # machine-readable card

server/skillGovernance/
├── skillCardSchema.ts                       # Zod schemas (source of truth)
├── skillCardValidator.ts                    # pure validator
└── index.ts                                 # barrel re-exports

scripts/
└── validateSkillCards.ts                    # CLI; mirrors auditPromotionBoundary.ts
```

## The card

A `SKILLCARD.yaml` declares the safety envelope for one named skill.
The canonical shape is pinned by:

1. The Zod schema in `server/skillGovernance/skillCardSchema.ts` —
   runtime source of truth.
2. The documented JSON Schema in `skills/schema/skillcard.schema.json`
   — same shape, for tooling and human review.

Required keys: `id`, `version`, `title`, `owner`, `summary`, `policy`,
`read_only`, `writes`, `io_surfaces`, `promotion_authority`, `evidence`,
`tests`.

Locked invariants:

| Field                       | Allowed value(s)                |
| --------------------------- | ------------------------------- |
| `policy.propose_only`       | `true`                          |
| `policy.expands_autonomy`   | `false`                         |
| `read_only`                 | `true`                          |
| All `writes.*` fields       | `false`                         |
| `promotion_authority`       | `"none"`                        |

The Zod schema uses `.strict()` everywhere — extra keys are a parse
error. A new write surface or a new policy field cannot be smuggled in
without also editing the schema and going through review.

## The registry

`skills/registry.yaml` (version `1`) is **append-only**. The CI test
`skillCardRegistryAppendOnly.test.ts` enforces:

- The registry parses and matches the schema.
- Entries are sorted by `id`.
- `id`s are unique.
- Every entry's `path` resolves to an existing card.
- Every prior entry on `origin/main` is still present, in the same
  relative order. (If the file does not yet exist on `origin/main`,
  the baseline is treated as empty.)

To add a new skill: create `skills/<id>/SKILL.md` and
`skills/<id>/SKILLCARD.yaml`, then append a new entry to the registry
keeping the list sorted by id. Run `npm run skills:validate` before
opening the PR.

## The validator CLI

```bash
npm run skills:validate          # 0 ok, 2 invalid, 3 read-blocked, 1 CLI usage error
npm run skills:validate -- --pretty
npm run skills:validate -- --now 2026-05-22T00:00:00.000Z
npm run skills:validate -- --repo-root /abs/path/to/repo
```

The CLI mirrors `scripts/auditPromotionBoundary.ts`:
manual-only, read-only, deterministic, stdout-only. It prints exactly
one JSON document on stdout and a safety-invariants banner on stderr.
No `Date.now`, no `Math.random`, no env reads for behaviour.

## CI wiring

A new step inside the existing `agent306-safety-gates` job in
`.github/workflows/ci.yml` runs `npm run skills:validate`. The job
remains a single check line; this step adds no new top-level job.

## Non-widening guarantees

This layer is registry + validation only. The introducing PR does
**not** modify any of the following files:

- `server/selfRecommendationEngine.ts`
- `server/eval/promotionGate.ts`
- `server/eval/promotionBoundaryAudit.ts`
- `shared/schema.ts`
- `data/research_lab.json`
- `data/memory_knowledge.json`
- `data/agent_goals.json`
- `data/competencyProfile.json`
- `.claude/skills/*`

The boundary topology is unchanged. There is still exactly one write
site for `status: "applied"` in `server/selfRecommendationEngine.ts`,
and `applyRecommendation` still gates on
`status === "approved" && canPromote(rec).ok`.

## Tests

- `server/__tests__/skillCardValidator.test.ts` — pure validator tests
  with an injected in-memory filesystem.
- `server/__tests__/skillCardRegistryAppendOnly.test.ts` — structural
  + append-only checks on the live registry, guarded by a `git show`
  timeout and a graceful skip when outside a git repo.
- `server/__tests__/skillCardPromotionBoundaryAudit.test.ts` — pilot
  card invariants: references canonical boundary-audit tests, no write
  surfaces, stdout-only outputs, `promotion_authority: "none"`.

Tests live under `server/__tests__/` and are auto-discovered by
`scripts/runTests.ts`. They are NOT added to `scripts/quarantinedTests.ts`.
