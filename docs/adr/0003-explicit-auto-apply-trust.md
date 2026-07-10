# ADR-0003: Explicit automatic-apply trust

## Status

Accepted on 2026-07-10.

## Context

The tool should support both careful review and a delightful quick `zts sort`. Deterministic rules, manual decisions, and statistical classifiers produce different evidence. A single confidence number cannot safely erase those differences, and model scores are not calibrated probabilities.

## Decision

Bare `zts sort` previews until the user records setup consent for quick sorting. Non-interactive execution never supplies consent implicitly.

Exact rules, approved exact decisions, and validated manual intent may be eligible for automatic apply after normal movement-safety checks. Semantic proposals may also be eligible only when the user explicitly enables semantic automatic apply in configuration or invocation, selects an engine-specific threshold, and receives calibration guidance for that engine and model revision.

Semantic policy records separate suggestion and automatic-apply thresholds, a minimum margin, model and calibration digests, and a move cap. Suggestion and automatic-apply eligibility are derived from that complete evidence by the domain Implementation. Explicit Engine selection never silently downgrades to a different Engine. A score is evidence, not a Trust Class or probability.

## Consequences

- `zts sort` can become fast without making first-run behavior dangerous.
- Deterministic and statistical decisions remain explainable in one Plan.
- Threshold guidance must be based on measured precision and coverage, not a universal recommended number.
- Protection, Drift, structural integrity, destination policy, capability checks, and move caps still override automatic-apply eligibility.

## Options considered

- Always require manual approval. Rejected because it prevents the intended quick-sort workflow.
- Automatically apply any score above a universal threshold. Rejected because scores vary by Engine, model, workspace corpus, and calibration set.
- Treat explicit Engine selection as permission to fall back. Rejected because silent downgrade hides behavior and invalidates trust evidence.

## Notes

The initial emergency interlock uses explicit `--apply --yes`. The production path will replace that coarse consent with Plan-digest and setup-policy semantics.
