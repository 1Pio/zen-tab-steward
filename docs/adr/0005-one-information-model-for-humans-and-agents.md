# ADR-0005: One information model for humans and agents

## Status

Accepted on 2026-07-10.

## Context

zts is both a direct human CLI and an agent-native tool. Artificially hiding tab detail from agents would create divergent behavior, weaken manual agent sorting, and substitute zts policy for the user's choice of local or cloud agent.

## Decision

Human and machine presentation project the same Snapshot, Plan, and Receipt information. Full tab titles and URLs are available by default to either caller. There is no privacy-reduced "agent mode" and no special authority granted by `--json`.

Users may choose masking, field selection, compact views, or diagnostic redaction. Those are explicit presentation controls. The user decides whether to give output to a local agent, cloud agent, or no agent. Titles, URLs, Workspace names, folder names, and group names are explicitly marked as browser-untrusted data. Patch reasons remain caller-untrusted; Decision explanations preserve zts, caller, or Engine provenance; automatic-apply rationales and issue messages are separately marked zts-generated. All are data-only, and their Entity references must resolve inside the bound Snapshot. Renderers and agents must never interpret their contents as zts instructions, commands, or policy.

Visibility never grants mutation authority, Protection override, or permission to bypass Plan and Apply Transaction semantics. Stored artifacts remain owner-private regardless of output choice.

## Consequences

- Agents can make genuinely tailored manual Patch decisions from complete context.
- Human and machine UX do not drift into different product semantics.
- Documentation must warn that titles and URLs can contain private information.
- Shareable diagnostics need a separate explicit redaction path.

## Options considered

- Mask URLs for agents by default. Rejected because caller type does not establish trust and reduced detail harms usefulness.
- Create local-agent and cloud-agent modes. Rejected because zts cannot reliably infer deployment trust and the user owns that choice.
- Expose detail only through human output. Rejected because it makes the machine Interface less capable than screen scraping.

## Notes

Terminal renderers must sanitize control characters. JSON preserves original strings through normal JSON escaping.
