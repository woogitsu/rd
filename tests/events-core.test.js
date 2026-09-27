import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  STATUS_LABELS,
  availableActions,
  buildActionRequest,
  buildCreateRequest,
  buildEventUrl,
  buildListUrl,
  buildUpdateRequest,
  changedFields,
  classifyBrusselsLocal,
  countByStatus,
  createKeyHolder,
  errorMessage,
  filterEvents,
  formValuesFromEvent,
  formatBrussels,
  formatRange,
  fromApiLocal,
  isConflict,
  isUnauthenticated,
  localToInstant,
  makeIdempotencyKey,
  publishedIsBehind,
  revisionMarks,
  toApiLocal,
  validateEventForm,
  validateReason,
} from "../events/core.js";

const baseForm = {
  schoolYearId: "2026-2027",
  classId: "",
  title: "Zebranie organizacyjne",
  description: "",
  startsAt: "2026-10-12T18:00",
  startsOffset: "",
  endsAt: "2026-10-12T19:30",
  endsOffset: "",
  location: "Sala 12",
  organizer: "",
  audience: "internal",
};

test("statusy mają polskie etykiety", () => {
  assert.deepEqual(STATUS_LABELS, {
    draft: "Szkic",
    submitted: "Zgłoszone",
    approved: "Zatwierdzone",
    published: "Opublikowane",
    cancelled: "Odwołane",
  });
});

test("klasyfikacja czasu lokalnego w Brukseli rozpoznaje zmianę czasu", () => {
  assert.deepEqual(classifyBrusselsLocal("2026-10-12T18:00"), { kind: "ok", offsets: ["+02:00"] });
  assert.deepEqual(classifyBrusselsLocal("2026-12-01T18:00"), { kind: "ok", offsets: ["+01:00"] });
  assert.deepEqual(classifyBrusselsLocal("2026-10-25T02:30"), { kind: "ambiguous", offsets: ["+02:00", "+01:00"] });
  assert.equal(classifyBrusselsLocal("2026-10-25T03:00").kind, "ok");
  assert.equal(classifyBrusselsLocal("2026-10-25T01:59").kind, "ok");
  assert.equal(classifyBrusselsLocal("2026-03-29T02:30").kind, "nonexistent");
  assert.equal(classifyBrusselsLocal("2026-03-29T03:00").kind, "ok");
  assert.equal(classifyBrusselsLocal("2026-02-30T10:00").kind, "invalid");
  assert.equal(classifyBrusselsLocal("12.10.2026 18:00").kind, "invalid");
  assert.equal(classifyBrusselsLocal("").kind, "empty");
});

test("godzina podwójna daje dwie różne chwile zależnie od wybranego przesunięcia", () => {
  assert.equal(localToInstant("2026-10-25T02:30", "+02:00").toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(localToInstant("2026-10-25T02:30", "+01:00").toISOString(), "2026-10-25T01:30:00.000Z");
  assert.equal(localToInstant("2026-10-25T02:30"), null);
  assert.equal(localToInstant("2026-10-12T18:00").toISOString(), "2026-10-12T16:00:00.000Z");
  assert.equal(toApiLocal("2026-10-25T02:30", "+01:00"), "2026-10-25T02:30+01:00");
  assert.equal(toApiLocal("2026-10-12T18:00", "+01:00"), "2026-10-12T18:00", "zwykła godzina bez przesunięcia");
  assert.equal(toApiLocal("2026-10-25T02:30", "+05:00"), "2026-10-25T02:30");
});

test("czas z API wraca do pola formularza z przesunięciem tylko w godzinie podwójnej", () => {
  assert.deepEqual(fromApiLocal("2026-10-25T02:30:00+01:00"), { local: "2026-10-25T02:30", offset: "+01:00" });
  assert.deepEqual(fromApiLocal("2026-10-12T18:00:00+02:00"), { local: "2026-10-12T18:00", offset: "" });
  assert.deepEqual(fromApiLocal(null), { local: "", offset: "" });
});

test("formatowanie pokazuje czas brukselski i rozróżnia podwójną godzinę", () => {
  const summer = formatBrussels("2026-10-25T00:30:00Z");
  const winter = formatBrussels("2026-10-25T01:30:00Z");
  assert.match(summer, /02:30 \(czas letni, UTC\+02:00\)$/);
  assert.match(winter, /02:30 \(czas zimowy, UTC\+01:00\)$/);
  assert.match(formatBrussels("2026-10-12T16:00:00Z"), /12 października 2026.*18:00$/);
  assert.equal(formatBrussels(null), "—");
  assert.match(formatRange("2026-10-12T16:00:00Z", "2026-10-12T17:30:00Z"), /18:00 – 19:30$/);
  assert.match(formatRange("2026-10-12T16:00:00Z", "2026-10-13T17:30:00Z"), /13 października 2026.*19:30$/);
});

test("walidacja formularza zwraca treść gotową dla API", () => {
  const result = validateEventForm(baseForm);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.scope, { schoolYearId: "2026-2027", classId: null });
  assert.deepEqual(result.content, {
    title: "Zebranie organizacyjne",
    description: null,
    startsAt: "2026-10-12T18:00",
    endsAt: "2026-10-12T19:30",
    location: "Sala 12",
    organizer: null,
    audience: "internal",
  });
});

test("walidacja wykrywa błędne pola, koniec przed początkiem i nieistniejącą godzinę", () => {
  const { errors } = validateEventForm({
    ...baseForm, schoolYearId: " ", classId: "zła klasa", title: "ab", audience: "everyone",
    endsAt: "2026-10-12T17:00", location: "x".repeat(201),
  });
  assert.deepEqual(Object.keys(errors).sort(), ["audience", "classId", "endsAt", "location", "schoolYearId", "title"]);
  assert.match(errors.endsAt, /Koniec nie może/);

  const gap = validateEventForm({ ...baseForm, startsAt: "2026-03-29T02:30", endsAt: "" });
  assert.match(gap.errors.startsAt, /nie istnieje/);

  const missing = validateEventForm({ ...baseForm, startsAt: "" });
  assert.match(missing.errors.startsAt, /początku/);
});

test("godzina podwójna wymaga jawnego wyboru przesunięcia", () => {
  const ambiguous = { ...baseForm, startsAt: "2026-10-25T02:30", endsAt: "2026-10-25T02:45" };
  const first = validateEventForm(ambiguous);
  assert.deepEqual(first.needsOffset, { startsAt: ["+02:00", "+01:00"], endsAt: ["+02:00", "+01:00"] });
  assert.match(first.errors.startsAt, /dwa razy/);
  assert.match(first.errors.endsAt, /dwa razy/);

  const chosen = validateEventForm({ ...ambiguous, startsOffset: "+02:00", endsOffset: "+01:00" });
  assert.deepEqual(chosen.errors, {});
  assert.equal(chosen.content.startsAt, "2026-10-25T02:30+02:00");
  assert.equal(chosen.content.endsAt, "2026-10-25T02:45+01:00");

  // 02:30 czasu zimowego (01:30 UTC) jest później niż 02:45 czasu letniego (00:45 UTC).
  const reversed = validateEventForm({ ...ambiguous, startsOffset: "+01:00", endsOffset: "+02:00" });
  assert.match(reversed.errors.endsAt, /Koniec nie może/);
});

test("edycja nie wymaga roku ani klasy (nie zmienia zakresu wydarzenia)", () => {
  const result = validateEventForm({ ...baseForm, schoolYearId: "", classId: "" }, { mode: "edit" });
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.scope, {});
});

test("powód odwołania ma 3–500 znaków", () => {
  assert.equal(validateReason("  ok ").error !== null, true);
  assert.deepEqual(validateReason("  Choroba prowadzącego  "), { error: null, reason: "Choroba prowadzącego" });
  assert.ok(validateReason("x".repeat(501)).error);
});

test("żądanie utworzenia niesie klucz idempotencji i opcjonalną klasę", () => {
  const { scope, content } = validateEventForm({ ...baseForm, classId: "3A" });
  const request = buildCreateRequest({ scope, content }, "event-1234-abcd");
  assert.equal(request.url, "/api/events");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.headers, { "Content-Type": "application/json", "Idempotency-Key": "event-1234-abcd" });
  const body = JSON.parse(request.body);
  assert.equal(body.schoolYearId, "2026-2027");
  assert.equal(body.classId, "3A");
  assert.equal(body.startsAt, "2026-10-12T18:00");

  const noClass = JSON.parse(buildCreateRequest(validateEventForm(baseForm), "event-1234-abcd").body);
  assert.equal("classId" in noClass, false);
  assert.throws(() => buildCreateRequest({ scope, content }, "short"));
});

test("klucz idempotencji jest stały do resetu (podwójne kliknięcie, ponowienie)", () => {
  let n = 0;
  const holder = createKeyHolder("event", () => `uuid-${++n}`);
  assert.equal(holder.peek(), null);
  assert.equal(holder.get(), "event-uuid-1");
  assert.equal(holder.get(), "event-uuid-1");
  holder.reset();
  assert.equal(holder.get(), "event-uuid-2");
  assert.equal(makeIdempotencyKey("event", () => "x"), "event-x");
  assert.throws(() => makeIdempotencyKey("event", null));
});

test("zmiana i kroki przebiegu wysyłają widziany numer wersji", () => {
  const { content } = validateEventForm({ ...baseForm, description: "" }, { mode: "edit" });
  const update = buildUpdateRequest("ev-1", 3, content);
  assert.equal(update.url, "/api/events/ev-1");
  assert.equal(update.method, "PATCH");
  const body = JSON.parse(update.body);
  assert.equal(body.revision, 3);
  assert.equal(body.description, null, "puste pole czyści wartość");

  const approve = buildActionRequest("ev-1", "approve", 4);
  assert.equal(approve.url, "/api/events/ev-1/approve");
  assert.deepEqual(JSON.parse(approve.body), { revision: 4 });

  const cancel = buildActionRequest("ev-1", "cancel", 4, " Brak sali ");
  assert.deepEqual(JSON.parse(cancel.body), { revision: 4, reason: "Brak sali" });

  assert.throws(() => buildActionRequest("ev-1", "cancel", 4, "x"));
  assert.throws(() => buildActionRequest("ev-1", "delete", 4));
  assert.throws(() => buildActionRequest("ev-1", "submit", 0));
  assert.throws(() => buildUpdateRequest("ev-1", "3", content));
});

test("adresy listy i szczegółów są walidowane i kodowane", () => {
  assert.equal(buildListUrl("2026-2027"), "/api/events?schoolYearId=2026-2027");
  assert.throws(() => buildListUrl("2026/2027"));
  assert.equal(buildEventUrl("a:b"), "/api/events/a%3Ab");
  assert.throws(() => buildEventUrl("../x"));
});

test("błędy API mają polskie komunikaty, konflikt i brak sesji są rozpoznawane", () => {
  const conflict = new ApiError("revision_conflict", 409);
  assert.ok(isConflict(conflict));
  assert.match(conflict.message, /Ktoś zmienił wydarzenie.*Odśwież/);
  assert.ok(isUnauthenticated(new ApiError("unauthenticated", 401)));
  assert.ok(isUnauthenticated(new ApiError(null, 401)));
  assert.match(errorMessage("ambiguous_local_time", 400), /dwa razy/);
  assert.match(errorMessage("nonexistent_local_time", 400), /nie istnieje/);
  assert.match(errorMessage("four_eyes_required", 409), /inna osoba/);
  assert.match(errorMessage("something_new", 500), /Błąd serwera/);
  assert.match(errorMessage(null, 0), /Brak połączenia/);
});

test("filtr statusu, liczniki i dostępne kroki", () => {
  const events = [
    { id: "1", status: "draft" },
    { id: "2", status: "published", audience: "public" },
    { id: "3", status: "draft" },
  ];
  assert.deepEqual(filterEvents(events, "draft").map((e) => e.id), ["1", "3"]);
  assert.equal(filterEvents(events, "").length, 3);
  assert.deepEqual(countByStatus(events), { draft: 2, submitted: 0, approved: 0, published: 1, cancelled: 0 });

  assert.deepEqual(availableActions({ status: "draft" }), ["submit", "cancel"]);
  assert.deepEqual(availableActions({ status: "submitted" }), ["approve", "cancel"]);
  assert.deepEqual(availableActions({ status: "approved", audience: "public" }), ["publish", "cancel"]);
  assert.deepEqual(availableActions({ status: "approved", audience: "internal" }), ["cancel"]);
  assert.deepEqual(availableActions({ status: "published" }), ["cancel"]);
  assert.deepEqual(availableActions({ status: "cancelled" }), []);
});

test("historia wersji: znaczniki i zmienione pola", () => {
  const event = { revision: 3, submittedRevision: 2, approvedRevision: 2, publishedRevision: 2 };
  assert.deepEqual(revisionMarks(event, 2), ["zgłoszona", "zatwierdzona", "opublikowana"]);
  assert.deepEqual(revisionMarks(event, 3), ["bieżąca"]);
  assert.ok(publishedIsBehind(event));
  assert.equal(publishedIsBehind({ revision: 2, publishedRevision: 2 }), false);
  assert.equal(publishedIsBehind({ revision: 2, publishedRevision: null }), false);

  const previous = { title: "A", startsAt: "2026-10-12T18:00:00+02:00", location: null, audience: "internal" };
  const current = { title: "A", startsAt: "2026-10-12T18:30:00+02:00", location: "Sala 3", audience: "internal" };
  assert.deepEqual(changedFields(previous, current), ["początek", "miejsce"]);
  assert.deepEqual(changedFields(null, current), []);
});

test("formularz edycji wypełnia się danymi wydarzenia", () => {
  const values = formValuesFromEvent({
    schoolYearId: "2026-2027", classId: null, title: "Kiermasz", description: null,
    startsAt: "2026-10-25T02:30:00+01:00", endsAt: null, location: null, organizer: "Rada", audience: "public",
  });
  assert.equal(values.startsAt, "2026-10-25T02:30");
  assert.equal(values.startsOffset, "+01:00");
  assert.equal(values.endsAt, "");
  assert.equal(values.classId, "");
  assert.equal(values.organizer, "Rada");
});
