Do a security review of the current diff against company rules:

1. Secrets: no hardcoded keys, tokens, passwords, or customer data.
2. Input handling: validate/escape untrusted input; watch for injection.
3. Auth: changes near authentication, key handling, or billing need a callout.
4. Dependencies: flag new third-party packages and why they're needed.

Report findings most-severe first with file:line and a concrete fix.
