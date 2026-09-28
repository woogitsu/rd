// #213: dokumenty kontrolne (raport dla Komisji Rewizyjnej, zestawienie
// przekazania, widok uzgodnienia) są dziś składane z kilku osobnych zapytań
// na env.db (pula połączeń) — każde w autocommit, z własną migawką READ
// COMMITTED, więc równoległy zapis między dwoma zapytaniami tego samego
// dokumentu daje wewnętrznie sprzeczny wynik (np. suma kategorii nie zgadza
// się z bilansem, choć księga jest poprawna — patrz opis w issue #213).
//
// readSnapshot uruchamia fn na JEDNYM połączeniu w transakcji
// REPEATABLE READ, READ ONLY: wszystkie zapytania w fn widzą tę samą chwilę
// bazy, niezależnie od zapisów, które zdarzą się w międzyczasie na innych
// połączeniach. W transakcji nie używać Promise.all na kilku zapytaniach —
// jedno połączenie i tak je kolejkuje, a Promise.all sugeruje niezależne
// migawki (dokładnie błąd, który to naprawia).
export async function readSnapshot(db, fn) {
  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return fn(tx);
  });
}
