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
let dbFilePath = null;

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
  dbFilePath = resolvedPath;

  // Set SQLite pragmas
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  if (resolvedPath !== ':memory:') {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  }

  return dbInstance;
}

/**
 * Absolute path of the open database file (':memory:' in tests, null before the first connection).
 * @returns {string|null}
 */
export function getDbFilePath() {
  return dbFilePath;
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
  ai_usage: [
    ['kind', "TEXT DEFAULT 'chat'"]
  ],
  user_profile: [
    ['monthly_income', 'INTEGER'],
    ['payday', 'INTEGER'],
    ['style', 'TEXT'],
    ['emoji', 'INTEGER'],
    ['language', 'TEXT'],
    ['persona', 'TEXT'],
    ['reminder_time', 'TEXT'],
    ['smart_nudge', 'INTEGER'],
    // Onboarding: NULL = never introduced, 'ask_name' = waiting for a nickname, 'done'.
    ['onboarding', 'TEXT'],
    ['tips_seen', 'INTEGER DEFAULT 0'],
    ['last_tip_at', 'DATETIME']
  ],
  transactions: [
    ['wallet_id', 'INTEGER'],
    ['tags', 'TEXT']
  ]
};

// Indexes on columns added above (they can only be created after the columns exist).
const POST_MIGRATION_SQL = `
  CREATE INDEX IF NOT EXISTS idx_transactions_user_wallet ON transactions(user_id, wallet_id);
`;

function migrate(database) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, definition] of columns) {
      if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(POST_MIGRATION_SQL);
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
