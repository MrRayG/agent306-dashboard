# Skill: promotion-boundary-audit

**Owner:** agent306-safety
**Status:** registered (pilot)
**Card:** [`SKILLCARD.yaml`](./SKILLCARD.yaml)

## Purpose

Runs a deterministic, read-only static source audit of the
promotion-boundary invariants Agent 306 relies on for its propose-only
contract. Specifically, this skill verifies:

1. The hypothesis
   `hyp_agent306_safety_gating_single_write_boundary` is the canonical
   pin for the single-write-boundary invariant.
2. The runtime path through `applyRecommendation` (in
   `server/selfRecommendationEngine.ts`) only writes `status: "applied"`
   at exactly one site, and only when both `status === "approved"` and
   `canPromote(rec).ok`.
3. The promotion gate in `server/eval/promotionGate.ts` is the only
   gate consulted on that write path.

The skill wraps two existing files that have NOT been changed by this
registration:

- `server/eval/promotionBoundaryAudit.ts` — the pure audit helper.
- `scripts/auditPromotionBoundary.ts` — the manual CLI runner.

## What this skill is NOT

- **Not** a promoter. The audit cannot promote, apply, register, or
  approve any recommendation. `promotion_authority: none` in the card.
- **Not** a writer. The audit and its CLI runner are read-only — they
  open no file for writing, write no DB row, set no env var, and emit
  no public output.
- **Not** an authorisation. A `violationCount=0` result is evidence
  that the invariant currently holds. It is **not** permission to widen
  the propose-only contract or to promote any hypothesis.
- **Not** autonomous. There is no scheduler hook, cron, app-boot wiring,
  UI control, or API endpoint that invokes this skill. The only entry
  point is the manual CLI (`npx tsx scripts/auditPromotionBoundary.ts`)
  or a unit test that exercises the helper directly.

## How to invoke

Manual, operator-driven, read-only:

```bash
# default: compact JSON to stdout, banner to stderr
npx tsx scripts/auditPromotionBoundary.ts

# pretty-printed
npx tsx scripts/auditPromotionBoundary.ts --pretty

# pin generatedAt for byte-identical CI output
npx tsx scripts/auditPromotionBoundary.ts --now 2026-05-12T17:00:00.000Z
```

Exit codes mirror the underlying audit:
`0` ok · `2` violation · `3` blocked · `1` CLI usage error.

## Evidence

- [`server/__tests__/promotionBoundaryAudit.test.ts`](../../server/__tests__/promotionBoundaryAudit.test.ts)
- [`server/__tests__/phase3BoundaryRegression.test.ts`](../../server/__tests__/phase3BoundaryRegression.test.ts)
- `.github/workflows/ci.yml#agent306-safety-gates`

## Card-level tests

- [`server/__tests__/skillCardPromotionBoundaryAudit.test.ts`](../../server/__tests__/skillCardPromotionBoundaryAudit.test.ts)
  pins the card's safety envelope (read-only, no write surfaces,
  `promotion_authority: none`, references the canonical evidence files).
