# Panel wpłat

Lekki interfejs do chronionego API ewidencji dobrowolnych wpłat. Nie zawiera danych demonstracyjnych ani obejścia uwierzytelniania.

## Uruchomienie

```bash
npm run dev
npm run dev:panel
```

`wrangler dev` udostępnia API, a Vite interfejs. W środowisku docelowym panel i API powinny działać pod tym samym originem; żądania używają ciasteczka sesji i serwerowych reguł ról.

## Zakres

- filtrowanie listy po roku szkolnym i statusie,
- rejestracja wpłaty z kluczem idempotencji,
- dopisywanie korekty bez zmiany historycznego rekordu,
- jednokrotne przypisanie nierozpoznanej wpłaty do rodziny,
- kwota netto obliczana jako wpłata plus suma korekt.

Panel celowo nie wylicza zadłużenia: składka jest dobrowolna. Identyfikatory roku i rodziny są na tym etapie wprowadzane ręcznie, dopóki nie powstanie chroniony katalog rodzin i konfiguracja lat szkolnych.
