import type Database from "better-sqlite3";
import { DesktopError } from "@media-marshal/contracts";
import type { Transactions, TransactionScope } from "./public.js";

/** 仅供组装入口和 persistence 使用；向业务流程只注入 transactions。 */
export function createTransactions(connection: Database.Database) {
  let active: TransactionScope | undefined;
  let failed = false;
  const reject = (reason: string): never => {
    throw new DesktopError("STORAGE_ERROR", reason);
  };
  function invoke<T>(work: (scope: TransactionScope) => T, scope: TransactionScope): T {
    if (work.constructor.name === "AsyncFunction")
      return reject("数据库事务不接受异步回调，请在事务外完成网络和文件操作");
    const value = work(scope);
    if (value && (typeof value === "object" || typeof value === "function") && "then" in value) {
      void Promise.resolve(value).catch(() => undefined);
      return reject("数据库事务回调返回异步结果，当前写入已回滚");
    }
    return value;
  }
  const transactions: Transactions = {
    run<T>(work: (scope: TransactionScope) => T): T {
      if (active) {
        try {
          return invoke(work, active);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
      if (connection.inTransaction) return reject("数据库已有不属于当前作用域的事务，不能隐式接管");
      return connection.transaction(() => {
        active = Object.freeze({}) as TransactionScope;
        failed = false;
        try {
          const value = invoke(work, active);
          if (failed) return reject("嵌套事务已失败，整个业务记账已回滚");
          return value;
        } finally {
          active = undefined;
          failed = false;
        }
      })();
    },
  };
  return {
    transactions,
    /** 只注入各模块 persistence，不从模块公开入口导出。 */
    connectionFor(scope: TransactionScope): Database.Database {
      if (!active || scope !== active)
        return reject("事务身份已失效或不属于当前数据库，请重新发起完整业务事务");
      return connection;
    },
  };
}
