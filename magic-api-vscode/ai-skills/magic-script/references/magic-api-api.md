# Magic API Runtime Reference

## Table Of Contents

- Runtime context
- Default modules
- Database module
- Request and response context
- HTTP, log, env, and magic modules
- Functions and extensions
- Configuration that affects scripts
- VS Code extension data sources

## Runtime Context

magic-api scripts run in a server context, not as standalone JavaScript. The useful context normally includes:

- API metadata: method, path, group, name, description.
- Request values: path/query/body/header/cookie/session values, depending on configuration and runtime.
- Runtime modules: `db`, `request`, `response`, `http`, `log`, `env`, and optional custom modules.
- Java access: auto imported packages and explicit imports.
- Workspace resources: API scripts, function scripts, datasources, and resource metadata.

When generating code, avoid inventing project-specific globals unless the open file, workspace manifest, server `/classes`, or configuration proves they exist.

## Default Modules

Common built-in module names:

```text
db request response http log env magic
```

`db` is documented as default imported in magic-api. Other modules should be suggested when available in docs, `/classes`, or workspace/server metadata.

## Database Module

Common `db` methods to complete and document:

| Method | Typical purpose | Result shape |
| --- | --- | --- |
| `select(sql)` | Query multiple rows | `List<Map<String,Object>>` |
| `selectInt(sql)` | Query one integer value | `Integer` |
| `selectOne(sql)` | Query one row | `Map<String,Object>` |
| `selectValue(sql)` | Query one scalar | `Object` |
| `page(sql, limit?, offset?)` | Page query | runtime page object |
| `update(sql)` | Execute insert/update/delete SQL | affected rows |
| `insert(sql, id?)` | Execute insert and return generated key/value | `Object` |
| `call(sql)` | Call stored procedure | `Map<String,Object>` |
| `batchUpdate(sql, batchArgs)` | Batch update | `int` |
| `cache(cacheName, ttl?)` | Enable chained query cache | `db` |
| `deleteCache(cacheName)` | Remove named cache | side effect |
| `transaction(callback?)` | Transaction block or manual transaction | callback result or transaction object |

Examples:

```magic-script
var id = body.id;
return db.selectOne("""
select *
from sys_user
where id = #{id}
""");
```

```magic-script
return db.transaction(() => {
  db.update("""
  update sys_user set name = #{name} where id = #{id}
  """);
  return db.selectOne('select * from sys_user where id = #{id}');
});
```

Diagnostics:

- Warn when SQL placeholders cannot be matched to visible variables or common request roots.
- Treat chained `db.cache(...).select(...)` as valid.
- Treat manual `tx.commit()` and `tx.rollback()` as valid members of a transaction object.

## Request And Response Context

Common request data roots:

```text
path query body header cookie session request
```

Common response actions:

```text
response.json response.text response.redirect response.download response.cookie response.header
```

Project conventions vary. For review and diagnostics, prefer warning-level hints until the server `/classes` or workspace data confirms exact members.

## HTTP, Log, Env, And Magic Modules

Common HTTP members:

```text
http.get http.post http.put http.delete http.patch http.header http.body http.execute
```

Common log members:

```text
log.debug log.info log.warn log.error
```

Common env members:

```text
env.get env.getProperty
```

The `magic` module can expose magic-api-specific helpers. Prefer runtime `/classes` data for exact member lists.

## Functions And Extensions

magic-api documents function categories such as aggregate, date, string, array, math, and other functions, plus extensions for Object, Number, array/collection, Date, Class, and Pattern.

Completion rules:

- Global function completions come from static docs plus `/classes.functions`.
- Member completions come from static extensions plus `/classes.extensions`.
- For dynamic receiver types, show lower-confidence member suggestions without hard diagnostics.

## Configuration That Affects Scripts

Important configuration keys:

```yaml
magic-api:
  prefix: /
  web: /magic/web
  resource:
    type: file|database|redis
    location: /data/magic-api
    readonly: false
  auto-import-module: db
  auto-import-package: java.lang.*,java.util.*
  allow-override: false
  response: |-
    { code: code, message: message, data }
  debug:
    timeout: 60
```

Editor/language behavior should consider:

- `auto-import-module`: modules available without explicit import.
- `auto-import-package`: Java classes available without full qualification.
- `response`: response wrapper shape, useful for hover and examples.
- `prefix`: final request URL for run/debug UI.
- `resource.readonly`: whether server-side resource updates are allowed.

## VS Code Extension Data Sources

Use these sources in priority order:

1. Open document content: unsaved text is authoritative for diagnostics.
2. Local workspace mirror manifest: API/function/datasource metadata and stable paths.
3. Runtime server data: `/classes`, `/config.json`, `/resource`, and file detail endpoints.
4. Static language data generated from magic-api docs and curated references.

Completion and diagnostics should keep the source attached to each item, for example `static`, `workspace`, `server`, or `inferred`, so UI details can explain confidence.

## Source Refresh Checklist

- Refresh module signatures from magic-api API pages.
- Refresh configuration keys from Spring Boot and editor configuration pages.
- Refresh server endpoint assumptions from the local extension client and magic-api backend controllers.
- Refresh exact Java parser/semantic behavior from the magic-script repository before implementing strict syntax validation.
