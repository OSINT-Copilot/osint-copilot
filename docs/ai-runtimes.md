# AI runtimes and data flow

OSINT Copilot does not bundle a model or call an AI API directly. Chat, extraction, and task
agents launch a command-line runtime that you install and authenticate separately. The rest of
the application works without AI.

Configure runtimes under **Settings → OSINT Copilot**. Supported adapters include Claude Code,
Codex CLI, Hermes, and a custom command that reads a prompt from standard input and writes its
answer to standard output.

## What a runtime may receive

Depending on the action, the app can pass the runtime:

- your request and the app's system instructions;
- selected notes, attachments, images, prompts, and skills;
- a configured number of contextual investigation notes; and
- the investigation directory as its working directory.

The CLI may therefore be able to read more than the text visible in chat. Its network traffic,
retention, training, and account behavior are governed by that CLI and its provider, not by
OSINT Copilot. Review the provider's terms and the runtime's local permissions before using it
with sensitive material.

## Guardrails

Proposed entity and vault changes require approval in the UI. Task-agent writes must satisfy
both the agent's output allowlist and the global allowlist. Enrichers run only after approval,
use a domain allowlist, and apply main-process network guards. These controls reduce accidental
writes and requests; they are not a guarantee that model output is correct or safe.

Enricher API keys are plain files under `OSINTCopilot/custom/credentials/`. Do not sync or share
that folder. Debug options can expose raw model output in logs or the UI.
