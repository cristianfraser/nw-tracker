import type Database from "better-sqlite3";
import { dbSlowThresholdMs, logDbAllStatements, logDbEnabled, logServer } from "./serverLog.js";

const SQL_PREVIEW_LEN = 120;

function sqlPreview(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SQL_PREVIEW_LEN) return oneLine;
  return `${oneLine.slice(0, SQL_PREVIEW_LEN)}…`;
}

function logSql(op: string, sql: string, ms: number): void {
  logServer("db", `${op} ${ms.toFixed(1)}ms ${sqlPreview(sql)}`);
}

function wrapStatement(stmt: Database.Statement, sql: string): Database.Statement {
  const threshold = dbSlowThresholdMs();
  const logAll = logDbAllStatements();

  const wrapSync = <T>(op: string, fn: (...args: unknown[]) => T) => {
    return (...args: unknown[]): T => {
      const t0 = performance.now();
      try {
        return fn(...args);
      } finally {
        const elapsed = performance.now() - t0;
        if (logAll || elapsed >= threshold) {
          logSql(op, sql, elapsed);
        }
      }
    };
  };

  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "all" && typeof value === "function") {
        return wrapSync("all", value.bind(target));
      }
      if (prop === "get" && typeof value === "function") {
        return wrapSync("get", value.bind(target));
      }
      if (prop === "run" && typeof value === "function") {
        return wrapSync("run", value.bind(target));
      }
      if (prop === "iterate" && typeof value === "function") {
        return wrapSync("iterate", value.bind(target));
      }
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as Database.Statement;
}

/** Wrap `better-sqlite3` for slow-query logging when `DEBUG_DB` / `DEBUG_VERBOSE` is set. */
export function wrapDatabaseForVerboseLog(db: Database.Database): Database.Database {
  if (!logDbEnabled() && !logDbAllStatements()) return db;

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (sql: string, ...a: unknown[]) => Database.Statement).call(
            target,
            sql,
            ...rest
          );
          return wrapStatement(stmt, sql);
        };
      }
      if (prop === "exec") {
        return (sql: string) => {
          const threshold = dbSlowThresholdMs();
          const logAll = logDbAllStatements();
          const t0 = performance.now();
          try {
            return target.exec(sql);
          } finally {
            const elapsed = performance.now() - t0;
            if (logAll || elapsed >= threshold) {
              logSql("exec", sql, elapsed);
            }
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as Database.Database;
}
