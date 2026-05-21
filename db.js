const initSqlJs = require('sql.js');
const bcryptjs = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'election.db');

let db = null;
let inTransaction = false;

/**
 * Initialize the SQLite database (async, must be called once at startup).
 */
async function initialize() {
  const SQL = await initSqlJs();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Load existing database file or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      input_deadline TEXT,
      schedule_start_date TEXT,
      schedule_end_date TEXT,
      admin_email TEXT NOT NULL DEFAULT '',
      admin_password_hash TEXT NOT NULL DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_super INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      max_shifts INTEGER DEFAULT 26,
      has_submitted_input INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add password_hash column if upgrading from older schema
  try {
    db.run('SELECT password_hash FROM candidates LIMIT 0');
  } catch (e) {
    db.run('ALTER TABLE candidates ADD COLUMN password_hash TEXT');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slots_per_day INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS blackout_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      is_system_generated INTEGER DEFAULT 0,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      UNIQUE(candidate_id, date)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS magic_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS candidate_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reminder_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      deadline TEXT NOT NULL,
      reminder_type TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      UNIQUE(candidate_id, deadline, reminder_type),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS swap_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL,
      requester_assignment_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      target_assignment_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (requester_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES candidates(id) ON DELETE CASCADE,
      FOREIGN KEY (requester_assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
      FOREIGN KEY (target_assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
    )
  `);

  // Ensure system_settings row exists (schedule config only now)
  const settings = queryOne('SELECT * FROM system_settings WHERE id = 1');
  if (!settings) {
    run('INSERT INTO system_settings (id, admin_email, admin_password_hash) VALUES (1, \'\', \'\')', []);
  }

  // Seed super admin into admins table if empty
  const anyAdmin = queryOne('SELECT id FROM admins LIMIT 1');
  if (!anyAdmin) {
    // Migrate from legacy system_settings if credentials were stored there
    const legacy = queryOne('SELECT * FROM system_settings WHERE id = 1');
    if (legacy && legacy.admin_email && legacy.admin_password_hash) {
      run('INSERT INTO admins (name, email, password_hash, is_super) VALUES (?, ?, ?, 1)',
        ['Administrator', legacy.admin_email, legacy.admin_password_hash]);
      console.log('Migrated existing admin to admins table:', legacy.admin_email);
    } else {
      const hash = bcryptjs.hashSync('admin123', 10);
      run('INSERT INTO admins (name, email, password_hash, is_super) VALUES (?, ?, ?, 1)',
        ['Administrator', 'jim.muzzall@gmail.com', hash]);
      console.log('Default super admin created: jim.muzzall@gmail.com / admin123');
    }
  }

  save();
}

/**
 * Save the in-memory database to disk.
 */
function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

/**
 * Run a statement (INSERT/UPDATE/DELETE) with optional params.
 * Returns { changes, lastInsertRowid }.
 */
function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  if (!inTransaction) save();
  return { changes, lastInsertRowid: lastId ? lastId.id : 0 };
}

/**
 * Query all rows. Returns array of objects.
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/**
 * Query a single row. Returns object or undefined.
 */
function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : undefined;
}

/**
 * Execute raw SQL (for multi-statement or DDL).
 */
function exec(sql) {
  db.run(sql);
  save();
}

/**
 * Run multiple operations in a "transaction" (save once at the end).
 */
function transaction(fn) {
  inTransaction = true;
  db.run('BEGIN TRANSACTION');
  try {
    fn();
    db.run('COMMIT');
    save();
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  } finally {
    inTransaction = false;
  }
}

module.exports = { initialize, run, queryAll, queryOne, exec, transaction, save };
