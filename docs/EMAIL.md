# Dobrowolne składki — przypomnienia e-mail

## Dostawca i pojemność
Brevo Free: do 300 wysłanych wiadomości dziennie, limit wspólny dla konta. Przy maksymalnie 2000 adresatach jednej kampanii potrzeba co najmniej 7 dni (6 × 300 + 200), jeżeli nie ma innych wiadomości. Liczba adresatów nie wynika wprost z liczby uczniów: liczyć unikalne adresy, politykę wysyłki do jednego lub obu opiekunów i brak duplikatów przy rodzeństwie. Przed produkcją sprawdzić bieżący regulamin dostawcy, domenę i warunki przetwarzania danych.

## Przepływ
1. Skarbnik/zarząd tworzy kampanię dla roku szkolnego.
2. Serwer buduje listę uprawnionych rodzin, deduplikuje opiekunów i sprawdza aktualne wpłaty.
3. Użytkownik widzi liczebność, próbkę, wykluczenia, podgląd spersonalizowanej treści i plan wysyłki na dni.
4. Uprawniona osoba zatwierdza dokładną wersję treści i odbiorców; każda późniejsza zmiana wymaga ponownej akceptacji.
5. Zadanie Railway z kolejką PostgreSQL wysyła indywidualnie, ogranicza ruch poniżej limitu, używa klucza idempotencji kampania+rodzina+odbiorca.
6. Webhook zapisuje wynik; bounce wyłącza błędny adres i zgłasza potrzebę poprawy.
7. Raport pokazuje wysłane, oczekujące, błędy i pominięte po wpłacie. Wznowienie nie duplikuje wiadomości.

## Treść
Neutralna i dyskretna: „przypomnienie o możliwości wniesienia dobrowolnej składki”, bez określenia „dług”, bez nazwiska dziecka w temacie. Podaj zatwierdzone dane do wpłaty, kontakt oraz „jeśli wpłata została już wykonana, prosimy pominąć wiadomość”. Dane konta bankowego pobierać z konfiguracji zatwierdzonej dla danego roku.

## Wdrożenie
Brevo API key w sekrecie serwera, zweryfikowana domena, SPF/DKIM/DMARC, osobny adres nadawcy i podpisany webhook. Nie wysyłać poczty bezpośrednio z przeglądarki ani nie ujawniać klucza w frontendzie. Najpierw testy na kilku własnych adresach i potwierdzenie szablonu przez Radę.

Źródło limitu: https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
