// Adres bazy dla operacji wymagających roli WŁAŚCICIELA schematu (migracje,
// odtworzenie z migawki/paczki: DDL, triggery, session_replication_role).
// SR-05 (#101): aplikacja łączy się rolą `rd_app` przez DATABASE_URL, a rola
// właściciela (`rd_owner`/domyślny użytkownik Railway) żyje w
// DATABASE_MIGRATION_URL. Brak DATABASE_MIGRATION_URL → fallback na DATABASE_URL
// (dotychczasowe zachowanie; jedna rola do wszystkiego).
export function migrationDatabaseUrl(env = process.env) {
  return env.DATABASE_MIGRATION_URL || env.DATABASE_URL || '';
}
