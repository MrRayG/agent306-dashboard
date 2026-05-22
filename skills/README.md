# Agent 306 Skills Registry

This directory hosts the **Agent 306 Skill Governance layer**. It is a
registry of explicit, declarative *skill cards* describing the internal
capabilities Agent 306 may invoke. The registry is **propose-only**: it
records what each skill is allowed to do and lets CI fail the build if a
card asks for more authority than the propose-only contract permits.

## What a skill is here

A "skill" is a registered, named internal capability — typically a
read-only audit, a deterministic CLI, or a structured procedure — that
Agent 306 may reference by id. Registration does **not** widen any
runtime behavior. It does not give the skill new write authority. It
simply makes the skill discoverable and pins its declared safety
envelope (`writes.*`, `promotion_authority`, `expands_autonomy`,
`propose_only`) under the validator.

This layer is **registry + validation only**. It does not add any
runtime agent behavior. The pilot entry, `promotion-boundary-audit`,
wraps the existing `server/eval/promotionBoundaryAudit.ts` and
`scripts/auditPromotionBoundary.ts` — both of which already exist and
have not been modified.

## Layout

```
skills/
├── README.md                              # this file
├── registry.yaml                          # the canonical, append-only registry
├── schema/
│   └── skillcard.schema.json              # documented JSON Schema for a card
└── <skill-id>/
    ├── SKILL.md                           # human/agent-facing procedure
    └── SKILLCARD.yaml                     # machine-readable safety envelope
```

## Invariants

Every registered skill card MUST declare:

- `policy.propose_only: true`
- `policy.expands_autonomy: false`
- `read_only: true`
- All `writes.*` fields `false`
- `promotion_authority: none`

The validator (`scripts/validateSkillCards.ts`, run via
`npm run skills:validate`) rejects any card that widens any of these
fields. The registry is **append-only**: once an entry is on `main`, it
may not be removed or reordered.

## Validator

```bash
npm run skills:validate          # exits 0 ok, 2 invalid, 3 read-blocked
npm run skills:validate -- --pretty
```

The validator is manual-only, deterministic, read-only, stdout-only. It
mirrors the style of `scripts/auditPromotionBoundary.ts`.

See [`docs/SKILL_GOVERNANCE.md`](../docs/SKILL_GOVERNANCE.md) for the
full design notes.
