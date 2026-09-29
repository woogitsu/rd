// Skrócony identyfikator do tabel dla ludzi (przegląd demo: pełne UUID w kolumnach
// „Autor”/„Identyfikator”). Pełna wartość zostaje w atrybucie title komórki.
export function shortId(value) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}
