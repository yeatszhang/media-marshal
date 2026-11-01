/** 事务身份只能由 storage 创建，业务流程不能从中取得数据库连接。 */
declare const transactionScope: unique symbol;
export interface TransactionScope {
  readonly [transactionScope]: true;
}
export interface Transactions {
  run<T>(work: (scope: TransactionScope) => T): T;
}
