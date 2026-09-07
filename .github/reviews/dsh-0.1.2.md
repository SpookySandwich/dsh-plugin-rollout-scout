# DSH 0.1.2-rc.1 compatibility

Reviewed on 2026-09-07; npm latest and next both resolve to 0.1.2-rc.1.

Declare the client services and retain the selected reasoning effort when creating an agent. Treat terminal DSH request errors as errors, pause after three consecutive failures, and keep failed probes out of automatic old-model deletion. Previously, model configuration failures could silently create replacement sessions indefinitely.

## Validation

The complete existing suite plus the new terminal-error regression pass. Official DSH 0.1.2-rc.1 Web checks with an offline adapter cover probe creation, max effort, automatic retention, cold rename, restart persistence and the three-failure breaker. Package checks pass.

The real DSH checks used a new disposable home, locally generated attachments and an offline model, with all four plugins installed together. No existing user conversations or remote model credentials were used. The isolated server was stopped after checks.

Browser interaction acceptance remains pending: the local Chrome test page returned ERR_BLOCKED_BY_CLIENT. Component tests do not substitute for visual acceptance. npm publication is pending final acceptance and registry authentication.
