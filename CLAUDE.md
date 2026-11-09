## Workflow: Matt Pocock's skill suite

All work follows the skills in `.claude/skills/` along their main flow: `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` or `/implement-spec` (each driving `/tdd`, closing with `/code-review`) → `/retro`. When the next step is unclear, read `.claude/skills/ask-matt/SKILL.md` and take the step it names; read a skill's own SKILL.md before running, skipping or describing it. Every spec, ticket set and build also gets a review from a separate, fresh Opus instance before moving on.

## Building a ticket

Code follows `CODING_STANDARDS.md`; check stack facts in `docs/agents/stack-notes.md` before reaching for a library or API.

The loop is plan → build → review → fix → ship, Claude only:

1. **Plan**: the builder plans; a fresh reviewer approves before code is written (specs and ticket sets likewise).
2. **Build**: one implementer per ticket, test-first (`/tdd`).
3. **Review**: `/code-review` against the ticket's issue, after every ticket (including under `/implement-spec`, which also reviews the whole integration branch at the end), run by reviewers that start with a fresh context and none of the builder's reasoning, briefed as senior engineers. Opus reviews contract, money, key and security code; Sonnet may review low-risk changes (docs, config, scripts). Each finding must trace to the ticket's acceptance criteria, the spec (#1), an ADR or `CODING_STANDARDS.md`. The Spec axis also hunts scope creep: code, options or features no requirement asked for get removed. A review is a confident sanity check, not a hunt: a clean review is the expected outcome. Reviewers rate each finding critical, high or minor, and only critical and high findings block (a real bug, lost or stuck funds, a broken rule or security property, a missed acceptance criterion, real scope creep). Minor findings are listed once and left alone unless trivial to fix.
4. **Fix**: the builder fixes the critical and high findings. A second review round runs only to confirm those fixes; anything still open after it goes to the maintainer instead of another loop.
5. **Ship**: commit the ticket as its own commit referencing the issue, and push it once its review passes. Anything that goes live (the locked contract deploy, the hosted site, making things public, the submission) waits for the maintainer's own test and sign-off.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `koukikouks/sats-jar`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
