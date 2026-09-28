// Skrypt kontrolny tylko do odczytu dla #198: przed migracją
// 0081_scope_and_email_consistency.sql wypisuje WYŁĄCZNIE liczby naruszeń
// każdej reguły (bez identyfikatorów wierszy, e-maili ani innych danych
// osobowych). Nie modyfikuje bazy. Wynik > 0 dla którejkolwiek reguły
// oznacza, że migracja 0081 zatrzyma się (FK/UNIQUE/CHECK) i naruszenia
// trzeba rozstrzygnąć ręcznie (patrz postgres/README.md) przed jej
// ponowieniem.
//
// Użycie: DATABASE_URL=... node scripts/check-schema-consistency.mjs
import { Client } from 'pg';

const QUERIES = [
  {
    rule: 'role_grants_class_out_of_year',
    sql: `SELECT count(*)::int AS n FROM role_grants g JOIN classes c ON c.id = g.class_id
           WHERE g.school_year_id IS DISTINCT FROM c.school_year_id`,
  },
  {
    rule: 'role_grants_class_without_year',
    sql: `SELECT count(*)::int AS n FROM role_grants WHERE class_id IS NOT NULL AND school_year_id IS NULL`,
  },
  {
    rule: 'invitations_class_out_of_year',
    sql: `SELECT count(*)::int AS n FROM invitations i JOIN classes c ON c.id = i.class_id
           WHERE i.school_year_id IS DISTINCT FROM c.school_year_id`,
  },
  {
    rule: 'export_runs_class_out_of_year',
    sql: `SELECT count(*)::int AS n FROM export_runs e JOIN classes c ON c.id = e.class_id
           WHERE e.school_year_id IS DISTINCT FROM c.school_year_id`,
  },
  {
    rule: 'users_email_case_duplicates',
    // Liczba adresów (po lower/btrim), które mają więcej niż jedno konto —
    // nie liczba wierszy, żeby nie sugerować rozmiaru problemu per konto.
    sql: `SELECT count(*)::int AS n FROM (
            SELECT lower(btrim(email)) AS e FROM users GROUP BY 1 HAVING count(*) > 1
          ) dupes`,
  },
  {
    rule: 'users_email_not_normalized',
    sql: `SELECT count(*)::int AS n FROM users WHERE email <> lower(btrim(email))`,
  },
  {
    rule: 'invitations_email_not_normalized',
    sql: `SELECT count(*)::int AS n FROM invitations WHERE email <> lower(btrim(email))`,
  },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const report = {};
    let violations = 0;
    for (const { rule, sql } of QUERIES) {
      const { rows } = await client.query(sql);
      const n = Number(rows[0].n);
      report[rule] = n;
      violations += n;
    }
    console.log(JSON.stringify(report, null, 2));
    if (violations > 0) {
      console.error(`Naruszenia znalezione (${violations}). Rozstrzygnij przed migracją 0081 — patrz postgres/README.md.`);
      process.exitCode = 1;
    } else {
      console.log('Brak naruszeń. Migrację 0081 można bezpiecznie zastosować.');
    }
  } finally {
    await client.end().catch(() => {});
  }
}

await main();
