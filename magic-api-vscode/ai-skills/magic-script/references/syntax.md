# Magic Script Syntax Reference

## Table Of Contents

- Lexical basics
- Keywords
- Types and literals
- Operators
- Control flow
- Lambda and collection operations
- Import, Java access, and object creation
- Async, exit, assert, and casts
- SQL and embedded language strings
- Common syntax pitfalls

## Lexical Basics

- Line comment: `// comment`
- Block comment: `/* comment */`
- Statements usually end at newline or semicolon-compatible boundaries. Keep semicolons when code is dense or chained.
- Identifiers follow Java-like names: letters, digits, `_`, and `$`, not starting with a digit.
- Blocks use `{ ... }`; lists use `[ ... ]`; maps use `{ key: value }`.

## Keywords

Core keywords:

```text
var if else for in while continue break return exit assert instanceof
try catch finally import as new true false null async
```

Implementation notes:

- `var` defines a variable.
- `return` exits the current procedure normally.
- `exit` stops the current script and can return a status/message/body shape.
- `assert` is for validation.
- `import` can import Java classes or modules; `as` binds an alias.
- `async` starts asynchronous execution.

## Types And Literals

Numeric suffixes:

```magic-script
123b    // byte
123s    // short
123     // int
123L    // long
123F    // float
123D    // double
123M    // BigDecimal
```

Strings and regex:

```magic-script
var a = 'single quoted';
var b = "double quoted";
var sql = """
select * from sys_user where id = #{id}
""";
var pattern = /\d+/g;
```

Collections:

```magic-script
var list = [1, 2, 3];
var map = { name: 'admin', enabled: true };
var dynamicKeyMap = { [key]: 'value' };
```

Lambda forms:

```magic-script
var f1 = (x) => x + 1;
var f2 = (x) => { return x + 1; };
var f3 = (x) -> x + 1;
```

## Operators

Arithmetic and assignment:

```text
+ -- + - * / % += -= *= /= %=
```

Comparison and logic:

```text
< <= > >= == != === !== && || ! ?:
```

Bitwise:

```text
& &= | |= ^ ^= ~ ~= << <<= >> >>= >>> >>>=
```

Special operators:

```magic-script
obj?.name              // optional property access
obj?.method(args)      // optional method call
value::int             // cast
value::int(0)          // cast with default
list1 + list2          // depends on runtime type behavior
```

## Control Flow

Conditionals:

```magic-script
if (body.id == null) {
  return { code: 0, message: 'id required' };
} else {
  return db.selectOne('select * from sys_user where id = #{id}');
}
```

Loops:

```magic-script
for (item in list) {
  if (item == null) {
    continue;
  }
}

for (i in 1..10) {
  log.info(i);
}

while (condition) {
  break;
}
```

Try/catch/finally:

```magic-script
try {
  return db.update(sql);
} catch (e) {
  log.error(e);
  throw e;
} finally {
  log.info('done');
}
```

## Lambda And Collection Operations

Common collection operations:

```magic-script
var adults = users.filter(user => user.age >= 18);
var names = users.map(user => user.name);
var grouped = users.group(user => user.department);
```

Mapping to object-like values:

```magic-script
return users.map(user => {
  id: user.id,
  name: user.name,
  enabled: user.status == 1
});
```

Linq-style query syntax appears in magic-api examples. Treat it as a separate grammar mode when writing validators or completions.

## Import, Java Access, And Object Creation

Import Java classes:

```magic-script
import java.util.Date;
import java.math.BigDecimal as Decimal;

var now = new Date();
var amount = new Decimal('12.30');
```

Import modules with aliases when the runtime exposes them:

```magic-script
import db as database;
return database.select('select 1');
```

For diagnostics, do not mark Java members as unknown unless the imported class and member list are known.

## Async, Exit, Assert, And Casts

Async:

```magic-script
async {
  log.info('background work');
}
```

Exit:

```magic-script
exit 200, 'ok', { id: body.id };
```

Assert:

```magic-script
assert body.id != null, 'id required';
```

Casts:

```magic-script
var id = body.id::long;
var count = body.count::int(0);
var day = body.day::date('yyyy-MM-dd');
```

## SQL And Embedded Language Strings

Prefer triple-quoted SQL for multi-line statements:

```magic-script
var user = db.selectOne("""
select *
from sys_user
where id = #{id}
""");
```

Stored procedure examples may use:

```magic-script
#{name}                         // input placeholder
@{outName, INTEGER}             // output placeholder
@{name(value), VARCHAR}         // input/output style placeholder
```

Completion and diagnostics should understand placeholders inside SQL strings but should not treat the whole SQL body as magic-script.

## Common Syntax Pitfalls

- JavaScript assumptions: `let`, `const`, `await`, object spread, destructuring, and promise patterns may not match the target runtime even when highlighting accepts them.
- Null handling: prefer `?.` for uncertain nested request fields.
- Dynamic Java values: a value may be `byte[]`, `List`, `Map`, Java bean, or script map. Review method calls against actual runtime type.
- SQL placeholders: warn when `#{id}` is used but no local/request variable named `id` can be found; keep this as warning because variables can be dynamic.
- Multi-line strings: triple quotes are SQL-friendly; ordinary strings should not silently span lines.
- Map vs block ambiguity: after `return`, a `{ key: value }` expression is a map; after `if (...)`, `{ ... }` is a block.

## Source Refresh Checklist

- Refresh keywords, operators, type literals, optional chaining, spread/cast, imports, async, `exit`, and `assert` from the magic-api script syntax page.
- Refresh lambda and Linq examples from the magic-api Lambda/Linq pages.
- Refresh parser assumptions from the magic-script JVM repository when implementing strict validation.
