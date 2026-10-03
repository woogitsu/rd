// Schematy OpenAPI dla modułu `representative` (src/pg/routes/representative.js, #118), #160 etap 13: pulpit
// przedstawiciela klasy. Pisane ręcznie na podstawie obiektu odpowiedzi trasy; trasa się nie zmienia.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * wyłącznie rola `representative` (także bez MFA — rola nie jest na liście MFA_REQUIRED_ROLES); konto bez żadnego
//     przydziału przedstawiciela (admin, zarząd także z przydziałem klasy, skarbnik, Komisja Rewizyjna, dyrekcja) → 403
//     (rola sprawdzana przed parametrem roku);
//   * zakres wyliczany z przydziałów, bez `classId` w żądaniu: tylko klasy z aktywnych przydziałów przedstawiciela
//     do wskazanego roku; przydział innego roku → 200 z `classes: []` (nie 403);
//   * wyłącznie liczności i daty — bez list rodzin, adresów i sekcji wpłat (pola `payments` nie ma, D-08); „do kartki
//     papierowej” to uczniowie bez opiekuna z obiema zgodami, adresem i bez aktywnej blokady adresu.
import { nullable, ref, strictObject } from './common.js';

export const name = 'representative';

const COUNT = ref('Count');

export const components = {
  RepresentativeClassSummary: strictObject({
    id: ref('EntityId'),
    name: { type: 'string' },
    studentCount: { ...COUNT, description: 'Uczniowie z bieżącym przypisaniem do klasy.' },
    householdCount: { ...COUNT, description: 'Gospodarstwa tych uczniów (bieżące członkostwa, także opieka dzielona).' },
    needsPaperCardCount: { ...COUNT, description: 'Uczniowie bez osiągalnego kontaktu e-mail (zgody, adres, brak blokady) — do kartki papierowej.' },
    cards: strictObject({ lastPrintedAt: nullable({ ...ref('IsoDateTime'), description: 'Ostatni wydruk kartek tej klasy (z dziennika); null — brak.' }) }),
    nextMeeting: nullable(strictObject({
      id: ref('EntityId'),
      title: { type: 'string' },
      scheduledAt: ref('IsoDateTime'),
      location: nullable({ type: 'string' }),
    }, [], { description: 'Najbliższe zaplanowane zebranie klasy.' })),
    documents: strictObject({
      activeCount: { ...COUNT, description: 'Aktywne dokumenty klasy (bez zastąpionych i unieważnionych).' },
      latestAt: nullable(ref('IsoDateTime')),
    }),
    events: strictObject({
      draftCount: { ...COUNT, description: 'Szkice wydarzeń klasy.' },
      submittedCount: { ...COUNT, description: 'Wydarzenia klasy czekające na decyzję zarządu.' },
    }),
  }, [], { description: 'Podsumowanie jednej przypisanej klasy (bez sekcji wpłat, bez rankingu).' }),
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/representative/overview': {
    query: { schoolYearId: { required: true, schema: ref('Id') } },
    responses: {
      200: {
        description: 'Przypisane klasy wywołującego w roku (wg nazwy); przydział innego roku — pusta lista.',
        schema: strictObject({ schoolYearId: ref('EntityId'), classes: { type: 'array', items: ref('RepresentativeClassSummary') } }),
      },
    },
    errors: {
      400: ['invalid_request'],
      403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'],
    },
  },
};
