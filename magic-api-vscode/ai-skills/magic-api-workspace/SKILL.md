---
name: magic-api-workspace
description: Operate every non-visual magic-api VS Code workspace capability through the standardized workspace-scoped CLI, including connection and authentication status, local mirror inspection, nested groups, API/function/task/script CRUD, metadata, validation, automatic push/pull/recovery, deployed API requests, and managed Skill updates. Use for magic-api 工作区增删查改, `.magic-api-workspace`, manifest v3, automatic synchronization, journal recovery, `magic-token` requests, or sandbox access to the VS Code bridge.
---

# Magic API Workspace

## Core workflow

1. Locate the current workspace mirror root from `magicApi.workspaceDir`; default to `.magic-api-workspace`. Never reuse another workspace's connection, username, Token, manifest, or journal.
2. Use only `scripts/magic-api.js`. Read `references/cli.md` when selecting commands or parameters. Do not hand-build `.ms/.magic.json` pairs or edit manifest.
3. Run every mutation once without `--apply`. Inspect its JSON `planId`, files, resource IDs, remote effects, risk, and warnings.
4. If the current user task authorizes that change, rerun the identical command with `--apply --plan-id <id>`. Do not alter arguments between preview and apply.
5. Add `--sync` to individual group/resource mutations. The CLI must validate, push, reload, and incrementally pull canonical state automatically. After a batch of direct file edits, preview and apply `workspace reconcile` yourself; never instruct the user to click push or sync.
6. Finish with `workspace status` and `workspace validate`. Report completion only when no pending path or journal remains and the server-backed reconcile succeeded.

Use this stable entrypoint:

```bash
node .codex/skills/magic-api-workspace/scripts/magic-api.js \
  <domain> <action> --root <mirror-root>
```

Run `schema` for the machine-readable interface. The legacy `magic-api-workspace.js` and `magic-api-request.js` scripts are compatibility-only.

## Automatic execution

- Treat a returned `planId` as bound to the current workspace, server URL, manifest, files, and operation arguments. A mismatch, expired bridge plan, or repeated plan must be previewed again.
- Apply planned creates, updates, deletes, pulls, pushes, and conflict overwrites without asking the user to perform a VS Code command. The resource list in the preview is the execution boundary.
- Stop on `status=blocked`. Preserve journal and local files, present the candidate IDs and evidence, and never guess when the service cannot uniquely identify an unknown request result.
- The backend is not transactional. Resume only through `workspace recover` or `workspace reconcile`; never delete journal records manually or blindly resend a result-unknown create.
- Keep moves and renames explicit. If validation reports an ambiguous create/delete mixture, split it into stable-ID operations rather than interpreting filesystem movement.

## Connection and secrets

- Use `connection show` and `auth status` to inspect the current workspace. They may reveal the server URL, username, behavior settings, and whether a Token exists; they never reveal the Token value.
- Trigger `auth login` or `auth set-token` when authentication is missing. The extension collects credentials through VS Code password inputs; do not request, echo, persist, or log them.
- Require the running extension for connection, auth, remote workspace, resource tree, request, and Skill commands. Pure local CRUD/status/validate commands remain available offline.
- Keep all server access same-origin. The extension injects the exact lowercase `magic-token` header from the current workspace SecretStorage.
- Use `request preview`, then `request send` with its matching plan. Keep console access on the read-only whitelist; use resource/workspace commands for console mutations.

## Sandbox and host execution

- Preview in the current sandbox first. If the CLI returns `vscode-workspace-unavailable`, `EACCES`, `EPERM`, inaccessible system temp files, or loopback bridge failure, request minimal host execution for the same `node .../magic-api.js` command.
- Preserve the exact root, command, arguments, URL, method, body, and plan ID. Host execution does not authorize changing the plan or adding an apply/send flag that was not already intended.
- Never use `sudo`, root, broad shell prefixes, copied tokens, another workspace's descriptor, or direct credentials. Platform approval remains authoritative.

## Resource invariants

- Address synchronized resources by manifest ID and unsynchronized resources by the CLI's `local:<hash>` reference. Never guess IDs or group IDs.
- Keep group path and resource path separate. Group paths use `admin/user`; API paths start with `/`; Function, Task, Script, and Component paths do not.
- Treat script resources as an inseparable `.ms + .magic.json` pair. Use metadata patch files for advanced updates; the shared core preserves unknown fields and rejects server-owned identity fields.
- Create Script only when that dynamic type was discovered from the server. Do not delete, move, or rename groups.
- Treat `validate` failures, server URL mismatch, symlinks, path traversal, incomplete pairs, and ambiguous remote matches as hard stops.
