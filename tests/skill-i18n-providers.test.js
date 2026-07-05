const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  translateOpenAI,
  translateAnthropic,
  resolveProvider,
  parseJsonObjectLoose,
  placeholdersMatch,
} = require("../plugin/skill-i18n/translate");

function startServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const r = handler(req, body);
        res.writeHead(r.status || 200, { "Content-Type": "application/json" });
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      });
    });
    s.listen(0, () => resolve(s));
  });
}

test("resolveProvider: auto/claude/openai/anthropic", () => {
  assert.equal(resolveProvider({ provider: "auto" }), "claude");
  assert.equal(resolveProvider({ provider: "claude" }), "claude");
  assert.equal(resolveProvider({ provider: "openai" }), "openai");
  assert.equal(resolveProvider({ provider: "anthropic" }), "anthropic");
  assert.equal(resolveProvider({}), "claude");
});

test("parseJsonObjectLoose: 纯 JSON / 带 fence / 带散文", () => {
  assert.deepEqual(parseJsonObjectLoose('{"a":"1"}'), { a: "1" });
  assert.deepEqual(parseJsonObjectLoose("```json\n{\"a\":\"1\"}\n```"), { a: "1" });
  assert.deepEqual(parseJsonObjectLoose('Sure! {"a":"1"} done'), { a: "1" });
  assert.equal(parseJsonObjectLoose("no json here"), null);
});

test("placeholdersMatch: ${...} 占位符校验（丢占位符则拒绝译文）", () => {
  assert.equal(placeholdersMatch("Use ${X} and ${Y}", "使用 ${X} 和 ${Y}"), true);
  assert.equal(placeholdersMatch("Use ${X}", "使用 X"), false); // 丢了 ${}
  assert.equal(placeholdersMatch("no placeholders", "无占位符"), true);
  assert.equal(placeholdersMatch("${A}", "${B}"), false); // 占位符内容变了
  assert.equal(placeholdersMatch("$ARGUMENTS and ${1}", "$ARGUMENTS 与 ${1}"), true);
  assert.equal(placeholdersMatch("Run $ARGUMENTS now", "现在运行"), false); // 丢裸 $ARGUMENTS
  assert.equal(placeholdersMatch("Use $1 and $2", "用 $1 和 $2"), true); // 裸 $N 保留
});

test("translateOpenAI: 解析 chat/completions 响应", async () => {
  const s = await startServer(() => ({
    body: { choices: [{ message: { content: '{"1":"你好","2":"世界"}' } }] },
  }));
  const port = s.address().port;
  try {
    const map = await translateOpenAI(
      [{ id: "1", en: "Hello" }, { id: "2", en: "World" }],
      { baseUrl: `http://localhost:${port}/v1`, model: "gpt-4" },
      "fake-key"
    );
    assert.equal(map["1"], "你好");
    assert.equal(map["2"], "世界");
  } finally { s.close(); }
});

test("translateOpenAI: 校验 Authorization 头 + 请求路径 + model", async () => {
  let seen = {};
  const s = await startServer((req, body) => {
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    return { body: { choices: [{ message: { content: '{"1":"x"}' } }] } };
  });
  const port = s.address().port;
  try {
    await translateOpenAI([{ id: "1", en: "Hi" }], { baseUrl: `http://localhost:${port}/v1`, model: "m" }, "mykey");
    assert.equal(seen.path, "/v1/chat/completions");
    assert.equal(seen.auth, "Bearer mykey");
    assert.equal(seen.body.model, "m");
  } finally { s.close(); }
});

test("translateAnthropic: 解析 messages 响应", async () => {
  const s = await startServer(() => ({
    body: { content: [{ type: "text", text: '{"1":"你好"}' }] },
  }));
  const port = s.address().port;
  try {
    const map = await translateAnthropic(
      [{ id: "1", en: "Hello" }],
      { baseUrl: `http://localhost:${port}`, model: "claude-3" },
      "fake-key"
    );
    assert.equal(map["1"], "你好");
  } finally { s.close(); }
});

test("translateAnthropic: 校验 x-api-key + anthropic-version + 路径 + system", async () => {
  let seen = {};
  const s = await startServer((req, body) => {
    seen = {
      path: req.url,
      key: req.headers["x-api-key"],
      ver: req.headers["anthropic-version"],
      body: JSON.parse(body),
    };
    return { body: { content: [{ type: "text", text: '{"1":"x"}' }] } };
  });
  const port = s.address().port;
  try {
    await translateAnthropic([{ id: "1", en: "Hi" }], { baseUrl: `http://localhost:${port}`, model: "glm-4" }, "glmkey");
    assert.equal(seen.path, "/v1/messages");
    assert.equal(seen.key, "glmkey");
    assert.equal(seen.ver, "2023-06-01");
    assert.ok(seen.body.system.length > 0, "应有 system prompt");
    assert.equal(seen.body.model, "glm-4");
  } finally { s.close(); }
});

test("translateOpenAI: 4xx 错误抛出", async () => {
  const s = await startServer(() => ({ status: 401, body: { error: "bad key" } }));
  const port = s.address().port;
  try {
    await assert.rejects(
      translateOpenAI([{ id: "1", en: "x" }], { baseUrl: `http://localhost:${port}/v1`, model: "m" }, "k")
    );
  } finally { s.close(); }
});

test("translateOpenAI: 缺 key 抛错（不发起请求）", async () => {
  await assert.rejects(
    translateOpenAI([{ id: "1", en: "x" }], { model: "m" }, ""),
    /API_KEY/
  );
});

test("translateAnthropic: 缺 model 抛错", async () => {
  await assert.rejects(
    translateAnthropic([{ id: "1", en: "x" }], { baseUrl: "http://localhost:1" }, "k"),
    /MODEL/
  );
});
