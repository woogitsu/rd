# Źródło listy `weak-passwords-10k.txt` (#196, D-10)

Plik `weak-passwords-10k.txt` to **niezmieniona** kopia listy 10 000 najpopularniejszych haseł
z projektu SecLists (Daniel Miessler et al.), ścieżka `Passwords/Common-Credentials/10k-most-common.txt`.

- Adres pobrania: https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10k-most-common.txt
- Data pobrania: 2026-10-02 (gałąź `master`; identyfikator commitu nie był dostępny przez proxy)
- Licencja: MIT (https://github.com/danielmiessler/SecLists/blob/master/LICENSE), pełny tekst poniżej; MIT pozwala na redystrybucję z zachowaniem noty
- SHA-256: `68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce`
- Liczba wierszy: 10 001 (po jednym w wierszu, bez komentarzy)
- Dane osobowe: brak (lista haseł, bez loginów i adresów e-mail)

Sumę pilnuje `tests/pg-password-policy.test.js`. Plik nie ma nagłówka, bo każda zmiana bajtu zmieniłaby sumę;
dlatego opis jest tutaj. Aktualizacja listy = nowy plik, nowa suma i nowa data w tym dokumencie.

Obróbka przy wczytaniu (`src/pg/password.js`): wpis jest zapisywany małymi literami i bez diakrytyków (jak hasło w polityce),
a wpisy krótsze niż minimalna długość hasła (12 znaków) są pomijane, bo takie hasło odrzuca już sprawdzenie długości.
Pozostałą małą listę ręczną (≥ 12 znaków) zawiera osobno `weak-passwords.txt`.

## Licencja SecLists (MIT)

```
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
