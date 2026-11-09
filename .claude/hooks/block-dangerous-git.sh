#!/bin/bash
# PreToolUse guardrail (from the git-guardrails-claude-code skill, adapted):
# work reaches main only through a pull request the maintainer merges.
# Pushing feature and integration branches is allowed.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

block() {
  echo "BLOCKED: '$COMMAND' $1. The maintainer has prevented you from doing this; open or update a pull request instead." >&2
  exit 2
}

DANGEROUS_PATTERNS=(
  "push --force"
  "push -f( |$)"
  "--force-with-lease"
  "reset --hard"
  "git clean -f"
  "git branch -D"
  "git checkout \.( |$)"
  "git restore \.( |$)"
  "gh pr merge"
  "update-ref .*refs/heads/(main|master)"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE -- "$pattern"; then
    block "matches dangerous pattern '$pattern'"
  fi
done

if echo "$COMMAND" | grep -qE "git( -C [^ ]+)? push"; then
  # An explicit main or master ref anywhere in the push.
  if echo "$COMMAND" | grep -qE "push.*([ :+]|refs/heads/)(main|master)( |$|:)"; then
    block "pushes to main"
  fi
  # A bare push while main is checked out.
  BRANCH=$(git -C "${CWD:-.}" branch --show-current 2>/dev/null)
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
    if ! echo "$COMMAND" | grep -qE "push +(-u +|--set-upstream +)?[^ -][^ ]* +[^ ]+"; then
      block "pushes from main"
    fi
  fi
fi

exit 0
