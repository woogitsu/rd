// Macierz autoryzacji (issue #4), część 3 z MATRIX_PARTS (#111): ciągły fragment tras macierzy
// (granice: MATRIX_PART_STARTS w tests/helpers/authz-matrix.js, tam też opis, co sprawdza każdy
// przypadek). Część 1, testy uzupełniające i meta-test podziału (każda trasa w dokładnie jednej
// części, moduł nierozcięty) są w tests/pg-authz-matrix.test.js. Wyłącznie dane syntetyczne;
// żadna trasa nie wysyła poczty.
import { registerMatrixRoutes } from './helpers/authz-matrix.js';

registerMatrixRoutes(3);
