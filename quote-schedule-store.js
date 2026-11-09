import { scheduleFromEnv, validateSchedule } from './quote-schedule.js';

export function createQuoteScheduleStore(db, env = process.env) {
  const baseline = scheduleFromEnv(env);
  db.exec(`CREATE TABLE IF NOT EXISTS quote_schedule_settings (
    key TEXT PRIMARY KEY, env_value TEXT NOT NULL, value TEXT NOT NULL
  )`);
  // GUI values persist. Changing a particular .env value supersedes its previous GUI value on restart.
  const init = db.prepare(`INSERT INTO quote_schedule_settings VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value = CASE WHEN env_value != excluded.env_value THEN excluded.value ELSE value END,
    env_value = excluded.env_value`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(baseline)) init.run(key, JSON.stringify(value), JSON.stringify(value));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const get = () => validateSchedule(Object.fromEntries(db.prepare('SELECT key,value FROM quote_schedule_settings').all().map(row => [row.key, JSON.parse(row.value)])));
  // Individually valid .env edits can conflict with old GUI hours (equal start/end).
  // In that case restore the complete, already validated environment baseline.
  try { get(); } catch {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(baseline)) db.prepare('UPDATE quote_schedule_settings SET value = ? WHERE key = ?').run(JSON.stringify(value), key);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function save(input) {
    const config = validateSchedule(input);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(config)) db.prepare('UPDATE quote_schedule_settings SET value = ? WHERE key = ?').run(JSON.stringify(value), key);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return get();
  }
  return { get, save };
}
