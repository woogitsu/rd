# Panel księgi

Lokalnie uruchom Worker (`npm run dev`) oraz interfejs (`npm run dev:ledger`). Panel nie ma danych demonstracyjnych i korzysta wyłącznie z chronionych tras `/api/ledger`; użytkownik musi mieć aktywną sesję, MFA, rolę finansową oraz dostęp do wskazanego roku.

Panel udostępnia podsumowanie roku, aktualny preliminarz, filtrowaną listę wpisów, formularz przychodu lub wydatku oraz addytywne korekty. Wydatki powyżej 3000 EUR wymagają referencji uchwały. Identyfikator dokumentu można podać wyłącznie dla dokumentu już utworzonego w chronionym magazynie — przesyłanie plików będzie osobnym etapem.

Nie używać na danych rzeczywistych przed zatwierdzeniem zasad dostępu, księgowania i korekt.
