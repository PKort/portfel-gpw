# Propozycja integracji bossaAPI

Analiza z 31.10.2026 na podstawie lokalnego PDF „Dokumentacja bossaAPI – Pilotaż” (aktualizacja 23.10.2026, 55 stron), archiwum `bossaAPI_client_0_1.zip` i bieżącego kodu aplikacji. Numery stron poniżej odnoszą się do numeracji drukowanej dokumentu (numer strony PDF jest o jeden większy). Nie uruchamiano klienta dostawcy ani połączeń z bossaAPI; nie korzystano z prywatnych kluczy.

## Rekomendacja

Wdrożyć niezależnie dwa moduły: najpierw notowania REST bezpośrednio w Node.js, następnie odczyt rachunku FIX przez osobny kontener Java/QuickFIX/J. Składanie zleceń pozostawić poza początkowym zakresem. Obecna aplikacja może zachować Node.js, SQLite, model aktywów i obliczenia FIFO/AVP.

```text
Przeglądarka → nginx → Node.js → SQLite
                         ├─ HTTPS → bossaAPI notowania (Statica)
                         └─ wewnętrzne HTTP → adapter Java → FIX/TLS → DM BOŚ
```

Adapter FIX nie zapisuje bezpośrednio do bazy portfela. Node pozostaje właścicielem danych aplikacji. Odczyt rachunku ma początkowo służyć porównywaniu danych, bez automatycznego zmieniania historii operacji.

## Co faktycznie udostępniają materiały

| Obszar | Interfejs | Zastosowanie |
| --- | --- | --- |
| Kursy, informacje o instrumencie, oferty, transakcje rynkowe | REST/JSON `https://bossaapi.statica.pl/v1/...` | Wycena i ewentualne przyszłe widoki rynku |
| Lista rachunków i uprawnienia, stan gotówki i papierów | FIX 5.0 przez FIXT.1.1, TLS 1.3, `bossaapi.bossa.pl:4581` | Porównanie portfela ze stanem brokera |
| Zlecenia i raporty realizacji | FIX | Osobny późniejszy projekt obsługi zleceń i importu realizacji |

Są dwa odrębne klucze: do notowań i systemu transakcyjnego. PDF opisuje ważność kluczy 1–30 dni oraz możliwość przedłużenia (s. 3). Pilotaż nie oznacza automatycznie odizolowanego rachunku demonstracyjnego. Nie należy wysyłać zleceń w celu sprawdzenia połączenia.

REST `/trades` zwraca transakcje rynku dla instrumentu, a nie operacje klienta. `PositionReport` opisuje stan rachunku, a nie historię zakupów, wpłat, dywidend czy kosztów podatkowych. W materiałach nie ma udokumentowanego kompletnego importu takiej historii. Nie można odtworzyć FIFO z samego stanu papierów ani zastąpić naszej ceny zakupu średnią brokera.

## Etap 1: notowania REST

### Dopasowanie do obecnego kodu

- Dodać `bossa.js` jako adapter REST i identyfikator źródła `bossa` w `providers.js`, rejestracji `price_sources` oraz interfejsie wyboru źródła w `app.js`.
- Rozszerzyć `quote-collector.js` o pobieranie grup instrumentów: obecna pętla wywołuje adapter osobno dla każdego aktywa, co nie wykorzystuje modelu limitów bossaAPI.
- Wykorzystać istniejące `asset_price_feeds`, `asset_price_aliases`, `price_observations` i `asset_price_preferences`. Zmiana źródła powinna zachować dotychczasową wycenę do pierwszej poprawnej odpowiedzi, zgodnie z obecnym zachowaniem `saveFeedSettings`.
- Rozszerzyć walidację aliasów o format `GPW:ISIN`; bieżące wyrażenia regularne dostawców nie dopuszczają dwukropka. Zweryfikować ISIN, rynek oraz zgodność z aktywem.
- Umożliwić uzupełnianie ISIN w edycji aktywa. Kolumna `assets.isin` już istnieje; nie wyprowadzać ISIN ze skrótu tickera.

### Identyfikacja i zapis

1. Pobrać i lokalnie zapamiętać katalog `/v1/instruments/GPW`, na żądanie lub z długim terminem ważności. Operacja kosztuje 1000 punktów; nie wykonywać jej przy każdym odświeżeniu.
2. Zaproponować dopasowania po tickerze, następnie potwierdzić przez `/v1/info/...`: `source`, `isin`, `curr`, `ticker`, `mult`. Niejednoznaczne dopasowania wymagają wyboru użytkownika. Na początek obsługiwać instrumenty zgodne z obecnym modelem GPW/PLN i mnożnikiem 1; pozostałe pokazywać jako nieobsługiwane.
3. Utrzymywać jawne mapowanie rynku aplikacji `XWAR` na kod REST `GPW`. Kody REST, FIX i MIC nie są uniwersalnie zamienne. Objęcie NewConnect kodem GPW wymaga sprawdzenia katalogu i uprawnień na rzeczywistym dostępie.
4. Kurs pobierać z `/v1/data/...`: `p` to cena ostatniej transakcji, `t` to jej czas Unix w sekundach (s. 48–49). Zapisywać `priceType: last`, `quotedAt: t * 1000`, osobne `receivedAt` oraz walutę z potwierdzonych metadanych. Nie stosować `c` (zamknięcie) jako cichego zamiennika `p`.
5. Klucz deduplikacji wyprowadzić z tożsamości instrumentu, czasu i ceny. Nie zmieniać czasu notowania na czas pobrania przy braku transakcji. Nie nadpisywać poprawnych danych odpowiedzią niekompletną.

### Limity i błędy

PDF dopuszcza do 20 instrumentów w zapytaniu. `/data` kosztuje 1 punkt dla jednego instrumentu i 2 punkty dla wielu, za całe zapytanie (s. 39–44). Propozycja: zachować początkowy interwał 300 sekund, grupować należne odświeżenia po maksymalnie 20 instrumentów i scalać równoczesne żądania użytkownika.

Przykład: 20 instrumentów odpytywanych co 5 minut przez całą dobę to 576 punktów na dobę przy pełnym koszcie, wobec 5760 przy osobnych zapytaniach. To wyliczenie dla `/data`, bez metadanych; dokument przewiduje obniżkę kosztu poza sesją. Rzeczywiste limity odczytywać z `/v1/limits`, a nie zakładać na podstawie przykładowych 2 mln/miesiąc i 1000/minutę. Endpoint limitów nie pobiera punktów i nie działa w demo.

Sprawdzać zarówno HTTP, jak i `op`: błędy źródła mogą przyjść z HTTP 200 i `op: error` (s. 40). W odpowiedzi grupowej brakujące instrumenty mogą być pominięte — rozliczać sukces lub błąd każdego aktywa osobno. Zachować sprawdzenie archiwizacji i zmiany konfiguracji po odpowiedzi, obecne w kolektorze.

Dotychczasową godzinną przerwę po 401/403/429 trzeba dla bossaAPI uszczegółowić: brak/wygaśnięcie autoryzacji wymaga poprawienia klucza, limit minutowy krótkiej przerwy, miesięczny zatrzymania do odnowienia budżetu. Sprawdzać `/limits`, uwzględniać `Retry-After`, jeżeli występuje, i unikać serii ponowień. Dla timeoutów/502 stosować ograniczone ponowienia z rosnącym odstępem. Pokazywać stan autoryzacji, zużycie limitu i ostatnie udane pobranie.

Publiczny klucz `0000` daje celowo zniekształcone liczby i ISIN `PLDEMO000000` (s. 36, 49). Demo może służyć wyłącznie testowi transportu/parsera w izolacji; nie zapisujemy jego danych do wyceny. Uprawnienia i ewentualne opóźnienie danych rzeczywistych należy ustalić dla przyznanego pakietu, bez obiecywania czasu rzeczywistego.

## Etap 2: odczyt rachunku FIX

ZIP to demonstracyjna aplikacja konsolowa Java 21+, Spring Boot i QuickFIX/J. Loguje się kluczem w polu 554, odczytuje rachunki i uprawnienia z `Logon`, a po podaniu numeru rachunku wysyła `RequestForPositions` z subskrypcją aktualizacji. `fromApp` jedynie loguje komunikaty: nie ma parsera raportów, modelu stanu rachunku ani integracji HTTP.

Proponowany adapter:

- Jedna sesja FIX z trwałym UUID urządzenia i stanem silnika na osobnym wolumenie; ponowne uruchomienie kontenera zachowuje tożsamość. Zweryfikować certyfikat i nazwę hosta TLS.
- Ścisła lista dozwolonych komunikatów wychodzących: administracyjne oraz odczyt `RequestForPositions`; brak endpointu wysyłającego dowolny FIX. Stan sesji i dostępne prawa widoczne w diagnostyce.
- Wewnętrzne endpointy, np. `/health`, `/accounts`, `/accounts/:id/snapshot`, zabezpieczone poświadczeniem usługi i dostępne tylko w sieci kontenerów. Przeglądarka komunikuje się z Node.
- Składanie kompletnego obrazu z wielu `PositionReport`, z uwzględnieniem `TotalNumPosReports`, rachunku, żądania i `BosPosRepFinCount`. Publikacja kompletnego obrazu atomowo; nie pokazywać częściowego obrazu jako pełnego. Po zerwaniu połączenia oznaczyć dane jako nieaktualne i pobrać nowy obraz po zalogowaniu.
- Rozdzielenie gotówki, należności, blokad i środków na kupno. `BCAV` nie jest prostym odpowiednikiem gotówki aplikacji. Podobnie nie sumować bez analizy nakładających się kategorii papierów `B110`, `B120`, `B210`, `BBLK`.
- Dla rachunków zagranicznych dokument przewiduje raporty finansowe w PLN/USD/EUR/GBP. Na początek wybrać jawnie jeden rachunek PLN; pozostałe oznaczyć jako poza zakresem, bez scalania z obecnym portfelem.

Node zapisuje odrębne rachunki i obrazy brokera, np. `broker_accounts`, `broker_snapshots`, `broker_positions`, `broker_cash_balances`, powiązane z aktywami przez ISIN i rynek. Widok „Porównanie z bossa” pokazuje ilości, kategorie salda i różnice. Brak instrumentu w częściowej aktualizacji nie oznacza pozycji zerowej. Semantykę usuwania pozycji i kolejność aktualizacji trzeba potwierdzić z dostawcą.

Nie zastępować obecnych transakcji obrazem rachunku: zniszczyłoby to podstawę FIFO/AVP, historię wpłat i wynik portfela. Jeśli kiedyś potrzebny będzie import stanu początkowego, wymaga on osobnego modelu i podania kosztów nabycia.

## Rozbieżności i ograniczenia materiałów

- README klienta wskazuje port 4551, ale PDF s. 7 i `quickfix-client.cfg` wskazują **4581**. Przyjąć 4581 jako konfigurację wynikającą z nowszego PDF, sprawdzić podczas testu połączenia.
- Słowniki ZIP zawierają nowsze pola `BosRefPrice` i `BosPosRepFinCount`, ale przykładowe klasy Java nie implementują całej obsługi rachunku. Zachować dostarczone rozszerzenia XML i testować je z rzeczywistymi odpowiedziami.
- Przykład używa `LocalDateTime.now()` w polu `TransactTime`, które dokument wymaga w UTC. W adapterze jawnie stosować UTC; datę biznesową ustalać według właściwego rynku.
- Przykład maskuje klucz we własnym komunikacie logowania, lecz jednocześnie włącza `FileLogFactory`. Przed użyciem należy zapewnić redakcję pola 554 również w logach silnika i sprawdzić wszystkie miejsca trwałego zapisu sekretu.
- `ResetOnLogon=Y` odpowiada wymaganiu resetu w PDF. Nie zakładać, że ponowne połączenie automatycznie odtworzy wszystkie utracone realizacje. Odtwarzanie historii i gwarancje kompletności wymagają wyjaśnienia.
- Dokumentacja `/trades` ma niespójny przykład liczby odebranych transakcji i indeksów (s. 52). Nie implementować kursora na podstawie samego przykładu; ustalić semantykę z dostawcą przed dodaniem historii tickowej.

## Sekrety i wdrożenie

Aktualizacja wdrożenia: zgodnie z decyzją użytkownika klucz notowań przechowujemy w lokalnym `.env` jako `BOSSA_QUOTES_API_KEY`. Serwer wczytuje plik przy uruchomieniu; Docker Compose przekazuje zmienną do kontenera aplikacji. `.env` jest wykluczony z Git, kontekstu budowania obrazu i serwowania HTTP. REST wysyła klucz nagłówkiem `Authorization`, aby nie trafiał do URL i logów adresów. Nie przekazywać klucza do przeglądarki, SQLite ani eksportu portfela. Klucz do FIX pozostaje poza bieżącym zakresem integracji.

Obecny `server.js` udostępnia pliki z katalogu roboczego, a nie z jawnej listy zasobów publicznych. Przed dodaniem konfiguracji integracji ograniczyć serwowanie do plików interfejsu. Nie umieszczać w tym katalogu kluczy, stanów FIX ani raportów rachunku. Adapter uruchamiać bez roota, bez publikacji portu na hosta, z osobnym wolumenem stanu. Brak adaptera FIX nie może zatrzymać aplikacji ani pobierania kursów REST.

## Kolejność realizacji i odbiór

1. **Notowania:** adapter REST, mapowanie ISIN, grupowanie zapytań, obsługa limitów i klucza, trzecie źródło w UI. Bez automatycznego przełączania wszystkich aktywów.
2. **Sprawdzenie na rzeczywistym dostępie:** kilka instrumentów, porównanie tożsamości/ceny/czasu z terminalem, sprawdzenie zużycia punktów i utraty autoryzacji. Najpierw oddzielna baza testowa.
3. **Rachunek tylko do odczytu:** adapter FIX, wybrany rachunek, kompletne obrazy, porównanie stanów i test odtworzenia połączenia.
4. **Dalszy zakres:** ewentualny import realizacji i operacji pieniężnych dopiero po ustaleniu dostępnej historii, prowizji, korekt i identyfikatorów. Obsługa zleceń wymaga osobnego projektu.

Testy REST powinny obejmować HTTP 200 z błędem w JSON, brak części instrumentów, zły ISIN/walutę, brak ceny/czasu, demo, limity, duplikaty oraz zmianę konfiguracji podczas pobierania. Testy FIX: kompletny i niekompletny obraz, duplikaty, aktualizacje, puste pozycje, wiele walut, rozłączenie i ponowną subskrypcję, brak sekretów w logach. Po implementacji uruchomić `npm test`, `npm run test:api` i kontrolę składni zmienionych plików.

Do wyjaśnienia z dostawcą przed automatycznym importem: dostępność historii realizacji po rozłączeniu, stabilność i zakres unikalności `ExecID`, sposób naliczania prowizji przy częściowych realizacjach, korekty/anulowania transakcji, historia gotówki i dywidend oraz semantyka kategorii pozycji. Sam `ExecutionReport` z `ExecType=F`, `LastQty`, `LastPx` i opcjonalną prowizją nie gwarantuje kompletnej księgi. Nowy import musi mieć deduplikację oraz rozpoznawać operacje już wpisane ręcznie.
