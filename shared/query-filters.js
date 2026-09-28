// Stan filtrów w adresie (query string), nie w localStorage — issue #128, p.5.
// Czyste funkcje: łatwe do przetestowania bez DOM, bez zależności od window.location.

// Buduje query string z obiektu filtrów, pomijając wartości puste/domyślne.
export function filtersToQuery(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

// Odczytuje filtry z query string; `keys` ogranicza się do znanych pól formularza
// (nie ufamy dowolnym parametrom w adresie).
export function filtersFromQuery(search, keys) {
  const params = new URLSearchParams(search || "");
  const out = {};
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}
