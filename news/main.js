import {
  RIGHTS_LABELS,
  STATUS_LABELS,
  availableActions,
  canReadPhotoRegister,
  consentSummary,
  describeApiError,
  formatDateTime,
  hasNewsAccess,
  isSchoolWideEditor,
  isValidId,
  listUrl,
  makeIdempotencyKey,
  newsYears,
  peopleSummary,
  photoSummary,
  photoUrl,
  postUrl,
  representedClassIds,
  selectablePhotos,
  validateDraft,
  validateReason,
} from "./core.js";
import { api as apiRequest } from "../shared/api.js";
import { confirmAction } from "../shared/confirm-dialog.js";
import { initialSchoolYearId, yearOptionsHtml } from "../shared/school-year.js";
import { mountShell } from "../shared/shell.js";
import "../shared/shell.css";

mountShell();

const api = apiRequest;
const byId = (id) => document.getElementById(id);

const state = {
  schoolYearId: "",
  posts: [],
  selected: null, // { post, revisions }
  photos: [], // rejestr (tylko admin/zarząd)
  classes: [],
  grants: [],
  actorId: null,
  busy: false,
  editingId: null,
  createKey: null,
};

const filtersForm = byId("filters-form");
const yearSelect = byId("school-year-id");
const message = byId("message");

function setMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? "message error" : "message";
}

// #124: data-label = nagłówek kolumny; przy wąskim ekranie (≤ 520 px) wiersz
// tabeli jest pokazywany jako lista „Nagłówek: wartość” bez przewijania w poziomie.
function cell(text, className = "", label = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  if (label) td.dataset.label = label;
  return td;
}

function badge(label, status) {
  const span = document.createElement("span");
  span.className = `badge status-${status}`;
  span.textContent = label;
  return span;
}

function scopeLabel(post) {
  if (!post.classId) return "Cała szkoła";
  const found = state.classes.find((item) => item.id === post.classId);
  return found ? `Klasa ${found.name}` : "Klasa";
}

// --- lista ---------------------------------------------------------------------------------

function renderList() {
  byId("posts-body").replaceChildren(...state.posts.map((post) => {
    const row = document.createElement("tr");
    const status = document.createElement("td");
    status.dataset.label = "Stan";
    status.append(badge(STATUS_LABELS[post.status] ?? post.status, post.status));
    const actions = document.createElement("td");
    actions.className = "row-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Otwórz";
    // Nazwa dostępna odróżnia przyciski w liście przycisków czytnika ekranu (#124).
    open.setAttribute("aria-label", `Otwórz wpis: ${post.title}`);
    open.addEventListener("click", () => openDetail(post.id));
    actions.append(open);
    row.append(cell(post.title, "", "Tytuł"), cell(scopeLabel(post), "", "Zakres"), status,
      cell(String(post.revision), "amount", "Wersja"), cell(formatDateTime(post.updatedAt), "", "Zmieniono"), actions);
    return row;
  }));
  const count = state.posts.length;
  byId("posts-table").hidden = count === 0;
  byId("posts-empty").hidden = count !== 0;
  byId("posts-count").textContent = count === 1 ? "1 wpis" : `${count} wpisów`;
}

async function loadList() {
  const data = await api(listUrl(state.schoolYearId));
  state.posts = Array.isArray(data.posts) ? data.posts : [];
  renderList();
}

async function showYear(value) {
  if (!isValidId(value)) { setMessage("Wybierz rok szkolny.", true); return; }
  setMessage("");
  state.schoolYearId = value;
  yearSelect.value = value;
  filtersForm.querySelector("button").disabled = true;
  try {
    await Promise.all([loadList(), loadClasses()]);
    byId("detail").hidden = true;
    state.selected = null;
    byId("open-create").hidden = !(isSchoolWideEditor(state.grants, value) || representedClassIds(state.grants, value).length > 0);
    if (canReadPhotoRegister(state.grants, value)) await loadPhotos();
  } catch (error) {
    setMessage(`Nie udało się pobrać wpisów: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  } finally {
    filtersForm.querySelector("button").disabled = false;
  }
}

filtersForm.addEventListener("submit", (event) => {
  event.preventDefault();
  showYear(yearSelect.value);
});

async function loadClasses() {
  const data = await api(`/api/classes?schoolYearId=${encodeURIComponent(state.schoolYearId)}`).catch(() => ({ classes: [] }));
  state.classes = Array.isArray(data.classes) ? data.classes : [];
}

// --- rejestr zdjęć (tylko odczyt) --------------------------------------------------------------

function photoRow(photo, { withConsents }) {
  const row = document.createElement("tr");
  const rights = document.createElement("td");
  rights.dataset.label = "Prawa";
  rights.append(badge(RIGHTS_LABELS[photo.rightsStatus] ?? photo.rightsStatus, photo.rightsStatus));
  const actions = document.createElement("td");
  actions.className = "row-actions";
  if (withConsents) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Zgody";
    button.setAttribute("aria-label", `Zgody: ${photoSummary(photo)}`);
    button.addEventListener("click", () => showConsents(photo.id));
    actions.append(button);
  }
  row.append(cell(photoSummary(photo), "", "Zdjęcie"), rights, cell(peopleSummary(photo), "", "Osoby"), actions);
  return row;
}

async function loadPhotos() {
  try {
    const data = await api("/api/news-photos");
    state.photos = Array.isArray(data.photos) ? data.photos : [];
    state.photosTruncated = data.truncated === true;
  } catch {
    state.photos = [];
    state.photosTruncated = false;
  }
  byId("register-body").replaceChildren(...state.photos.map((photo) => photoRow(photo, { withConsents: true })));
  byId("register-section").hidden = false;
  byId("register-empty").hidden = state.photos.length !== 0;
  byId("register-count").textContent = state.photosTruncated
    ? `${state.photos.length} najnowszych zdjęć (rejestr jest dłuższy, starsze nie są pokazane)`
    : `${state.photos.length} zdjęć`;
}

// Odczyt statusu zgód jednego zdjęcia (GET /api/news-photos/:id) — bez żadnej zmiany.
async function showConsents(photoId) {
  const box = byId("consent-box");
  box.replaceChildren();
  try {
    const { photo } = await api(photoUrl(photoId));
    const heading = document.createElement("p");
    heading.textContent = `Zgody do zdjęcia (${RIGHTS_LABELS[photo.rightsStatus] ?? photo.rightsStatus}):`;
    box.append(heading);
    const list = document.createElement("ul");
    for (const consent of photo.consents ?? []) {
      const li = document.createElement("li");
      li.textContent = `${consentSummary(consent)} · dokument: ${consent.consentDocumentRef}`;
      list.append(li);
    }
    if (!(photo.consents ?? []).length) {
      const li = document.createElement("li");
      li.textContent = photo.depictsChildren ? "Brak odwołań do zgód (zdjęcie z dziećmi nie może być zweryfikowane bez nich)." : "Brak odwołań do zgód.";
      list.append(li);
    }
    if (photo.revokedAt) {
      const li = document.createElement("li");
      li.textContent = `Prawa cofnięte ${formatDateTime(photo.revokedAt)}.`;
      list.append(li);
    }
    box.append(list);
    box.scrollIntoView?.({ block: "nearest" });
  } catch (error) {
    setMessage(`Nie udało się pobrać zgód: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  }
}

// --- szczegóły wpisu -------------------------------------------------------------------------

async function openDetail(postId) {
  setMessage("");
  try {
    state.selected = await api(postUrl(postId));
    renderDetail();
    byId("detail").hidden = false;
    // #124: fokus na otwarty wpis (sekcja z tabindex="-1"), żeby klawiatura
    // i czytnik ekranu nie zostawały na liście pod przeczytanym przyciskiem.
    byId("detail").focus();
  } catch (error) {
    setMessage(`Nie udało się otworzyć wpisu: ${describeApiError(error.status, error.code) ?? error.message}`, true);
  }
}

// Po zmianie stanu odświeża listę i widok wpisu z serwera (jedno źródło prawdy).
async function refresh(postId) {
  await loadList();
  state.selected = await api(postUrl(postId));
  renderDetail();
}

function renderDetail() {
  const { post, revisions } = state.selected;
  byId("detail-title").textContent = post.title;
  const status = byId("detail-status");
  status.textContent = STATUS_LABELS[post.status] ?? post.status;
  status.className = `badge status-${post.status}`;
  byId("detail-scope").textContent = scopeLabel(post);
  byId("detail-revision").textContent = String(post.revision);
  byId("detail-approved").textContent = post.approvedRevision ? `wersja ${post.approvedRevision}, ${formatDateTime(post.approvedAt)}` : "—";
  byId("detail-published").textContent = post.publishedRevision ? `wersja ${post.publishedRevision}, ${formatDateTime(post.publishedAt)}` : "—";
  byId("detail-withdrawal-row").hidden = !post.withdrawnAt;
  byId("detail-withdrawal").textContent = post.withdrawnAt ? `${post.withdrawalReason ?? "—"} (${formatDateTime(post.withdrawnAt)})` : "";
  byId("detail-body").textContent = post.body; // tekst, nigdy HTML (docs/NEWS.md)
  byId("consent-box").replaceChildren();

  const photoRows = post.photoIds.map((id) => state.photos.find((p) => p.id === id) ?? { id, author: `zdjęcie ${id}`, rightsStatus: "unknown" });
  byId("detail-photos-body").replaceChildren(...photoRows.map((photo) => photoRow(photo, { withConsents: canReadPhotoRegister(state.grants, post.schoolYearId) })));
  byId("detail-photos-table").hidden = photoRows.length === 0;
  byId("detail-photos-empty").hidden = photoRows.length !== 0;

  byId("revisions-body").replaceChildren(...revisions.map((rev) => {
    const row = document.createElement("tr");
    row.append(cell(String(rev.revision), "amount", "Wersja"), cell(rev.title, "", "Tytuł"), cell(formatDateTime(rev.createdAt), "", "Zapisano"));
    return row;
  }));

  const actions = availableActions(post, { grants: state.grants, actorId: state.actorId });
  byId("act-edit").hidden = !actions.edit;
  byId("act-submit").hidden = !actions.submit;
  byId("act-approve").hidden = !actions.approve;
  byId("act-publish").hidden = !actions.publish;
  byId("act-withdraw").hidden = !actions.withdraw;
  byId("waiting").hidden = !actions.waitingForSecondPerson;
}

// Jedna operacja naraz (podwójne kliknięcie = jedno żądanie); serwer i tak jest
// idempotentny po numerze wersji (`revision`).
async function runAction(button, work) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  setMessage("");
  try {
    await work();
  } catch (error) {
    setMessage(`Operacja nie powiodła się: ${describeApiError(error.status, error.code) ?? error.message}`, true);
    if (error.code === "revision_conflict" && state.selected) await refresh(state.selected.post.id).catch(() => {});
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

function photoLines(post) {
  return post.photoIds.map((id) => {
    const photo = state.photos.find((p) => p.id === id);
    return photo ? `${photoSummary(photo)} — ${RIGHTS_LABELS[photo.rightsStatus] ?? photo.rightsStatus}` : `Zdjęcie ${id}`;
  });
}

byId("act-submit").addEventListener("click", (event) => runAction(event.currentTarget, async () => {
  const { post } = state.selected;
  await api(postUrl(post.id, "submit"), { method: "POST", body: { revision: post.revision } });
  await refresh(post.id);
  setMessage("Wpis zgłoszony do zatwierdzenia.");
}));

byId("act-approve").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const { post } = state.selected;
  const confirmed = await confirmAction({
    title: `Zatwierdź wpis „${post.title}”`,
    effects: [
      `Zatwierdzana jest wersja ${post.revision}; późniejsza zmiana treści cofnie wpis do szkicu.`,
      "Zatwierdzenie nie publikuje wpisu — publikacja to osobny krok.",
      ...(post.photoIds.length ? ["Zdjęcia we wpisie muszą mieć zweryfikowane prawa; serwer zablokuje zatwierdzenie w przeciwnym razie."] : []),
    ],
    confirmLabel: "Zatwierdź",
  });
  if (!confirmed) return;
  await runAction(button, async () => {
    await api(postUrl(post.id, "approve"), { method: "POST", body: { revision: post.revision } });
    await refresh(post.id);
    setMessage("Wpis zatwierdzony.");
  });
});

byId("act-publish").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const { post } = state.selected;
  const confirmed = await confirmAction({
    title: `Opublikuj wpis „${post.title}”`,
    effects: [
      `Wersja ${post.revision} stanie się publiczna na stronie Rady; przeglądarki mogą pokazywać starą wersję do 60 sekund po wycofaniu.`,
      ...photoLines(post),
      ...(post.photoIds.length ? ["Zasady publikacji zdjęć (D-18) nie są jeszcze zatwierdzone — nie publikuj zdjęć dzieci bez decyzji zarządu."] : []),
    ],
    warning: "Publikacja jest widoczna publicznie. Cofnąć ją można tylko wycofaniem wpisu.",
    confirmLabel: "Opublikuj",
    destructive: true,
  });
  if (!confirmed) return;
  await runAction(button, async () => {
    await api(postUrl(post.id, "publish"), { method: "POST", body: { revision: post.revision } });
    await refresh(post.id);
    setMessage("Wpis opublikowany.");
  });
});

// Wycofanie: okno z powodem → wspólne okno potwierdzenia → żądanie.
const reasonDialog = byId("reason-dialog");
byId("act-withdraw").addEventListener("click", () => {
  const form = reasonDialog.querySelector("form");
  form.reset();
  byId("reason-error").textContent = "";
  reasonDialog.showModal();
});
reasonDialog.querySelector("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { reasonDialog.close(); return; }
  const form = event.target;
  const reason = String(new FormData(form).get("reason") ?? "").trim();
  const problems = validateReason(reason);
  if (problems.length) { byId("reason-error").textContent = problems[0]; return; }
  reasonDialog.close();
  const { post } = state.selected;
  const confirmed = await confirmAction({
    title: `Wycofaj wpis „${post.title}”`,
    effects: [
      post.publishedRevision ? "Wpis natychmiast zniknie ze strony publicznej (z opóźnieniem pamięci podręcznej do 60 sekund)." : "Wpis nie był publikowany.",
      "Wycofanie jest ostateczne — wpisu nie można przywrócić ani usunąć; zostaje w historii.",
      `Powód (wewnętrznie): ${reason}`,
    ],
    confirmLabel: "Wycofaj wpis",
    destructive: true,
  });
  if (!confirmed) return;
  await runAction(byId("act-withdraw"), async () => {
    await api(postUrl(post.id, "withdraw"), { method: "POST", body: { revision: post.revision, reason } });
    await refresh(post.id);
    setMessage("Wpis wycofany.");
  });
});

// --- tworzenie i edycja szkicu -------------------------------------------------------------------

const editDialog = byId("edit-dialog");
const editForm = editDialog.querySelector("form");

function fillClassOptions(post) {
  const select = byId("edit-class");
  const wide = isSchoolWideEditor(state.grants, state.schoolYearId);
  const mine = new Set(representedClassIds(state.grants, state.schoolYearId));
  const options = [];
  if (wide) options.push({ value: "", label: "Cała szkoła" });
  for (const item of state.classes) {
    if (wide || mine.has(item.id)) options.push({ value: item.id, label: `Klasa ${item.name}` });
  }
  select.replaceChildren(...options.map(({ value, label }) => Object.assign(document.createElement("option"), { value, textContent: label })));
  select.value = post ? (post.classId ?? "") : (options[0]?.value ?? "");
  select.disabled = Boolean(post); // zakres wpisu nie zmienia się przy edycji
}

function fillPhotoPicker(post) {
  const fieldset = byId("edit-photos");
  const allowed = isSchoolWideEditor(state.grants, state.schoolYearId);
  fieldset.hidden = !allowed;
  if (!allowed) return;
  const chosen = new Set(post?.photoIds ?? []);
  const options = state.photos.filter((p) => p.rightsStatus === "verified" || chosen.has(p.id));
  const legend = fieldset.querySelector("legend");
  fieldset.replaceChildren(legend);
  if (!selectablePhotos(state.photos).length && !chosen.size) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Brak zdjęć ze zweryfikowanymi prawami.";
    fieldset.append(empty);
    return;
  }
  for (const photo of options) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "photoIds";
    input.value = photo.id;
    input.checked = chosen.has(photo.id);
    const text = document.createElement("span");
    text.textContent = `${photoSummary(photo)} — ${RIGHTS_LABELS[photo.rightsStatus] ?? photo.rightsStatus}; ${peopleSummary(photo)}`;
    label.append(input, text);
    fieldset.append(label);
  }
}

function openEdit(post) {
  state.editingId = post?.id ?? null;
  state.createKey = post ? null : makeIdempotencyKey();
  editForm.reset();
  byId("edit-error").textContent = "";
  byId("edit-dialog-title").textContent = post ? "Edytuj wpis" : "Nowy wpis";
  byId("edit-dialog-eyebrow").textContent = post ? "Nowa wersja" : "Szkic";
  editForm.elements.title.value = post?.title ?? "";
  editForm.elements.body.value = post?.body ?? "";
  fillClassOptions(post);
  fillPhotoPicker(post);
  editDialog.showModal();
}

byId("open-create").addEventListener("click", () => openEdit(null));
byId("act-edit").addEventListener("click", () => openEdit(state.selected.post));

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { editDialog.close(); return; }
  if (state.busy) return;
  const data = new FormData(editForm);
  const wide = isSchoolWideEditor(state.grants, state.schoolYearId);
  const photoIds = wide ? data.getAll("photoIds").map(String) : null;
  const classId = String(data.get("classId") ?? "") || null;
  const editing = state.editingId !== null;
  const problems = validateDraft(
    { title: data.get("title"), body: data.get("body"), photoIds: photoIds ?? [] },
    { classId, requireClass: !editing && !wide },
  );
  const errorBox = byId("edit-error");
  if (problems.length) { errorBox.textContent = problems[0]; return; }
  const button = event.submitter;
  state.busy = true;
  button.disabled = true;
  errorBox.textContent = "";
  try {
    const title = String(data.get("title")).trim();
    const body = String(data.get("body")).trim();
    if (editing) {
      const { post } = state.selected;
      await api(postUrl(post.id), {
        method: "PATCH",
        // Przedstawiciel nie zmienia zdjęć (serwer: photos_require_school_wide_role).
        body: { revision: post.revision, title, body, ...(photoIds ? { photoIds } : {}) },
      });
      editDialog.close();
      await refresh(post.id);
      setMessage("Zapisano nową wersję. Wpis wrócił do szkicu; opublikowana wersja pozostaje publiczna do zatwierdzenia nowej.");
    } else {
      const result = await api("/api/news", {
        method: "POST",
        idempotencyKey: state.createKey, // to samo ponowienie po błędzie sieci = jeden wpis
        body: { schoolYearId: state.schoolYearId, ...(classId ? { classId } : {}), title, body, ...(photoIds?.length ? { photoIds } : {}) },
      });
      editDialog.close();
      await loadList();
      await openDetail(result.post.id);
      setMessage("Szkic zapisany.");
    }
  } catch (error) {
    errorBox.textContent = describeApiError(error.status, error.code) ?? error.message;
  } finally {
    state.busy = false;
    button.disabled = false;
  }
});

// --- dostęp ---------------------------------------------------------------------------------

async function applyAccess() {
  let access;
  let session;
  try {
    [access, session] = await Promise.all([api("/api/access"), api("/api/session")]);
  } catch (error) {
    setMessage(error.message, true);
    return;
  }
  state.grants = Array.isArray(access.grants) ? access.grants : [];
  state.actorId = session?.user?.id ?? null;
  if (!hasNewsAccess(state.grants)) {
    filtersForm.closest("section").hidden = true;
    byId("access-notice").hidden = false;
    return;
  }
  const years = newsYears(state.grants);
  const initial = initialSchoolYearId(state.grants.filter((g) => years.includes(g.schoolYearId)));
  yearSelect.innerHTML = yearOptionsHtml(years.length ? years : [initial], initial);
  await showYear(yearSelect.value);
}
applyAccess();
