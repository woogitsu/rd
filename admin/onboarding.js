// Onboarding przedstawicieli klas w panelu admina (#108): czyste funkcje bez
// DOM — obsada klas, podgląd partii zaproszeń, lista tokenów do przekazania
// i kartka do wydruku. Testy: tests/admin-onboarding.test.js.
//
// Tokeny istnieją wyłącznie w pamięci strony (odpowiedź POST .../apply) —
// nic tutaj nie zapisuje ich w localStorage ani w adresie strony.

import { MESSAGES } from "../shared/messages.js";

// Instrukcja pierwszego logowania na kartce (#108 pkt 5). PROJEKT TREŚCI do
// zatwierdzenia przez zarząd (D-06: informacja o przetwarzaniu danych; D-10:
// sposób logowania). Opisuje wyłącznie to, co prototyp dziś robi: link otwiera
// /login/#invite=…, nowe konto ustawia hasło (co najmniej 12 znaków), istniejące
// potwierdza obecnym hasłem; MFA nie jest dziś obowiązkowe dla przedstawiciela
// (MFA_REQUIRED_ROLES), ale eksport listy klasy wymaga MFA.
export const FIRST_LOGIN_DRAFT_NOTICE = "Projekt treści — do zatwierdzenia przez zarząd Rady.";
export const FIRST_LOGIN_STEPS = Object.freeze([
  "Otwórz link z tej kartki w przeglądarce na własnym urządzeniu. Link działa jeden raz i do podanej daty.",
  "Jeśli nie masz jeszcze konta, ustaw hasło (co najmniej 12 znaków) i wpisz je drugi raz. Jeśli masz już konto w panelu Rady, podaj obecne hasło — nowa klasa dołączy do tego konta.",
  "Panel może poprosić o weryfikację dwuetapową: zeskanuj kod QR aplikacją uwierzytelniającą, wpisz kod z aplikacji i zapisz 10 kodów odzyskiwania w bezpiecznym miejscu. Pobranie listy klasy wymaga weryfikacji dwuetapowej.",
  "Dane rodzin i uczniów widzisz wyłącznie dla klasy, do której otrzymano zaproszenie.",
]);
export const FIRST_LOGIN_RULES = Object.freeze([
  "Nie przepisuj listy klasy do prywatnych arkuszy ani czatów i nie przekazuj jej dalej.",
  "Składki są dobrowolne: brak wpisu wpłaty nie oznacza zaległości i nie może być tak opisywany.",
  "Nie przekazuj tej kartki ani linku innej osobie. Po przyjęciu zaproszenia kartkę zniszcz.",
  "Problem z logowaniem lub zgubiony link zgłoś osobie, która przekazała kartkę — wyda nowy link.",
]);

// Liczebnik po polsku: 1 zaproszenie, 2–4 zaproszenia, 5+ (i 12–14) zaproszeń.
export function plural(count, one, few, many) {
  const n = Math.abs(count);
  if (n === 1) return `${count} ${one}`;
  const tens = n % 100;
  const units = n % 10;
  return `${count} ${units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14) ? few : many}`;
}
export const invitationsCount = (count) => plural(count, "zaproszenie", "zaproszenia", "zaproszeń");
// Przegląd demo 5: „1 rok szkolnych w systemie” → poprawna odmiana.
export const schoolYearsCount = (count) => plural(count, "rok szkolny", "lata szkolne", "lat szkolnych");

// Numer wiersza + tekst błędu przy wierszu podglądu (kody z src/pg/invitation-batch.js).
export function batchRowError(row) {
  if (!row?.error) return "";
  const text = Object.hasOwn(MESSAGES, row.error) ? MESSAGES[row.error] : row.error;
  return `Wiersz ${row.row}: ${text}`;
}

export function batchSummary(preview) {
  const counts = preview?.counts ?? { total: 0, valid: 0, invalid: 0 };
  if (!counts.total) return "Brak wierszy.";
  if (counts.invalid) {
    return `${plural(counts.total, "wiersz", "wiersze", "wierszy")}, błędnych: ${counts.invalid}. Popraw je w polu tekstowym i wygeneruj podgląd ponownie — partia z błędami nie zostanie zapisana.`;
  }
  return `Do utworzenia: ${invitationsCount(counts.total)}. Zatwierdzenie tworzy wszystkie naraz albo żadnego.`;
}

export function canApplyBatch(preview) {
  return Boolean(preview?.planDigest) && (preview.counts?.total ?? 0) > 0 && (preview.counts?.invalid ?? 1) === 0;
}

// Klucz partii: jeden na podgląd. Ponowienie tego samego zatwierdzenia
// (podwójne kliknięcie, zerwane połączenie) wysyła ten sam klucz, więc serwer
// zwraca zapisaną partię zamiast tworzyć drugą.
export function newBatchKey(random = () => globalThis.crypto.randomUUID()) {
  return `invb-${random()}`;
}

export function invitationLinkFor(token, origin) {
  return `${origin}/login/#invite=${token}`;
}

// Lista do skopiowania: jedna linia na zaproszenie (klasa, adres, link, ważność).
export function tokenListText(invitations, origin, formatDateTime) {
  return (invitations ?? [])
    .filter((item) => item.token)
    .map((item) => [item.className ?? item.classId, item.email, invitationLinkFor(item.token, origin), `ważne do ${formatDateTime(item.expiresAt)}`].join(" · "))
    .join("\n");
}

// Model jednej kartki do wydruku — bez danych dzieci i bez identyfikatorów wewnętrznych.
export function printCardModel(invitation, { origin, schoolYearLabel, formatDateTime }) {
  // Nazwa klasy z serwera bywa już „Klasa 0-A” (dane przykładowe) — bez „klasy Klasa”.
  const name = String(invitation.className ?? invitation.classId);
  return {
    title: `Zaproszenie do panelu Rady Rodziców — przedstawiciel ${/^klasa\b/i.test(name) ? name.replace(/^klasa\b/i, "klasy") : `klasy ${name}`}`,
    schoolYear: schoolYearLabel ?? "",
    email: invitation.email,
    link: invitationLinkFor(invitation.token, origin),
    expires: `Link ważny do ${formatDateTime(invitation.expiresAt)}.`,
    steps: FIRST_LOGIN_STEPS,
    rules: FIRST_LOGIN_RULES,
    draftNotice: FIRST_LOGIN_DRAFT_NOTICE,
  };
}

// Obsada klasy (GET /api/admin/class-coverage): stan słowny bez kolorów jako jedynego nośnika.
export function coverageState(row) {
  if ((row?.activeRepresentativeCount ?? 0) > 0) {
    return row.lastRepresentativeLoginOn ? { key: "active", label: "Przedstawiciel aktywny" } : { key: "pending", label: "Konto bez logowania" };
  }
  if ((row?.pendingInvitationCount ?? 0) > 0) return { key: "pending", label: "Zaproszenie oczekuje" };
  return { key: "revoked", label: "Brak przedstawiciela" };
}

export function coverageSummary(rows) {
  const list = rows ?? [];
  const missing = list.filter((row) => !(row.activeRepresentativeCount > 0) && !(row.pendingInvitationCount > 0)).length;
  const invited = list.filter((row) => !(row.activeRepresentativeCount > 0) && row.pendingInvitationCount > 0).length;
  if (!list.length) return "Rok nie ma klas.";
  return `${plural(list.length, "klasa", "klasy", "klas")}: bez przedstawiciela i bez zaproszenia ${missing}, z oczekującym zaproszeniem ${invited}.`;
}
