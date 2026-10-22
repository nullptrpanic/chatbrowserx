# Delayed, virtualized batch workspace

Run `./node_modules/.bin/tsx e2e/fixtures/batch-workspace.ts` to serve a disposable public UI at
`http://127.0.0.1:43871`. Stop the process to discard the synthetic state; restarting resets it.
It has no authentication and contains no user data.

This is an ordinary test webpage, not an alternate execution harness: use a self-contained sample
and the doctor, standalone verification and shared live runner described in `../RUNBOOK.md`.
The real Provider chooses every operation through the built production extension. No response or
tool sequence is scripted.

Alpha, Beta and Gamma start at Root, alongside Hold. Archive contains 24 existing rows and only
mounts the visible window. Moves complete asynchronously. Opening `/?item=Alpha` (or another
item name) reveals that item at its current parent, including after reload, enabling independent
`finalPageStates` assertions. A useful task moves the three named items, excludes Hold and checks
the actual parent of each. Reading a partial Archive window alone cannot establish absence.

Do not run overlapping attempts against the same process. The fixture is not a performance or
cross-site stability benchmark; it covers delayed writes and offscreen postcondition verification.
