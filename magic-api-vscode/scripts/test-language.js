"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { MagicScriptCompletionProvider } = require("../src/language/completionProvider");
const { loadLanguageData } = require("../src/language/data");
const { formatMagicScript } = require("../src/language/formattingProvider");
const { MagicScriptHoverProvider } = require("../src/language/hoverProvider");
const { RuntimeIndex } = require("../src/language/runtimeIndex");
const { collectVisibleVariables } = require("../src/language/utils");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const data = loadLanguageData();
  assert(data.modules.db.methods.some((method) => method.label === "selectOne"));
  assert(data.keywords.some((keyword) => keyword.label === "assert"));

  const fixtureRoot = path.resolve(__dirname, "..", "test", "fixtures", "magic-script");
  const formattingFixture = fs.readFileSync(path.join(fixtureRoot, "formatting", "basic.ms"), "utf8");

  assert.deepStrictEqual(collectVisibleVariables("var id = 1;\nusers.map(user => user.id)", undefined, ["body"]).sort(), ["body", "id", "user"].sort());
  assert.strictEqual(formatMagicScript(formattingFixture.trim(), { tabSize: 2 }), "if (ok) {\n  return 1\n}");

  const vscode = createFakeVscode();
  const runtimeIndex = createRuntimeIndex();
  runtimeIndex.javaClassIndex = new Map([["stale", true]]);
  runtimeIndex.failureLogged = true;
  runtimeIndex.clearCache();
  assert.strictEqual(runtimeIndex.javaClassIndex, undefined);
  assert.strictEqual(runtimeIndex.failureLogged, false);
  const provider = new MagicScriptCompletionProvider(vscode, data, runtimeIndex, createWorkspaceIndex());
  const selectOne = data.modules.db.methods.find((method) => method.label === "selectOne");
  const item = provider.toCompletionItem(Object.assign({ source: "static" }, selectOne), 2);
  assert.strictEqual(item.detail, "db.selectOne(sql)");
  assert(String(item.documentation.value).includes("select * from sys_user where id = #{id}"));
  assert(String(item.documentation.value).includes("**参数**"));

  const runtime = await runtimeIndex.getRuntimeSymbols();
  const orderMembers = runtime.membersByReceiver.get("orderService");
  assert(orderMembers.some((method) => method.label === "submitOrder"));
  assert(runtime.globals.some((global) => global.label === "orderService" && global.detail.includes("运行时模块")));

  const completions = await provider.provideCompletionItems(
    createFakeDocument("return orderService."),
    { line: 0, character: "return orderService.".length }
  );
  const submitOrder = completions.find((completion) => completion.label === "submitOrder");
  assert(submitOrder);
  assert.strictEqual(submitOrder.detail, "orderService.submitOrder(payload): Map");
  assert(String(submitOrder.documentation.value).includes("提交订单"));
  assert(String(submitOrder.documentation.value).includes("payload: Map"));

  const orgImports = await provider.provideCompletionItems(
    createFakeDocument("import org"),
    { line: 0, character: "import org".length }
  );
  const orgPackage = orgImports.find((completion) => completion.label === "ssssssss");
  assert(orgPackage);
  assert.strictEqual(orgPackage.insertText, "org.ssssssss");

  const javaClassImports = await provider.provideCompletionItems(
    createFakeDocument("import java.time.L"),
    { line: 0, character: "import java.time.L".length }
  );
  const localDateImport = javaClassImports.find((completion) => completion.label === "LocalDate");
  assert(localDateImport);
  assert.strictEqual(localDateImport.insertText, "java.time.LocalDate");

  const javaClassCompletions = await provider.provideCompletionItems(
    createFakeDocument("import java.time.LocalDate\nreturn LocalDate."),
    { line: 1, character: "return LocalDate.".length }
  );
  const nowCompletion = javaClassCompletions.find((completion) => completion.label === "now");
  assert(nowCompletion);
  assert.strictEqual(nowCompletion.detail, "LocalDate.now(): LocalDate");
  assert(String(nowCompletion.documentation.value).includes("获取当前日期"));

  const wildcardCompletions = await provider.provideCompletionItems(
    createFakeDocument("import java.time.*\nreturn LocalDate."),
    { line: 1, character: "return LocalDate.".length }
  );
  assert(wildcardCompletions.some((completion) => completion.label === "parse"));

  const mailDocument = createFakeDocument([
    "import org.springframework.mail.SimpleMailMessage;",
    "import org.springframework.mail.javamail.JavaMailSenderImpl;",
    "JavaMailSenderImpl mailSender = new JavaMailSenderImpl();",
    "mailSender."
  ].join("\n"));
  const mailCompletions = await provider.provideCompletionItems(
    mailDocument,
    { line: 3, character: "mailSender.".length }
  );
  const setHostCompletion = mailCompletions.find((completion) => completion.label === "setHost");
  assert(setHostCompletion);
  assert.strictEqual(setHostCompletion.detail, "mailSender.setHost(host): void");
  assert(String(setHostCompletion.documentation.value).includes("设置 SMTP 主机"));

  const varMailDocument = createFakeDocument([
    "import org.springframework.mail.javamail.JavaMailSenderImpl;",
    "var mailSender = new JavaMailSenderImpl();",
    "mailSender."
  ].join("\n"));
  const varMailCompletions = await provider.provideCompletionItems(
    varMailDocument,
    { line: 2, character: "mailSender.".length }
  );
  assert(varMailCompletions.some((completion) => completion.label === "setUsername"));

  const hoverProvider = new MagicScriptHoverProvider(vscode, data, runtimeIndex);
  const hover = await hoverProvider.provideHover(createFakeDocument("return db.selectOne('select 1')"), { line: 0, character: 12 });
  assert(hover);
  assert(String(hover.contents.value).includes("db.selectOne(sql)"));
  assert(String(hover.contents.value).includes("select * from sys_user where id = #{id}"));

  const runtimeHover = await hoverProvider.provideHover(createFakeDocument("return orderService.submitOrder(payload)"), { line: 0, character: 24 });
  assert(runtimeHover);
  assert(String(runtimeHover.contents.value).includes("orderService.submitOrder(payload): Map"));
  assert(String(runtimeHover.contents.value).includes("提交订单"));

  const moduleHover = await hoverProvider.provideHover(createFakeDocument("return orderService"), { line: 0, character: 10 });
  assert(moduleHover);
  assert(String(moduleHover.contents.value).includes("Java 类型"));
  assert(String(moduleHover.contents.value).includes("OrderService"));

  const javaHover = await hoverProvider.provideHover(
    createFakeDocument("import java.time.LocalDate\nreturn LocalDate.now()"),
    { line: 1, character: 18 }
  );
  assert(javaHover);
  assert(String(javaHover.contents.value).includes("LocalDate.now(): LocalDate"));
  assert(String(javaHover.contents.value).includes("获取当前日期"));

  const javaClassHover = await hoverProvider.provideHover(
    createFakeDocument("import java.time.LocalDate\nreturn LocalDate.now()"),
    { line: 1, character: 10 }
  );
  assert(javaClassHover);
  assert(String(javaClassHover.contents.value).includes("java\\.time\\.LocalDate") || String(javaClassHover.contents.value).includes("LocalDate"));

  const mailHover = await hoverProvider.provideHover(
    createFakeDocument([
      "import org.springframework.mail.javamail.JavaMailSenderImpl;",
      "JavaMailSenderImpl mailSender = new JavaMailSenderImpl();",
      "mailSender.setPassword('secret')"
    ].join("\n")),
    { line: 2, character: 13 }
  );
  assert(mailHover);
  assert(String(mailHover.contents.value).includes("mailSender.setPassword(password): void"));
  assert(String(mailHover.contents.value).includes("设置 SMTP 密码"));

  console.log("language tests passed");
}

function createFakeVscode() {
  class CompletionItem {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  }
  class MarkdownString {
    constructor() {
      this.value = "";
    }
    appendCodeblock(code, language) {
      this.value += `\n\n\`\`\`${language || ""}\n${code}\n\`\`\``;
    }
    appendMarkdown(text) {
      this.value += text;
    }
  }
  class SnippetString {
    constructor(value) {
      this.value = value;
    }
  }
  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }
  class Hover {
    constructor(contents, range) {
      this.contents = contents;
      this.range = range;
    }
  }
  return {
    CompletionItem,
    CompletionItemKind: {
      Method: 2,
      Function: 3,
      Field: 4,
      Variable: 6,
      Class: 7,
      Module: 9,
      Property: 10,
      Value: 12,
      Keyword: 13,
      Snippet: 14,
      Reference: 18,
      Folder: 19
    },
    MarkdownString,
    SnippetString,
    Position,
    Range,
    Hover
  };
}

function createFakeDocument(text) {
  const lines = text.split(/\r?\n/);
  return {
    getText() {
      return text;
    },
    offsetAt(position) {
      let offset = 0;
      for (let index = 0; index < position.line; index++) {
        offset += (lines[index] || "").length + 1;
      }
      return offset + position.character;
    },
    lineAt(line) {
      return { text: lines[line] || "" };
    }
  };
}

function createWorkspaceIndex() {
  return {
    async getDocumentVariables() {
      return [];
    },
    async getIndex() {
      return { resources: [] };
    }
  };
}

function createRuntimeIndex() {
  return new RuntimeIndex({
    async getClasses() {
      return {
        classes: {
          orderService: {
            className: "com.example.OrderService",
            module: true,
            methods: [
              {
                name: "submitOrder",
                returnType: "java.util.Map",
                comment: "提交订单",
                parameters: [
                  {
                    name: "payload",
                    type: "java.util.Map",
                    comment: "订单参数"
                  }
                ]
              }
            ],
            attributes: [
              {
                name: "enabled",
                type: "boolean"
              }
            ]
          }
        },
        functions: [],
        extensions: {}
      };
    },
    async getClassesText() {
      return [
        "java.time:LocalDate,LocalDateTime",
        "java.util:Date,Map",
        "org.springframework.mail:SimpleMailMessage",
        "org.springframework.mail.javamail:JavaMailSenderImpl",
        "org.ssssssss.demo:OrderService,UserService",
        "org.ssssssss.demo.sub:NestedService"
      ].join("\n");
    },
    async getClass(className) {
      if (className === "java.time.LocalDate") {
        return [
          {
            className,
            methods: [
              {
                name: "now",
                returnType: "java.time.LocalDate",
                comment: "获取当前日期",
                parameters: []
              },
              {
                name: "parse",
                returnType: "java.time.LocalDate",
                comment: "解析日期",
                parameters: [
                  {
                    name: "text",
                    type: "java.lang.CharSequence",
                    comment: "日期文本"
                  }
                ]
              }
            ]
          }
        ];
      }
      if (className === "org.springframework.mail.javamail.JavaMailSenderImpl") {
        return [
          {
            className,
            methods: [
              {
                name: "setHost",
                returnType: "void",
                comment: "设置 SMTP 主机",
                parameters: [
                  {
                    name: "host",
                    type: "java.lang.String",
                    comment: "SMTP 主机"
                  }
                ]
              },
              {
                name: "setPort",
                returnType: "void",
                comment: "设置 SMTP 端口",
                parameters: [
                  {
                    name: "port",
                    type: "int",
                    comment: "SMTP 端口"
                  }
                ]
              },
              {
                name: "setPassword",
                returnType: "void",
                comment: "设置 SMTP 密码",
                parameters: [
                  {
                    name: "password",
                    type: "java.lang.String",
                    comment: "SMTP 密码"
                  }
                ]
              },
              {
                name: "setUsername",
                returnType: "void",
                comment: "设置 SMTP 用户名",
                parameters: [
                  {
                    name: "username",
                    type: "java.lang.String",
                    comment: "SMTP 用户名"
                  }
                ]
              }
            ]
          }
        ];
      }
      return [];
    }
  }, { appendLine() {} });
}
