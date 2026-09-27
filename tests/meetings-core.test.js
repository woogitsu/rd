import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPACITY_LABELS,
  KIND_LABELS,
  RESOLUTION_STATUS_LABELS,
  VISIBILITY_LABELS,
  VOTE_LABELS,
  allowedStatusTransitions,
  brusselsLocalToIso,
  buildAttendancePayload,
  buildMeetingsUrl,
  buildQuorumRule,
  canApproveMinutes,
  currentResolutions,
  describeQuorumCheck,
  describeQuorumRule,
  effectiveMinutes,
  errorMessage,
  formatVotes,
  isMeetingLocked,
  isoToBrusselsLocal,
  makeIdempotencyKey,
  meetingUrl,
  requiredCountForRule,
  resolutionActions,
  summarizeAttendance,
  validateVotes,
} from "../meetings/core.js";

test("etykiety po polsku dla rodzajów, widoczności, statusów uchwał i głosów", () => {
  assert.deepEqual(KIND_LABELS, { plenary: "Zebranie ogólne", board: "Zebranie zarządu", class: "Zebranie klasowe" });
  assert.deepEqual(VISIBILITY_LABELS, { internal: "Wewnętrzny", parents: "Rodzice", public: "Publiczny" });
  assert.deepEqual(VOTE_LABELS, { votesFor: "Za", votesAgainst: "Przeciw", votesAbstain: "Wstrzymało się" });
  assert.equal(RESOLUTION_STATUS_LABELS.adopted, "Przyjęta");
  assert.equal(RESOLUTION_STATUS_LABELS.rejected, "Odrzucona");
  // Te same funkcje co w API (src/pg/meetings.js CAPACITIES).
  assert.deepEqual(Object.keys(CAPACITY_LABELS).sort(),
    ["audit_member", "board_member", "guardian", "guest", "other", "principal", "representative", "teacher"]);
});

test("czas zebrania jest interpretowany w strefie Europe/Brussels", () => {
  assert.equal(brusselsLocalToIso("2026-10-05T18:30"), "2026-10-05T16:30:00.000Z"); // CEST
  assert.equal(brusselsLocalToIso("2026-12-01T18:30"), "2026-12-01T17:30:00.000Z"); // CET
  assert.equal(isoToBrusselsLocal("2026-12-01T17:30:00.000Z"), "2026-12-01T18:30");
  assert.equal(isoToBrusselsLocal(brusselsLocalToIso("2027-06-15T09:05")), "2027-06-15T09:05");
  // Godzina podwójna (koniec czasu letniego) → pierwsze wystąpienie.
  assert.equal(brusselsLocalToIso("2026-10-25T02:30"), "2026-10-25T00:30:00.000Z");
  // Godzina nieistniejąca (początek czasu letniego).
  assert.throws(() => brusselsLocalToIso("2027-03-28T02:30"), /nie istnieje/);
  assert.throws(() => brusselsLocalToIso(""), /datę i godzinę/);
  assert.equal(isoToBrusselsLocal(null), "");
});

test("adresy API i klucz idempotencji", () => {
  assert.equal(buildMeetingsUrl(" 2026-2027 "), "/api/meetings?schoolYearId=2026-2027");
  assert.throws(() => buildMeetingsUrl(""));
  assert.equal(meetingUrl("m-1", "minutes", "v 1", "approval"), "/api/meetings/m-1/minutes/v%201/approval");
  assert.throws(() => meetingUrl("../x"));
  assert.equal(makeIdempotencyKey("meeting", () => "uuid-1"), "meeting-uuid-1");
  assert.throws(() => makeIdempotencyKey("meeting", null));
});

test("przejścia statusu zgodne z triggerem bazy i blokada po zatwierdzeniu", () => {
  assert.deepEqual(allowedStatusTransitions("draft"), ["scheduled"]);
  assert.deepEqual(allowedStatusTransitions("scheduled"), ["draft", "held"]);
  assert.deepEqual(allowedStatusTransitions("held"), ["archived"]);
  assert.deepEqual(allowedStatusTransitions("archived"), []);
  assert.equal(isMeetingLocked({ meeting: { status: "held" }, minutes: [{ status: "draft" }] }), false);
  assert.equal(isMeetingLocked({ meeting: { status: "held" }, minutes: [{ status: "approved" }] }), true);
  assert.equal(isMeetingLocked({ meeting: { status: "archived" }, minutes: [] }), true);
});

test("reguła quorum wymaga źródła i poprawnych liczb", () => {
  assert.deepEqual(buildQuorumRule({ quorumMode: "not_configured" }),
    { quorumMode: "not_configured", votingBodySize: null, quorumRuleSource: null });
  const fraction = buildQuorumRule({
    quorumMode: "fraction", quorumNumerator: "1", quorumDenominator: "2", quorumInclusive: "false",
    votingBodySize: "20", quorumRuleSource: "§ 12 ust. 3 regulaminu",
  });
  assert.deepEqual(fraction, {
    quorumMode: "fraction", quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: false,
    votingBodySize: 20, quorumRuleSource: "§ 12 ust. 3 regulaminu",
  });
  const base = { quorumMode: "fraction", quorumNumerator: "1", quorumDenominator: "2", quorumInclusive: "true", votingBodySize: "20" };
  assert.throws(() => buildQuorumRule(base), /Źródło reguły/);
  assert.throws(() => buildQuorumRule({ ...base, quorumRuleSource: "  " }), /Źródło reguły/);
  assert.throws(() => buildQuorumRule({ ...base, quorumRuleSource: "§ 1", votingBodySize: "" }), /liczebności/);
  assert.throws(() => buildQuorumRule({ ...base, quorumRuleSource: "§ 1", quorumInclusive: "" }), /co najmniej/);
  assert.throws(() => buildQuorumRule({ ...base, quorumRuleSource: "§ 1", quorumNumerator: "3" }), /Licznik/);
  assert.throws(() => buildQuorumRule({ ...base, quorumRuleSource: "§ 1", quorumNumerator: "2", quorumInclusive: "false" }));
  assert.throws(() => buildQuorumRule({ ...base, quorumRuleSource: "§ 1", quorumNumerator: "1.5" }), /całkowitą/);
  assert.deepEqual(buildQuorumRule({ quorumMode: "minimum_count", quorumMinCount: "7", quorumRuleSource: "uchwała 3/2025" }), {
    quorumMode: "minimum_count", quorumMinCount: 7, votingBodySize: null, quorumRuleSource: "uchwała 3/2025",
  });
  assert.throws(() => buildQuorumRule({ quorumMode: "minimum_count", quorumMinCount: "0", quorumRuleSource: "§ 1" }));
  assert.throws(() => buildQuorumRule({ quorumMode: "majority" }));
});

test("wymagana liczba obecnych liczona jak w bazie", () => {
  const rule = { mode: "fraction", numerator: 1, denominator: 2, votingBodySize: 21 };
  assert.equal(requiredCountForRule({ ...rule, inclusive: true }), 11); // co najmniej 10,5
  assert.equal(requiredCountForRule({ ...rule, inclusive: false }), 11); // więcej niż 10,5
  assert.equal(requiredCountForRule({ ...rule, votingBodySize: 20, inclusive: true }), 10);
  assert.equal(requiredCountForRule({ ...rule, votingBodySize: 20, inclusive: false }), 11);
  assert.equal(requiredCountForRule({ mode: "minimum_count", minCount: 5 }), 5);
  assert.equal(requiredCountForRule({ mode: "not_configured" }), null);
  assert.match(describeQuorumRule({ ...rule, votingBodySize: 20, inclusive: false }), /więcej niż 1\/2 .*20 osób.*wymagane 11/);
  assert.match(describeQuorumRule({ mode: "minimum_count", minCount: 5 }), /co najmniej 5/);
  assert.match(describeQuorumRule({ mode: "not_configured" }), /nie została wpisana/);
});

test("wynik quorum pokazuje liczby i zastrzeżenie o ręcznych danych", () => {
  const met = describeQuorumCheck({
    mode: "fraction", numerator: 1, denominator: 2, inclusive: true, votingBodySize: 20,
    presentEligible: 12, requiredCount: 10, met: true,
  });
  assert.equal(met.headline, "Quorum osiągnięte");
  assert.match(met.detail, /Obecni z prawem głosu: 12; wymagane: 10/);
  assert.match(met.basis, /wpisanych ręcznie/);
  assert.match(met.basis, /nie zna regulaminu/);
  const notMet = describeQuorumCheck({ mode: "minimum_count", minCount: 8, presentEligible: 3, requiredCount: 8, met: false });
  assert.equal(notMet.headline, "Quorum nieosiągnięte");
  assert.equal(notMet.met, false);
  assert.equal(describeQuorumCheck(null), null);
});

test("wpis obecności wymaga jawnego prawa głosu i obecności", () => {
  const base = { personType: "guardian", personId: "g-1", capacity: "representative", present: "true" };
  assert.throws(() => buildAttendancePayload(base), /Prawo głosu/);
  assert.throws(() => buildAttendancePayload({ ...base, votingEligible: "" }), /Prawo głosu/);
  assert.throws(() => buildAttendancePayload({ ...base, present: undefined, votingEligible: "false" }), /Obecność/);
  assert.deepEqual(buildAttendancePayload({ ...base, votingEligible: "false" }),
    { guardianId: "g-1", capacity: "representative", present: true, votingEligible: false });
  assert.deepEqual(buildAttendancePayload({ ...base, personType: "user", personId: "u-1", votingEligible: "true" }),
    { userId: "u-1", capacity: "representative", present: true, votingEligible: true });
  assert.throws(() => buildAttendancePayload({ ...base, votingEligible: "true", capacity: "voter" }), /funkcję/);
  assert.throws(() => buildAttendancePayload({ ...base, votingEligible: "true", personId: "a b" }), /identyfikator/);
});

test("podsumowanie obecności liczy obecnych z prawem głosu (dwoje opiekunów jednego dziecka osobno)", () => {
  assert.deepEqual(summarizeAttendance([
    { guardianId: "g-1", present: true, votingEligible: true },
    { guardianId: "g-2", present: true, votingEligible: false },
    { userId: "u-1", present: false, votingEligible: true },
    { userId: "u-2", present: true, votingEligible: true },
  ]), { recorded: 4, present: 3, eligible: 3, presentEligible: 2 });
  assert.deepEqual(summarizeAttendance(undefined), { recorded: 0, present: 0, eligible: 0, presentEligible: 0 });
});

test("liczby głosów: suma nie może przekroczyć obecnych uprawnionych", () => {
  const quorumCheck = { id: "q-1", presentEligible: 10 };
  assert.deepEqual(validateVotes({ votesFor: "6", votesAgainst: "3", votesAbstain: "1" }, { status: "adopted", quorumCheck }),
    { votes: { votesFor: 6, votesAgainst: 3, votesAbstain: 1 }, total: 10 });
  assert.throws(() => validateVotes({ votesFor: "6", votesAgainst: "4", votesAbstain: "1" }, { status: "adopted", quorumCheck }),
    /Suma głosów \(11\) przekracza .*\(10\)/);
  // Wynik wymaga wszystkich trzech liczb (także zera) i ustalenia quorum.
  assert.throws(() => validateVotes({ votesFor: "6", votesAgainst: "", votesAbstain: "0" }, { status: "rejected", quorumCheck }), /wszystkich trzech/);
  assert.throws(() => validateVotes({ votesFor: "6", votesAgainst: "0", votesAbstain: "0" }, { status: "adopted" }), /ustalenia quorum/);
  assert.deepEqual(validateVotes({ votesFor: "0", votesAgainst: "0", votesAbstain: "0" }, { status: "rejected", quorumCheck }).total, 0);
  // Projekt może nie mieć liczb; wpisane częściowo też są ograniczone sumą.
  assert.deepEqual(validateVotes({}, { status: "draft" }).votes, { votesFor: null, votesAgainst: null, votesAbstain: null });
  assert.throws(() => validateVotes({ votesFor: "11" }, { status: "draft", quorumCheck }), /przekracza/);
  assert.throws(() => validateVotes({ votesFor: "-1" }, { status: "draft" }), /Za: podaj liczbę całkowitą/);
  assert.throws(() => validateVotes({ votesAbstain: "2,5" }, { status: "draft" }), /Wstrzymało się/);
  assert.equal(formatVotes({ votesFor: 6, votesAgainst: 3, votesAbstain: 0 }), "6 / 3 / 0");
  assert.equal(formatVotes({ votesFor: null, votesAgainst: null, votesAbstain: null }), "—");
});

test("rewizje uchwał: bieżąca rewizja z historią poprawek", () => {
  const list = [
    { id: "r1", revision: 1, correctsId: null, status: "adopted", number: "U/1" },
    { id: "r2", revision: 2, correctsId: "r1", status: "adopted", number: "U/1" },
    { id: "r3", revision: 3, correctsId: "r2", status: "adopted", number: "U/1" },
    { id: "d1", revision: 1, correctsId: null, status: "draft", number: null },
  ];
  const current = currentResolutions(list);
  assert.deepEqual(current.map((item) => item.id), ["r3", "d1"]);
  assert.deepEqual(current[0].history.map((item) => item.id), ["r1", "r2"]);
  assert.deepEqual(current[1].history, []);
  assert.deepEqual(resolutionActions({ status: "draft" }, { locked: false }), ["edit"]);
  assert.deepEqual(resolutionActions({ status: "adopted" }, { locked: false }), ["correct"]);
  assert.deepEqual(resolutionActions({ status: "rejected" }, { locked: false }), ["correct"]);
  assert.deepEqual(resolutionActions({ status: "withdrawn" }, { locked: false }), []);
  assert.deepEqual(resolutionActions({ status: "adopted" }, { locked: true }), []);
});

test("protokół: zatwierdzenie tylko najnowszej wersji, udostępniana najnowsza zatwierdzona", () => {
  const minutes = [
    { id: "v1", version: 1, status: "approved", visibility: "parents" },
    { id: "v2", version: 2, status: "approved", visibility: "internal" },
    { id: "v3", version: 3, status: "draft", visibility: "internal" },
  ];
  const held = { status: "held" };
  assert.equal(canApproveMinutes(minutes[2], minutes, held), true);
  assert.equal(canApproveMinutes(minutes[1], minutes, held), false);
  assert.equal(canApproveMinutes(minutes[2], minutes, { status: "archived" }), false);
  assert.equal(effectiveMinutes(minutes).id, "v2");
  assert.equal(effectiveMinutes([]), null);
});

test("kody błędów API mają polskie komunikaty, w tym 409", () => {
  assert.match(errorMessage("idempotency_conflict", 409), /już wysłany/);
  assert.match(errorMessage("resolution_votes_exceed_present_voters", 409), /przekracza/);
  assert.match(errorMessage("meeting_locked", 409), /zablokowane/);
  assert.match(errorMessage("unknown_code", 409), /Konflikt danych/);
  assert.match(errorMessage("", 503), /Błąd serwera \(503\)/);
  assert.match(errorMessage("forbidden", 403), /uprawnień/);
});
