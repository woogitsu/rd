// Potwierdzenie zapisu tekstu z możliwymi danymi osobowymi (#152).
// Serwer zwraca 422 `possible_personal_data` (telefon, znane imię i nazwisko) —
// klient pyta użytkownika i dopiero po potwierdzeniu ponawia to samo żądanie
// (ten sam klucz idempotencji) z `confirmPersonalData: true`. E-mail, IBAN i numer
// rejestru krajowego serwer odrzuca bez możliwości potwierdzenia
// (`personal_data_forbidden`) — tu ich nie obsługujemy.
import { confirmAction } from "./confirm-dialog.js";

export const PERSONAL_DATA_HINT =
  "Ten wpis jest niezmienny i trafi do eksportu. Nie wpisuj imion dzieci, adresów e-mail, telefonów ani numerów rachunków — użyj identyfikatora rodziny.";

const CATEGORY_LABELS = {
  phone: "wygląda jak numer telefonu",
  known_name: "zawiera imię i nazwisko osoby znanej z bazy",
};

// Czysta funkcja: lista opisów kategorii (bez treści tekstu).
export function describeCategories(categories) {
  return (Array.isArray(categories) ? categories : []).map((category) => CATEGORY_LABELS[category]).filter(Boolean);
}

export function confirmPersonalData({ categories } = {}) {
  return confirmAction({
    title: "Tekst może zawierać dane osobowe",
    effects: describeCategories(categories),
    warning: "Ten tekst zostanie zapisany na stałe i trafi do eksportu — nie da się go potem poprawić ani usunąć. Usuń dane osobowe albo potwierdź, że to konieczne.",
    confirmLabel: "Zapisz mimo to",
    cancelLabel: "Wróć i popraw",
    destructive: true,
  });
}
