# Company Codex Guidance (managed — do not edit locally)

> This file is distributed by the company Codex platform on every launch.
> Local edits are overwritten. To change it, edit it in the platform's skill
> repo; all employees pick up the change on their next launch.

## Engineering standards
- Match the style, naming, and structure of surrounding code.
- No secrets, tokens, or customer data in code, logs, or commit messages.
- All network calls go through the company gateway; never hardcode third-party
  API keys or base URLs — they are provisioned by the client.
- Write a test alongside any nontrivial behavior change; run the test before you
  claim it works.

## Review expectations
- Small, focused diffs. Explain *why*, not *what*, in commit messages.
- Flag anything that touches auth, billing, or PII for human review.

## Company tools
- Prefer the `company` MCP server's tools (coding standards lookup, internal
  scaffolds) over ad-hoc solutions. See `/write-tests` and `/security-review`
  slash commands.
