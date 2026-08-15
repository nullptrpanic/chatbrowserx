# Security Policy

## Security boundaries

ChatBrowserX treats every webpage, model response, Tavily result, runtime message, stored record, and browser target as untrusted until validated at its boundary.

- Page scripts never receive Codex or Tavily credentials, full task records, or attachment bytes.
- Credentials live only in trusted extension storage and are projected to UI as presence booleans.
- Codex and Tavily endpoints are fixed in code; arbitrary Provider URLs are unsupported.
- Browser tools accept only strict structured actions. There is no JavaScript evaluation, remote script, network recorder, desktop control, or plugin execution path.
- A browser command is not successful until its declared effect is independently verified.
- High-risk actions require a digest-bound user confirmation. Unknown high-risk outcomes are not automatically replayed.
- Persisted leases and checkpoints prevent two workers from deliberately executing the same safe task concurrently.
- Page text and tool output are explicitly marked untrusted in model context and cannot override system policy, permissions, budgets, or confirmation rules.

## Credentials and diagnostics

Do not put real Access Tokens, Tavily keys, cookies, request headers, screenshots, page text, or Playwright profiles in issues, tests, traces, benchmark reports, or commits. Provider HTTP errors discard bounded bodies and expose only normalized codes. Production bundle audit rejects embedded credential shapes and source maps.

## Permissions

The fixed required permissions are `activeTab`, `alarms`, `debugger`, `scripting`, `sidePanel`, `storage`, and `tabs`. Web access is optional and requested per HTTP(S) origin. Required host permissions are limited to fixed Codex and Tavily services.

`debugger` is used only for page observation, real input, iframe sessions, navigation verification, and target resolution. It is not used for general traffic capture.

## Unsupported guarantees

ChatBrowserX cannot guarantee safe automation on adversarial pages, CAPTCHA/2FA challenges, browser-protected pages, or every website. Model output is nondeterministic. Users must review confirmation cards and retain responsibility for consequential actions.

## Reporting a vulnerability

Report vulnerabilities privately through the GitHub repository's security-advisory channel. Include the affected version, a minimal reproduction, and sanitized standard error codes. Never include live credentials or private page content. Do not open a public issue before a credential or high-risk-action vulnerability has been triaged.
