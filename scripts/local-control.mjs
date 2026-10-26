import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const migrations = fileURLToPath(new URL("../drizzle/", import.meta.url));
export function localControl(path = ".laras/control.sqlite") {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY)");
  for (const name of readdirSync(migrations)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (db.prepare("SELECT name FROM local_migrations WHERE name=?").get(name))
      continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(migrations, name), "utf8"));
      db.prepare("INSERT INTO local_migrations(name) VALUES(?)").run(name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function prepare(sql, params = []) {
    return {
      bind(...values) {
        return prepare(sql, values);
      },
      async first() {
        return db.prepare(sql).get(...params) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    close: () => db.close(),
    prepare,
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
