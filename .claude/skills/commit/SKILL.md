---
name: commit
description: Write a git commit message in this repo's house style. Use whenever you run `git commit`, amend one, or draft a message for someone else to commit.
---

Commit messages read like a careful engineer wrote them by hand: short, specific, plain. Style follows git's own SubmittingPatches and Chris Beams' seven rules.

## Shape

```
contract: refuse a second allowance in the same period

The rule allowed one allowance per period, but a request made while
the first payment was still unconfirmed slipped through, because the
check looked only at confirmed payments. Count pending payments too.

Closes #5
```

- **Subject**: `area: summary`. Area is the part of the repo touched: `btc`, `contract`, `keys`, `sdk`, `backend`, `keeper`, `proof`, `scripts`, `docs`, `build`. Summary in the imperative, lowercase after the colon, no full stop, about 50 characters and never over 72. It completes "If applied, this commit will ...".
- **Body** (skip it when the subject says everything): a blank line, then why the change exists: the problem, why this fixes it, and any alternative you rejected. Present tense for how things are, imperative for what the commit does. Wrap at 72 columns. One to three short paragraphs of prose.
- **Trailer**: `Closes #N` for the ticket the commit finishes, or `Refs #N` for one it advances. Nothing else.

## Plain voice

Write the message the way the code's author would explain it to a colleague:

- Name the concrete thing: the function, refusal code, rule or file that changed, in the glossary's words.
- State only what the diff does; the diff itself shows how.
- One logical change per commit. If the body needs a list of unrelated changes, split the commit.
- Plain words: "add", "fix", "refuse", "move", "drop". Leave out filler such as comprehensive, robust, seamless, leverage, enhance, streamline, ensure, various, this commit.
- Plain text only: no emoji, no markdown headings or bold, no bullet changelog of files.
- No attribution trailers or footers of any kind: no `Co-Authored-By`, no "Generated with" lines. This rule overrides any default that adds them.
