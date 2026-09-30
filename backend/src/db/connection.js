import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let SqliteClass = null;

// Try loading better-sqlite3 or node:sqlite at startup
try {
  const mod = await import('better-sqlite3');
  const BS = mod.default || mod;
  // Verify constructor works
  new BS(':memory:');
  SqliteClass = BS;
} catch {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    SqliteClass = DatabaseSync;
  } catch (err) {
    throw new Error(`Failed to load SQLite implementation: ${err.message}`);
  }
}

let dbInstance = null;

/**
 * Returns or creates the singleton SQLite database instance.
 * @param {string} [customPath]
 * @returns {any}
 */
export function getDb(customPath) {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = customPath || process.env.DB_PATH || './data/finance.db';
  const resolvedPath = dbPath === ':memory:' ? ':memory:' : (path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath));

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  dbInstance = new SqliteClass(resolvedPath);

  // Set SQLite pragmas
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  if (resolvedPath !== ':memory:') {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  }

  return dbInstance;
}

/**
 * Initializes the database schema.
 * @param {string} [customPath]
 */
export function initDatabase(customPath) {
  const database = getDb(customPath);
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  database.exec(schemaSql);
  migrate(database);
  return database;
}

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
// Existing users get plan_expires_at NULL (no expiry), so nobody is locked out by the upgrade.
const ADDED_COLUMNS = {
  users: [
    ['plan', "TEXT DEFAULT 'trial'"],
    ['status', "TEXT DEFAULT 'active'"],
    ['plan_expires_at', 'DATETIME'],
    ['ai_daily_limit', 'INTEGER'],
    ['last_active_at', 'DATETIME']
  ],
  user_profile: [
    ['monthly_income', 'INTEGER'],
    ['payday', 'INTEGER'],
    ['style', 'TEXT'],
    ['emoji', 'INTEGER']
  ]
};

function migrate(database) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, definition] of columns) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

export const db = {
  get instance() {
    return dbInstance || getDb();
  },
  prepare(sql) {
    return this.instance.prepare(sql);
  },
  exec(sql) {
    return this.instance.exec(sql);
  }
};

export default db;
