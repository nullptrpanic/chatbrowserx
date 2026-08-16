# Security Policy

## Security boundaries

- Page scripts never receive the Codex credential, task repository, or attachment bytes.
- The trusted Settings screen can explicitly load the stored Access Token; page/content-script senders are rejected by the settings message boundary.
- The Codex endpoint and model are fixed. Arbitrary Provider URLs are unsupported.
- The production Planner registers no concrete tools, and the page command boundary accepts only screenshot/selection support commands.
- There is no JavaScript evaluation, remote script execution, browser action executor, search/crawl provider, network recorder, or desktop-control path.
- Persisted leases prevent two workers from running the same model task concurrently.
- Model input is built only from the current task's user message and its explicit image references.

Generic Provider tool types remain as an extension interface. They do not register a tool or authorize execution. Any future concrete tool requires a separate reviewed implementation and production audit update.

## Credentials and diagnostics

Never put real Access Tokens, cookies, request headers, screenshots, selected text, or private page content in issues, tests, traces, benchmark reports, or commits. Provider HTTP errors discard bounded bodies and expose only normalized codes. The production bundle audit rejects embedded credential shapes, source maps, concrete-tool residue, debugger calls, and excluded media features.

## Permissions

The fixed permissions are `activeTab`, `alarms`, `scripting`, `sidePanel`, `storage`, and `tabs`; required host access is `<all_urls>`. Page access is used for explicit screenshots and selection UI. The extension neither declares nor invokes `chrome.debugger`.

## Reporting a vulnerability

Report vulnerabilities privately through the GitHub repository's security-advisory channel. Include the affected version, a minimal reproduction, and sanitized error codes. Never include live credentials or private page content.
