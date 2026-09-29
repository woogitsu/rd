// Stałe wspólne dla seeda demo i generatora PDF (bez cykli importów).
// Identyfikator roku jest techniczny (URL/API/dane); etykieta dla ludzi pochodzi z
// jednej funkcji formatującej (shared/school-year.js), nie z drugiego literału.
import { formatSchoolYear } from '../../shared/school-year.js';

export const SCHOOL_YEAR_ID = '2026-2027';
export const SCHOOL_YEAR_LABEL = formatSchoolYear(SCHOOL_YEAR_ID);
