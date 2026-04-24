# Golden Sets — Regression Harness for Self-Evolution

Each `*.golden.json` in this directory pins part of Agent 306's behavior.
The promotion gate (`server/eval/promotionGate.ts`) runs every golden case
before applying a `SelfRecommendation`; any failing case blocks promotion
for `medium` + `high`-risk changes. (`low`-risk failures are logged, not
blocking.)

## Format

```jsonc
{
  "name": "hypothesisTriage",
  "version": 1,
  "description": "…",
  "cases": [
    { "id": "…", "fn": "<module>.<export>", "args": [...], "expect": { ... } }
  ]
}
```

`fn` is resolved by `server/eval/regressionRunner.ts` through a static
registry — we never resolve a `fn` string into a dynamic import. The
registry currently maps:

| string           | module                         |
|------------------|--------------------------------|
| `voice.*`        | `server/voice.ts`              |
| `hypothesisTriage.*` | `server/hypothesisTriage.ts` |
| `modelRouter.*`  | `server/modelRouter.ts`        |

Adding a new golden surface is a two-step change: (a) append to the
registry in `regressionRunner.ts`; (b) drop a new `*.golden.json` here.

## `expect` kinds

- `{ kind: "equals", value: any }`
- `{ kind: "contains", value: string }` — haystack.includes(value)
- `{ kind: "minLength", value: number }` — (string | array).length >= value
- `{ kind: "objectContains", value: object }` — every k/v present on result
- `{ kind: "greaterThan", value: number }`
- `{ kind: "truthy" }`

## How Agent 306 can propose new golden cases

Agent 306's self-recommendation loop can target `category: "data"` with a
proposed diff that adds a new case to one of these files. The operator
reviews the rec via `/api/self-recommendations`, approves it, and either
opens a draft PR or writes the patch. Nothing auto-merges.

## Local workflow

```
# Run all sets from a repl
npx tsx -e "import { runAllGoldenSets } from './server/eval/regressionRunner.js'; console.log(JSON.stringify(runAllGoldenSets(), null, 2));"

# Unit tests
npx tsx --test server/__tests__/promotionGate.test.ts
```

## Seed sets (this PR)

- `voice.golden.json` — voice block identity + length invariants
- `hypothesisTriage.golden.json` — queueFor + triagePriority contract
- `modelRouter.golden.json` — task → tier → provider routing contract
