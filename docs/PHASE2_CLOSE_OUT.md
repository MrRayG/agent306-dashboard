# Phase 2 — Close-Out Evidence

**Status:** Phase 2a–2m shipped. Phase 2n (this close-out track) is the safety bridge between Phase 2 and Phase 3a. This document is the *declarative* record of what Phase 2 produced, what state the codebase is in as we approach the Phase 3a entry boundary, and what the disposition is for the two open issues that gated this transition (#330, #332).

This doc has **no authority**. It does not change runtime behavior, does not authorize Phase 3a execution, and is not consulted by any runtime code path. The actual entry-point contract lives in `server/experiments/phase3EntryPoint.ts` and is pinned by the regression tests added in Phase 2n-c. This doc summarizes; the code decides.

## Why this doc exists

Two motivations:

1. **Audit trail.** Phase 2 was an evidence-heavy phase: every sub-phase added structured artifacts (decision evidence, sandbox registrations, close-out reports). The list of *what landed where* was implicit in PR history. This doc consolidates it so the Phase 3a planning step does not have to re-derive it from `git log`.
2. **Readiness boundary.** Phase 3 is the first phase where the agent will perform reversible sandbox actions on its own proposals. The decision to cross that boundary needs an explicit, auditable basis. This doc names the evidence we have, the evidence we still need, and the safety properties Phase 2n locked in.

## Phase 2 sub-phase inventory

The table below is the source-of-truth for what Phase 2 actually delivered, by sub-phase, with the artifact that backs each one. "Authority" means: does this artifact gate a runtime decision today? Most Phase 2 artifacts are *observational* — they record, they refuse, they propose, but they do not auto-apply.

| Sub-phase | Deliverable                                                                                              | Key module(s)                                                                  | Authority today                                  |
|-----------|----------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------|--------------------------------------------------|
| 2a        | Hypothesis → experiment-candidate selector with structured refusal reasons                               | `server/experiments/canFeedExperiment.ts`                                      | Refusal-only (proposes; does not auto-register)  |
| 2b        | Metric / data-source binding registry; tightens 2a's free-text fields into registered keys               | `server/experiments/metricRegistry.ts`, `server/experiments/registerExperiment.ts` | Refusal-only                                  |
| 2c        | Decision rules layer — explicit rule set for "should we run this experiment" with versioned outputs      | `server/experiments/decisionRules.ts`                                          | Refusal-only                                     |
| 2d        | Decision-evidence persistence — every accept/refuse decision writes a structured evidence record         | `server/experiments/decisionEvidence.ts`                                       | Append-only audit                                |
| 2e        | Sandboxed execution wiring (plan-only) — describes what a sandbox run *would* do, never runs it          | `server/experiments/sandboxPlan.ts`                                            | Plan-only (no execution)                         |
| 2e-b      | Low-risk sandbox registration registry — enumerates kinds eligible for sandbox consideration             | `server/experiments/sandboxRegistry.ts`                                        | Registry / refusal-only                          |
| 2e-c      | Persistent sandbox registration records                                                                  | `server/experiments/sandboxRegistrations.ts`                                   | Append-only audit                                |
| 2f        | Meta-reflection / lessons database — captures post-decision reflections without acting on them           | `server/experiments/lessons.ts`                                                | Observational                                    |
| 2g        | Calibrated confidence layer — confidence scoring with explicit calibration                               | `server/experiments/calibratedConfidence.ts`                                   | Observational                                    |
| 2h        | Exploration policy — explicit rules for when to widen vs. narrow hypothesis pool                         | `server/experiments/explorationPolicy.ts`                                      | Refusal-only                                     |
| 2i        | Hypothesis hygiene checks — readiness-field validation, archive/duplicate/blocked signals                | `server/experiments/hypothesisHygiene.ts`                                      | Refusal-only                                     |
| 2j        | Verifier contract — explicit contract for what a "verified" claim must include                           | `server/experiments/verifierContract.ts`                                       | Refusal-only                                     |
| 2k        | Claim map — structured mapping of claim → evidence → verifier outcome                                    | `server/experiments/claimMap.ts`                                               | Observational                                    |
| 2l        | Phase 2 close-out report (programmatic API) — single function that emits the structured close-out record | `server/experiments/phase2CloseOutReport.ts`                                   | Read-only (returns a record; never mutates)      |
| 2l-c      | Close-out report schema version + invariants pin — locks the 15 boundary flags                           | `server/experiments/phase2CloseOutReport.ts` (`PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION`) | Read-only                                |
| 2m        | Phase 3 gating preconditions wiring — the 7 precondition keys consumed by the entry-point                | `server/experiments/phase2CloseOutReport.ts` (`phase3Gating` block)            | Read-only                                        |

For the long-form narrative of why each piece is shaped the way it is, see [PHASE2_EXPERIMENTS.md](./PHASE2_EXPERIMENTS.md), [EXPLORATION_POLICY.md](./EXPLORATION_POLICY.md), [HYPOTHESIS_HYGIENE.md](./HYPOTHESIS_HYGIENE.md), [VERIFIER_CONTRACT.md](./VERIFIER_CONTRACT.md), [CLAIM_MAP.md](./CLAIM_MAP.md), [CALIBRATED_CONFIDENCE.md](./CALIBRATED_CONFIDENCE.md), and [SELF_EVOLUTION.md](./SELF_EVOLUTION.md).

## Phase 2n — the close-out track

Phase 2n is a four-PR safety bridge. It adds **zero new agent capabilities**. Every artifact below is either a runner that observes, a constant that declares, or a test that pins. Nothing in Phase 2n authorizes anything.

| PR    | Sub-phase | What it adds                                                                            | Runtime authority |
|-------|-----------|-----------------------------------------------------------------------------------------|-------------------|
| #331  | (pre-2n)  | CI guard: hard-fails any `npm test` run that mutates `data/agent306.db` or core state   | CI-only           |
| #333  | (pre-2n)  | Quarantine of 19 core-state-mutating tests; introduces `npm run test:guarded` subset    | Test infra        |
| #334  | 2n-a      | Manual close-out report runner (`scripts/runManualPhase2CloseOutReport.ts`) — read-only, stdout-only | None    |
| #335  | 2n-b      | Phase 3a entry-point constant — declarative anchor enumerating the 7 preconditions      | None              |
| #336  | 2n-c      | Phase boundary regression test suite — pins entry-point / registry / close-out parity   | Test-only         |
| (this) | 2n-d     | Close-out evidence doc + #330/#332 disposition (this file)                              | None              |

### What each Phase 2n piece pins

**PR #331 (core-state integrity CI guard).** Closes the structural failure mode that made every prior phase nervous: tests that silently wrote to `data/agent306.db` (or other shared state files) produced order-dependent results and could mask regressions. The guard runs `scripts/checkCoreStateIntegrity.sh` and fails CI if `git diff` after `npm run test:guarded` shows any change to the protected state paths. This is a *property* of the test harness, not a feature of the agent.

**PR #333 (quarantine + `test:guarded`).** Splits the test suite into two: the full suite (still has 19 known core-state culprits, drained separately under Issue #332) and the guarded subset, which excludes them. The guarded subset is what CI runs and what every Phase 2n PR is measured against. The 19 culprits are not deleted — they're inventoried in `quarantinedTests.ts` and drained one at a time on a parallel track.

**PR #334 (Phase 2n-a, manual close-out runner).** A CLI runner that calls the Phase 2l-c programmatic API with **no evidence injection** and prints the structured report to stdout. The runner's sole purpose is to make the close-out report *invocable by a human without any execution side effects*. A key non-widening property pinned by its test suite (38 tests): because the runner injects no `learningLoopInputs` evidence, the learning loop reports `cold`, which means the verdict reachable from a CLI invocation caps at `not_ready` regardless of what else is in the report. **The CLI cannot fabricate readiness.** Higher verdicts (including the `ready_for_sandbox_only_trial_candidate` candidate) are reachable only via the programmatic API with full evidence injection — and even then, that candidate is explicitly a *planning candidate* for human review, not an authorization to execute.

**PR #335 (Phase 2n-b, entry-point constant).** A single module that *declares* the Phase 3a entry point: the schema version, the single enabled sandbox kind (`summarizationTemplate`), the 7 precondition keys, and the file paths that are explicitly never authorized to invoke the entry-point ("`NEVER_AUTHORIZED_BY`" list). The module exports only constants and pure functions; it imports no runtime services; it has no side effects. Its job is to be the **one place** the Phase 3a contract is written down so drift between the close-out report and the actual entry-point becomes a test failure rather than a silent divergence. The test (24 tests, all live parity assertions) verifies that every `NEVER_AUTHORIZED_BY` path exists on disk and that the precondition keys it declares match `phase3Gating.criteria[].key` order from the close-out report exactly.

**PR #336 (Phase 2n-c, boundary regression tests).** Zero new runtime code. 21 tests across 11 suites that pin properties no single module would catch alone:

- Sandbox-kind parity: the kind named by the entry-point constant must be present in the sandbox registry.
- FIXED_INVARIANTS parity: the 15 boundary flags on the close-out report match the entry-point's view.
- Schema-version pair lock: the entry-point version and the close-out report schema version are coupled.
- Full-repo entry-point isolation: a grep across the repo verifies the entry-point version literal occurs only in the entry-point module and its two test files. Any new occurrence anywhere else fails the test, forcing the author to either route through the entry-point or justify the duplication.
- `NEVER_AUTHORIZED_BY` contract: every path listed exists, and a basename regex check ensures none of those paths import the entry-point.
- Criterion-key character stability: the 7 precondition keys are pinned by string equality, so renaming one is a test failure.
- Manual-runner contract restatement: the runner's verdict cap (`not_ready` from CLI) is asserted independently of the runner's own test file, so the cap survives a runner refactor.
- Self-import sanity, production-runtime surface symbol grep, and other belt-and-suspenders checks.

### Test baselines

After each Phase 2n merge, `npm run test:guarded`:

- After PR #334: 2342 passing
- After PR #335: 2365 passing (+23)
- After PR #336: 2386 passing (+21)

## Phase 3 readiness — current recommendation

**Recommendation: `not_ready` for autonomous Phase 3a execution. Ready for Phase 3a *planning*.**

The structural pieces are in place (entry-point, regression tests, close-out report, runner). What is *not* in place is the live evidence the entry-point requires before authorizing even a single reversible sandbox action.

### Why `not_ready` from the CLI today

The manual close-out runner (`scripts/runManualPhase2CloseOutReport.ts`) injects no `learningLoopInputs`. The learning loop therefore reports `cold`. The `phase3Gating` block downgrades to `not_ready`. This is **intentional and non-widening**: it means a human running the CLI can never accidentally produce a "ready" verdict. The cap is pinned by tests in PR #334 and restated independently in PR #336.

### What evidence would lift readiness

Lifting readiness requires the programmatic Phase 2l-c API to be invoked *with* a full evidence bundle. Specifically:

1. **`learningLoopInputs` populated** with non-cold signal: at least one closed-loop episode where a proposal was evaluated, accepted or refused with reasons, and the outcome recorded.
2. **Decision-evidence records** (Phase 2d) for the kinds we plan to enable in 3a — today that's only `summarizationTemplate`.
3. **Sandbox-registration records** (Phase 2e-c) showing the kind is registered and the proposed action passes the registry's eligibility check.
4. **Calibrated-confidence floor** (Phase 2g) met for the candidate proposal.
5. **Verifier contract** (Phase 2j) satisfied for the claim the proposal addresses.
6. **All 7 precondition keys** asserted true with attestation evidence (the per-attestation `priority: high | low` tier was locked in earlier this phase).

Even with all six, the verdict produced is `ready_for_sandbox_only_trial_candidate` — a **candidate for human-reviewed planning**, not an execution authorization. The actual decision to run Phase 3a remains a human gate, out-of-band of the agent.

### The shape of the Phase 3a entry boundary

The entry-point constant (`server/experiments/phase3EntryPoint.ts`) declares:

- **One enabled kind:** `summarizationTemplate`. No other kinds are eligible for Phase 3a, even if they pass every other check. Widening this is a Phase 3b conversation, not a Phase 3a one.
- **Seven preconditions** (verbatim keys): `reversibleLowRiskActionOnly`, `explicitKillSwitchAndResourceLimits`, `anomalyAndDriftDetectionPlaceholder`, `rollbackProof`, `humanApprovalBoundary`, `metricsClockReadiness`, `noPublicAction`.
- **A `NEVER_AUTHORIZED_BY` list** — file paths that are explicitly forbidden to invoke the entry-point. The regression test in PR #336 verifies (a) every path exists and (b) none of them imports the entry-point module.
- **Two coupled schema versions** — the entry-point's own version and the close-out report's `phase2l-c.v1` schema version. Bumping one without the other fails the pair-lock test in PR #336.

## Issue disposition

### Issue #330 — core-state hygiene CI guard

**Status: satisfied. Recommend close.**

PR #331 landed the guard. It hard-fails CI on any `npm run test:guarded` run that produces a non-empty diff in `data/agent306.db` or other protected paths. Phase 2n-a through 2n-c have all run green under this guard. The structural failure mode the issue was opened to address (silent state mutation) is now load-bearing on the CI gate.

What #330 does **not** cover, and is therefore *not* a regression of this disposition:

- The 19 quarantined tests still mutate core state when run directly. They are excluded from `test:guarded` and tracked under #332.
- ~8 untracked side-effect files appear in `data/` after some test runs (`academy_state.json`, `action-guard-audit.jsonl`, `article_state.json`, `blog_state.json`, `entity-index.json`, `migration_reflections_cleanup_complete.json`, `voice_journal.json`, `proposed_patches/`). The guard correctly ignores untracked files; these are out-of-scope for #330 and will be addressed alongside the quarantine drain.

### Issue #332 — quarantine 19 culprit tests

**Status: drain in progress on a parallel track. Do not close yet.**

The quarantine itself shipped in PR #333. What remains is the per-test root-cause work: each culprit test needs a proper `DB_PATH` redirect (or similar isolation strategy depending on the state it mutates) so it can rejoin the guarded suite without violating the #331 guard. This is a one-PR-per-test drain that runs **in parallel with Phase 3 work**, not as a blocker on it.

Why not a blocker: the structural property Phase 3 cares about — "tests cannot silently mutate core state under the guarded suite" — is already pinned by #331 and #333 together. The quarantine drain rejoins tests one at a time to the guarded set; it does not change any safety property. Phase 3a planning can proceed under the current `test:guarded` baseline (2386 tests).

## End state — single unified agent

The long-arc direction the project is converging on is a single unified agent — no sandbox/production split, no separate execution mode boundary. Phase 3a is the first step in that direction: it lets the agent itself produce reversible, low-risk actions inside an explicit boundary, with an explicit kill-switch, and with every action audited. Phase 3b–3e progressively widen what's allowed inside that boundary; Phase 4 introduces the public-action boundary and the human-approval gate that governs it.

Phase 2n's role in that arc is to be the **declarative anchor**: the place where the contract between "what Phase 2 produced" and "what Phase 3 can rely on" is written down once and pinned by tests. Future phases inherit that anchor by reading the entry-point constant and the close-out report, not by re-deriving the contract from scratch.

## Pointers

- Entry-point constant: `server/experiments/phase3EntryPoint.ts`
- Entry-point tests: `server/__tests__/phase3EntryPoint.test.ts`
- Boundary regression tests: `server/__tests__/phase3BoundaryRegression.test.ts`
- Manual close-out runner: `scripts/runManualPhase2CloseOutReport.ts`
- Manual close-out runner tests: `server/__tests__/runManualPhase2CloseOutReport.test.ts`
- Programmatic close-out API: `server/experiments/phase2CloseOutReport.ts`
- CI guard script: `scripts/checkCoreStateIntegrity.sh`
- Guarded-subset config: `scripts/quarantinedTests.ts`

For sub-phase narratives, see the per-topic docs in this folder.
