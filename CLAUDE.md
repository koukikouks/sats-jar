## Workflow: Matt Pocock's skill suite

All work follows the skills in `.claude/skills/` along their main flow: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` or `/implement-spec` (each driving `/tdd`, closing with `/code-review`) → `/retro`. When the next step is unclear, read `.claude/skills/ask-matt/SKILL.md` and take the step it names; read a skill's own SKILL.md before running, skipping or describing it. Every spec, ticket set and build also gets a review from a separate, fresh Opus instance before moving on.

## Building a ticket

Code follows `CODING_STANDARDS.md`; check stack facts in `docs/agents/stack-notes.md` before reaching for a library or API.

Every ticket closes with `/code-review` against the ticket's issue, run by fresh Opus sub-agents briefed as senior engineers. Each finding must trace to the ticket's acceptance criteria, the spec (#1), an ADR or `CODING_STANDARDS.md`. The Spec axis also hunts scope creep: code, options or features no requirement asked for get removed. A clean review is the expected outcome, not a failure to find something. Fix what it raises, then commit the ticket as its own commit referencing the issue.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `koukikouks/sats-jar`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
