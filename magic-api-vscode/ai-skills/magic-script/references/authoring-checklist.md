# Magic Script AI Authoring Checklist

## Table Of Contents

- Before writing code
- Code generation defaults
- Review checklist
- Debug checklist
- Completion checklist
- Diagnostics checklist
- AI interaction rules

## Before Writing Code

1. Identify resource type: API, function, datasource, or another magic-api resource.
2. Inspect nearby scripts and metadata before inventing path, method, datasource, or response conventions.
3. Prefer local workspace mirror files when available because external AI/editor tools can read them directly.
4. Identify available modules from `/classes`, configuration, and static docs.
5. Ask for missing business rules only when guessing would change behavior.

## Code Generation Defaults

- Use `var` variables.
- Use `body`, `path`, `query`, `header`, `cookie`, and `session` only when the script context or existing project convention supports them.
- Use `db.selectOne` for one row, `db.select` for lists, `db.page` for paginated lists, and `db.update` for writes.
- Use `db.transaction(() => { ... })` for multiple dependent writes.
- Use triple-quoted SQL for multi-line statements.
- Keep request validation near the top.
- Return plain maps/objects unless the project response wrapper requires another shape.

Example:

```magic-script
var id = body.id;
assert id != null, 'id required';

return db.selectOne("""
select id, name, status
from sys_user
where id = #{id}
""");
```

## Review Checklist

- Syntax: balanced brackets, quote style, map vs block ambiguity, lambda arrow, ternary shape.
- Imports: Java imports valid, aliases used consistently, module imports not duplicating auto imports.
- Variables: request params validated before use; SQL placeholders match variables.
- Database: correct `db` method for result cardinality; transaction boundaries are explicit.
- Null safety: nested dynamic values use `?.` where appropriate.
- Runtime type: Java arrays, byte arrays, maps, lists, and beans are not treated as strings without conversion.
- Response: return shape matches project convention or configured response wrapper.

## Debug Checklist

- If a method is missing at runtime, identify the actual JVM type first.
- If SQL fails, compare placeholder names with variables and request body fields.
- If changes do not take effect, confirm the resource was pushed and server cache was reloaded.
- If completion/diagnostic output is wrong, identify whether the item came from static docs, `/classes`, workspace index, or inference.

## Completion Checklist

Good completions should include:

- Keywords, literals, operators, and snippets from static syntax.
- Module names and documented methods.
- `/classes` functions/classes/extensions with source labels.
- Workspace API/function paths and datasource keys.
- Signature details: parameter names, optional parameters, return shape, and examples.
- Context filters: after `db.` show database members first; inside SQL placeholders suggest visible variables and request fields; after `import` suggest Java packages/classes when known.

Avoid:

- Huge flat lists with no ranking.
- Unknown dynamic members marked as certain.
- Suggestions that insert invalid JavaScript syntax.

## Diagnostics Checklist

Hard errors:

- Unterminated string or block comment.
- Unbalanced brackets in the parsed region.
- Invalid import shape.
- Clearly invalid token sequence for known syntax.

Warnings:

- Unknown module/member when runtime data is available.
- SQL placeholder has no visible matching variable.
- API path/method metadata inconsistent with workspace manifest.
- Potential null dereference when optional chaining is absent.

Hints:

- Prefer `db.selectOne` when code selects one row and then indexes `[0]`.
- Prefer transaction wrapper for multiple dependent writes.
- Prefer triple-quoted SQL for long SQL.

Do not diagnose as errors:

- Java member access on unknown imported classes.
- Dynamic maps/beans with runtime-only fields.
- Project-specific globals that may be injected by custom modules.

## AI Interaction Rules

- When explaining code, identify magic-script constructs separately from Java/magic-api runtime constructs.
- When generating code, include only the script body unless the user asks for metadata.
- When proposing editor improvements, tie every completion or diagnostic to a data source and confidence level.
- When uncertain, produce a conservative script and list the runtime assumptions.
