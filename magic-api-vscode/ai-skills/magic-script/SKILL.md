---
name: magic-script
description: Write, review, debug, refactor, or generate magic-api magic-script scripts and VS Code language-service guidance. Use for .ms files, magic-api API/function scripts, db/request/response/http/env/log modules, MagicScript syntax, SQL snippets inside scripts, completion/diagnostic rules, or AI coding assistance for magic-api.
---

# Magic Script

## Core Workflow

1. Identify whether the task is script authoring, script review/debugging, magic-api module usage, or editor language-service work.
2. Read the smallest useful reference:
   - `references/syntax.md` for grammar, operators, literals, lambdas, imports, async, casts, and control flow.
   - `references/magic-api-api.md` for magic-api modules, functions, runtime objects, configuration, and workspace/server context.
   - `references/authoring-checklist.md` for AI review, generation, diagnostics, and completion-quality rules.
3. Prefer code that is valid magic-script over JavaScript-like guesses. Magic-script is JVM-based and used by magic-api, but it is not JavaScript.
4. When runtime types are dynamic, state assumptions explicitly and avoid overconfident diagnostics.
5. For repository work, prefer the local magic-api workspace mirror files over read-only virtual resources.

## Script Authoring Rules

- Use `var` for local variables unless existing code uses another accepted style.
- Treat `db` as a default imported module in magic-api scripts.
- Use triple-quoted strings for multi-line SQL and keep SQL parameters explicit with `#{name}` style placeholders.
- Use optional chaining (`?.`) when a request object or nested field may be absent.
- Prefer `return` for normal API responses; use `exit` only when the script should stop immediately with a custom status/body.
- Use `assert` for parameter validation when the target runtime supports it.
- Keep Java imports explicit with `import ... as ...` when aliases improve readability.

## Review And Debug Rules

- Check syntax first: braces, quotes, comments, lambda arrows, ternary expressions, and imports.
- Then check magic-api context: API metadata, request parameters, response wrapper, datasource availability, and configured auto imports.
- Then check dynamic runtime risks: Java object methods, byte arrays vs strings, null values, SQL placeholder names, and transaction control.
- For diagnostics, distinguish hard syntax errors from low-confidence semantic warnings. Do not flag dynamic Java/member access as an error unless the type is known.

## Editor Language-Service Rules

- Use completion data from three layers: static syntax, magic-api runtime introspection, and local workspace index.
- Build diagnostics from a tolerant parser first, then runtime-aware checks. Avoid regex-only syntax validation as the long-term design.
- Surface signatures, hover docs, and code actions from the same language-data source used for completions.
- Keep AI suggestions compatible with the extension's local workspace mirror so tools can read the same files as the editor.
