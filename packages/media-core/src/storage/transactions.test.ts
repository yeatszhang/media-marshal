import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createTransactions } from "./transactions";
import type { TransactionScope } from "./public";
const connections: Database.Database[] = [];
function fixture() {
  const database = new Database(":memory:");
  connections.push(database);
  database.exec(
    "CREATE TABLE sync_fact(id TEXT PRIMARY KEY); CREATE TABLE delivery_fact(id TEXT PRIMARY KEY)",
  );
  const boundary = createTransactions(database);
  // 模拟两个所有者的窄持久化端口，业务流程只能传递 token 和业务参数。
  const sync = {
    complete: (scope: TransactionScope, id: string) => {
      boundary.connectionFor(scope).prepare("INSERT INTO sync_fact VALUES(?)").run(id);
    },
  };
  const delivery = {
    enqueue: (scope: TransactionScope, id: string) => {
      boundary.connectionFor(scope).prepare("INSERT INTO delivery_fact VALUES(?)").run(id);
    },
  };
  const facts = () =>
    ["sync_fact", "delivery_fact"].map((table) =>
      database.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
    );
  return { database, ...boundary, sync, delivery, facts };
}
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});
it("跨所有者提交共享同一事务，后半段失败时整体回滚", () => {
  const f = fixture();
  expect(() =>
    f.transactions.run((scope) => {
      f.sync.complete(scope, "one");
      f.delivery.enqueue(scope, "one");
      f.delivery.enqueue(scope, "one");
    }),
  ).toThrow();
  expect(f.facts()).toEqual([{ count: 0 }, { count: 0 }]);
  f.transactions.run((scope) => {
    f.sync.complete(scope, "one");
    f.delivery.enqueue(scope, "one");
  });
  expect(f.facts()).toEqual([{ count: 1 }, { count: 1 }]);
});
it("嵌套调用复用同一 token，吞掉嵌套失败也不能提交局部结果", () => {
  const f = fixture();
  let first: TransactionScope | undefined;
  expect(() =>
    f.transactions.run((scope) => {
      first = scope;
      f.sync.complete(scope, "one");
      try {
        f.transactions.run((nested) => {
          expect(nested).toBe(scope);
          throw new Error("记账失败");
        });
      } catch {
        /* 验证外层仍回滚。 */
      }
    }),
  ).toThrow("嵌套事务已失败");
  expect(f.facts()).toEqual([{ count: 0 }, { count: 0 }]);
  expect(() => f.connectionFor(first!)).toThrow("事务身份已失效");
});
it("异步函数在执行前拒绝，普通回调返回 Promise 时回滚并使后续 token 失效", async () => {
  const f = fixture();
  let called = false;
  expect(() =>
    f.transactions.run(async () => {
      called = true;
    }),
  ).toThrow("异步回调");
  expect(called).toBe(false);
  let continuation!: Promise<void>;
  expect(() =>
    f.transactions.run((scope) => {
      f.sync.complete(scope, "one");
      continuation = Promise.resolve().then(() => {
        f.delivery.enqueue(scope, "one");
      });
      return continuation;
    }),
  ).toThrow("异步结果");
  await expect(continuation).rejects.toThrow("事务身份已失效");
  expect(f.facts()).toEqual([{ count: 0 }, { count: 0 }]);
});
it("跨库、伪造与已结束 token 拒绝，不接管外部事务", () => {
  const f = fixture(),
    other = fixture();
  f.transactions.run((scope) => {
    expect(() => other.connectionFor(scope)).toThrow("不属于当前数据库");
    expect(() => f.connectionFor({} as TransactionScope)).toThrow("不属于当前数据库");
  });
  f.database.transaction(() => {
    expect(() => f.transactions.run(() => {})).toThrow("不能隐式接管");
  })();
});
