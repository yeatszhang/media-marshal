import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { newSession, runHome } from "./session-store.ts";
import { readLogs, recentLogs } from "./log-reader.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "marshal-agent-log-"));
  const session = await newSession(root, {
    scenario: "empty",
    seed: "default",
    mode: "background",
    target: "development",
  });
  const directory = join(runHome(root, session.profileRunId), "data/logs");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "desktop.log");
  const row = (fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      sessionId: session.sessionId,
      level: 40,
      process: "core",
      event: "测试事件",
      msg: "中文日志",
      ...fields,
    }) + "\n";
  return {
    root,
    session,
    path,
    directory,
    row,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("UTF-8 分页按字节续读，签名与过滤条件绑定且投影不泄露载荷", async () => {
  const f = await fixture();
  try {
    const operationId = randomUUID(),
      requestId = randomUUID();
    await writeFile(
      f.path,
      f.row({ msg: "第一条中文" }) +
        f.row({
          msg: "Authorization: Bearer 秘密",
          operationId,
          requestId,
          payload: { password: "载荷秘密" },
          error: {
            type: "Error",
            message: "原始秘密",
            stack: "Error: 原始秘密\n    at method (bundle.js:1:2)",
          },
        }),
    );
    const first = await readLogs(f.root, f.session.sessionId, { limit: 1 });
    assert.equal(first.records.length, 1);
    assert.equal(first.hasMore, true);
    assert.ok(first.cursor && first.cursor.length <= 200);
    const second = await readLogs(f.root, f.session.sessionId, { limit: 1, cursor: first.cursor });
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]!.requestId, requestId);
    assert.equal((second.records[0]!.error as { locationKind: string }).locationKind, "generated");
    assert.equal(JSON.stringify(second).includes("秘密"), false);
    assert.equal(second.integrity.historyComplete, false);
    await appendFile(f.path, f.row({ event: "第三条" }));
    const next = await readLogs(f.root, f.session.sessionId, { limit: 20, cursor: second.cursor });
    assert.deepEqual(
      next.records.map((row) => row.event),
      ["第三条"],
    );
    await assert.rejects(
      readLogs(f.root, f.session.sessionId, {
        limit: 1,
        cursor: first.cursor!.slice(0, -2) + "xx",
      }),
      /游标/,
    );
    await assert.rejects(
      readLogs(f.root, f.session.sessionId, { limit: 1, cursor: first.cursor, operationId }),
      /游标/,
    );
    const filtered = await readLogs(f.root, f.session.sessionId, { limit: 20, operationId });
    assert.equal(filtered.records.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("轮转后继续按 inode 读取，历史删除及同 inode 改写明确报告缺口", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, f.row({ event: "旧" }));
    const old = await readLogs(f.root, f.session.sessionId, { limit: 20 });
    await rename(f.path, f.path + ".1");
    await writeFile(f.path, f.row({ event: "新" }));
    const rotated = await readLogs(f.root, f.session.sessionId, { limit: 20, cursor: old.cursor });
    assert.deepEqual(
      rotated.records.map((row) => row.event),
      ["新"],
    );
    assert.equal(rotated.integrity.reasons.includes("CURSOR_HISTORY_GAP"), false);
    await rm(f.path + ".1");
    const lost = await readLogs(f.root, f.session.sessionId, { limit: 20, cursor: old.cursor });
    assert.equal(lost.integrity.reasons.includes("CURSOR_HISTORY_GAP"), true);
    await writeFile(f.path, f.row({ event: "被改写" }));
    const replaced = await readLogs(f.root, f.session.sessionId, {
      limit: 20,
      cursor: rotated.cursor,
    });
    assert.equal(replaced.integrity.reasons.includes("CURSOR_HISTORY_GAP"), true);
  } finally {
    await f.cleanup();
  }
});
test("部分行等完整后才解析，超长行与限流记录不会伪报完整", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, f.row() + '{"sessionId":"');
    const first = await readLogs(f.root, f.session.sessionId, { limit: 20 });
    assert.equal(first.records.length, 1);
    assert.equal(first.integrity.reasons.includes("PARTIAL_TAIL"), true);
    await appendFile(f.path, f.session.sessionId + '","level":40,"event":"补全","msg":"内容"}\n');
    const completed = await readLogs(f.root, f.session.sessionId, {
      limit: 20,
      cursor: first.cursor,
    });
    assert.equal(completed.records.length, 1);
    assert.equal(completed.records[0]!.event, "补全");
    await appendFile(
      f.path,
      "x".repeat(70000) +
        "\n" +
        f.row({ event: "logging.dropped", dropCount: 20, dropReason: "RATE_LIMIT" }),
    );
    const broken = await readLogs(f.root, f.session.sessionId, {
      limit: 20,
      cursor: completed.cursor,
    });
    assert.equal(broken.integrity.reasons.includes("OVERSIZED_LINE"), true);
    assert.equal(broken.integrity.reasons.includes("REPORTED_DROPS"), true);
  } finally {
    await f.cleanup();
  }
});
test("缺少日志与路径链接保持不可观察，不读取其他实例", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "other.log");
    await writeFile(outside, "个人秘密");
    await symlink(outside, f.path);
    await assert.rejects(readLogs(f.root, f.session.sessionId, { limit: 20 }), /路径/);
    await rm(f.path);
    const unavailable = await readLogs(f.root, f.session.sessionId, { limit: 20 });
    assert.deepEqual(unavailable.records, []);
    assert.equal(unavailable.integrity.historyComplete, false);
  } finally {
    await f.cleanup();
  }
});

test("诊断使用有界尾部最近警告，未知调用栈明确未映射", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.path,
      Array.from({ length: 80 }, (_, index) =>
        f.row({
          event: `failure-${index}`,
          error: { type: "Error", stack: "没有可信调用帧的秘密" },
        }),
      ).join(""),
    );
    const recent = await recentLogs(f.root, f.session.sessionId, { limit: 2, level: "warn" });
    assert.deepEqual(
      recent.records.map((row) => row.event),
      ["failure-78", "failure-79"],
    );
    assert.equal((recent.records[0]!.error as { locationKind: string }).locationKind, "unknown");
    assert.equal(JSON.stringify(recent).includes("秘密"), false);
    assert.equal(recent.integrity.historyComplete, false);
  } finally {
    await f.cleanup();
  }
});
