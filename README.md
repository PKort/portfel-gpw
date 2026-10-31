# Portfel GPW

Aplikacja webowa do zapisywania transakcji na GPW i liczenia wyniku metodą FIFO lub AVP. Działa jako kontener, a dane przechowuje w bazie SQLite na trwałym wolumenie.

Aplikacja powstała z pomocą AI. Kod jest udostępniony na licencji MIT — zobacz [LICENSE](LICENSE).

## Odświeżanie i pamięć podręczna

API zwraca `Cache-Control: no-store`, a pliki aplikacji `Cache-Control: no-cache`, także dla modułów importowanych przez JavaScript. Aplikacja nie rejestruje Service Workera. Przed uruchomieniem usuwa dawną rejestrację o zakresie równym katalogowi aplikacji (obecnie `/`) i w razie potrzeby przeładowuje stronę. Nie usuwa Cache Storage ani danych portfela.

Jeżeli dawny worker nadal zwraca stary HTML, kod migracji nie może się uruchomić. W Firefoxie należy jednorazowo wyrejestrować worker dla adresu aplikacji w `about:debugging#/runtime/this-firefox`, zamknąć karty aplikacji i otworzyć ją ponownie. Adres i port powinny być przeznaczone wyłącznie dla tej aplikacji.

Po wdrożeniu zmian w Dockerze wykonaj `docker compose up -d --build`.

## Uruchomienie lokalne

Wymagany jest Node.js 24 lub nowszy:

```powershell
npm start
```

Aplikacja będzie dostępna pod `http://localhost:3000`.

## Uruchomienie w Dockerze

```bash
docker compose up -d --build
```

Aplikacja będzie dostępna pod `http://localhost:8080` (z innego komputera: `http://ADRES_SERWERA:8080`). Ruch przechodzi przez nginx reverse proxy działający bez uprawnień roota. Port 3000 aplikacji jest dostępny tylko w sieci Dockera i nie jest publikowany na hoście. Baza znajduje się w nazwanym wolumenie `portfel-data` i pozostaje po odtworzeniu kontenera.

Port HTTP można zmienić, np. `HTTP_PORT=80 docker compose up -d --build`, lub ustawić `HTTP_PORT=80` w pliku `.env`.

Konfiguracja proxy znajduje się w `nginx/default.conf`. Środowisko testowe korzysta z HTTP bez SSL. Na produkcji nginx kończący TLS powinien przekazywać do aplikacji nagłówki `Host`, `X-Real-IP`, `X-Forwarded-For` i `X-Forwarded-Proto` (dla HTTPS: `https`). Obecna konfiguracja zakłada, że nginx jest bezpośrednim punktem wejścia; przy dodaniu przed nim kolejnego proxy kończącego TLS trzeba dostosować przekazywanie nagłówków i zaufanie do tego proxy.

Po zmianie konfiguracji nginx sprawdź ją i przeładuj:

```bash
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
```

Podobnie jak w projekcie Financial Projection można przebudować cały stos skryptem:

```bash
./bounce.sh
```

Aktualizacja po zmianie kodu:

```bash
git pull
docker compose up -d --build
```

Przed wystawieniem aplikacji do Internetu dodaj uwierzytelnianie lub umieść ją za istniejącym reverse proxy z kontrolą dostępu.

## Definicje aktywów

Menu **Aktywa** pozwala dodawać, edytować i usuwać definicje aktywów (nazwę, główny ticker oraz symbole lub nazwy na różnych platformach). Nazwa jest widoczna w pozycjach i historii transakcji; główny ticker pozostaje widoczny poniżej. Formularz transakcji podpowiada tickery ze słownika.

Przycisk **Archiwizuj** ukrywa instrument z listy i zatrzymuje jego obserwowanie, także przy otwartej pozycji. Transakcje, symbole i historia cen pozostają w bazie. Ponowne dodanie tego samego tickera przywraca ten sam instrument. Zmiana tickera nie zmienia identyfikatora ani powiązań danych. Archiwizowane pozycje pozostają w wycenie portfela.

Każda platforma może mieć jeden symbol dla danego aktywa; para platforma–symbol nie może wskazywać dwóch aktywów. Symbole platform pozostają słownikiem; konfiguracja automatycznego źródła cen jest odrębna.

## Automatyczne kursy: Yahoo Finance i Bankier.pl

Serwer pobiera kursy wszystkich niezarchiwizowanych instrumentów GPW i NewConnect, również bez transakcji. Działa niezależnie od przeglądarki, domyślnie co 5 minut. Nowe instrumenty są wykrywane w ciągu około 30 sekund; domyślnym dostawcą pozostaje Yahoo Finance.

W tabeli **Aktywa → Źródło i aliasy kursów** są dwa pola obok siebie: lista dostawców oraz symbol na wybranej platformie. Zmiana pozycji na liście pozwala edytować alias bez przełączania notowań. Aby zmienić domyślne źródło, zaznacz obok symbolu **Domyślny** i kliknij **Zapisz**. Domyślny dostawca ma gwiazdkę i oznaczenie na liście; bieżącego domyślnego źródła nie można odznaczyć bez wskazania innego. Przykłady: PRIME → Yahoo `PRA.WA`, Bankier `PRIME`; 11BIT → Yahoo `11B.WA`, Bankier `11BIT`. Aliasy są zapamiętywane niezależnie od wybranego źródła i głównego tickera. Przełączenie uruchamia pobranie z wybranego źródła; dopiero poprawny kurs staje się podstawą wyceny. Błąd zachowuje poprzednią cenę i źródło, a serwer ponawia próby dla nowej konfiguracji.

Yahoo korzysta z publicznego, nieoficjalnego endpointu bez klucza API. Bankier korzysta z publicznej strony instrumentu: odczytuje cenę i czas z nagłówka HTML, sprawdza symbol, PLN i poprawność ISIN (również zgodność, jeśli ISIN jest zapisany w `assets`). Czas lokalny Bankiera jest przeliczany ze strefy `Europe/Warsaw` na UTC z uwzględnieniem czasu letniego. Zmiana formatu strony, brak pól lub blokada dostępu powoduje błąd; nie zastępujemy wtedy kursu zerem ani czasem pobrania. Dostępność publicznych interfejsów może się zmieniać. Zapisujemy cenę ostatniego notowania (`last`), bez importowania skorygowanych szeregów historycznych.


- `QUOTES_ENABLED=0` wyłącza automatyczne pobieranie i przycisk pobierania. Domyślnie jest włączone (`1`).
- `QUOTES_INTERVAL_SECONDS=300` ustala interwał na instrument; minimalna wartość to 60. Docker Compose przekazuje oba ustawienia ze środowiska lub `.env`.
- Przycisk **Pobierz kursy** uruchamia sprawdzenie instrumentów, dla których upłynął interwał; nie omija limitu ani przerwy dostawcy. Jeśli nic nie pobrano z powodu interwału, komunikat podaje liczbę pominiętych instrumentów i najbliższy termin próby.
- Ikona **↻** przy kursie pozycji i przy symbolu w tabeli aktywów pobiera kurs tylko danego instrumentu i po sukcesie przełącza wycenę na wybranego dostawcę, również gdy wcześniej używano nowszej ceny ręcznej. Pomija interwał tego instrumentu, ale respektuje wyłączenie integracji i przerwę dostawcy. Przy błędzie zachowuje poprzedni kurs i źródło.
- Znaczniki przy kursach rozróżniają aktywną wycenę zewnętrzną i ręczną oraz pokazują błąd pobierania, brak konfiguracji/danych, wyłączoną integrację lub brak odświeżania. Sukces oznacza udane pobranie, a nie gwarancję świeżego notowania giełdowego; czas ceny pozostaje widoczny poniżej. Dłuższy brak pobrania jest sygnalizowany po większej z wartości: 15 minut lub trzy interwały.
- Przeglądarka odświeża wyświetlane dane co minutę, gdy użytkownik nie edytuje formularza.
- Pierwsza poprawna odpowiedź wybranego dostawcy wybiera go jako źródło wyceny. Do tego czasu istniejące kursy ręczne lub zastane pozostają aktywne. Po przełączeniu pole ceny jest tylko do odczytu; API nadal pozwala zapisywać osobną serię ręczną.
- Sprawdzamy tożsamość instrumentu, walutę, cenę i czas. Błąd jednego instrumentu nie usuwa dotychczasowych danych i nie blokuje pozostałych. Błędy są widoczne w tabeli aktywów. HTTP 401, 403 lub 429 wstrzymuje kolejne próby dla danego źródła na godzinę; pozostali dostawcy nadal działają.
- Archiwizacja zatrzymuje pobieranie. Także odpowiedź na żądanie rozpoczęte przed archiwizacją jest pomijana. Powtarzające się notowanie nie tworzy duplikatów; czas ostatniego udanego pobrania jest aktualizowany niezależnie.

Endpointy: `POST /api/quotes/refresh` uruchamia sprawdzenie, `POST /api/quotes/refresh/:ticker` pobiera pojedynczy kurs i przełącza źródło po sukcesie, `PUT /api/price-feeds/:ticker` z `{ "sourceId": "bankier", "symbols": { "yahoo": "PRA.WA", "bankier": "PRIME" } }` zapisuje aliasy i wybranego dostawcę. Można przesłać tylko część aliasów; pozostałe są zachowywane. `makeDefault: false` zapisuje aliasy bez przełączania dostawcy; domyślnie `makeDefault` wynosi `true` dla zgodności z wcześniejszym API. Starszy format `{ "symbol": "PKO.WA" }` nadal wybiera Yahoo. `GET /api/state` zwraca dodatkowo `quoteDetails` (źródło i czasy kursu) i `observedAssets` (statusy pobierania). Domyślne testy używają odpowiedzi kontrolowanych i nie wymagają sieci.

## Historia cen i model bazy

Aplikacja pobiera kursy z Yahoo Finance lub Bankier.pl. Import wcześniejszej historii i wykres historycznej wartości portfela nie są jeszcze zaimplementowane. Ręczne wpisanie kursu dopisuje obserwację z bieżącym czasem zamiast nadpisywać poprzedni kurs.

- `schema_migrations` zapisuje wersje migracji i czas ich zastosowania.
- `assets` ma stały UUID, ticker, nazwę, rynek (`XWAR`), walutę (`PLN`), opcjonalny ISIN i czas archiwizacji. Unikalna jest para rynek–ticker. Obecny interfejs i obliczenia nadal obsługują GPW/PLN.
- `transactions` i `asset_symbols` wskazują `assets.id`. Fizyczne usunięcie instrumentu z powiązaniami jest blokowane kluczami obcymi.
- `price_sources` definiuje źródła, deklarowane opóźnienie, wspólny interwał odpytywania (NULL dla strumienia lub nieskonfigurowanego źródła) i ich dostępność. Początkowo istnieją `manual` i `legacy`. Sekrety integracji nie należą do bazy.
- `asset_price_aliases` przechowuje osobny alias instrumentu dla każdego dostawcy. Migracja nr 2 zachowuje istniejące symbole aktywnych konfiguracji i uzupełnia je ze słownika platform `Yahoo Finance` / `Bankier.pl`. Późniejsza edycja słownika platform nie zmienia automatycznie aliasów integracji — edytuj je w kolumnie źródeł kursów.
- `asset_price_feeds` zawiera opcjonalne jedno automatyczne źródło i symbol na instrument oraz czas ostatniej próby, sukcesu i błąd. Wszystkie niezarchiwizowane instrumenty są obserwowane; bez konfiguracji otrzymują status `unconfigured`. `GET /api/observed-assets` udostępnia tę listę.
- `price_observations` przechowuje cenę w jednostkach 1/1 000 000 waluty, walutę, źródło, rodzaj (`last`, `close`, `manual`), czas notowania i odbioru w milisekundach UTC, datę sesji oraz klucz deduplikacji. Cena `close` wymaga daty sesji. Przechowujemy ceny surowe, bez korekt o zdarzenia korporacyjne.
- `asset_price_preferences` wskazuje serię do wyceny. Interfejs używa `saveFeedSettings`, które zachowuje dotychczasową serię do udanego pobrania; ręczny wpis nie przełącza skonfigurowanego źródła. Pierwszy ręczny wpis zastępuje wybór serii `legacy`.

`createPriceStore` w `prices.js` udostępnia zapis obserwacji, konfigurację źródła, listę obserwowanych instrumentów oraz odczyt ostatnich kursów. `getQuotes(timestamp)` wybiera obserwacje nie późniejsze niż wskazany czas; brak ceny oznacza brak klucza w wyniku. Obecny ekran portfela nadal używa dotychczasowej logiki obliczeń, w której brak kursu daje zero — obsługa niepełnej wyceny jest potrzebna przed wdrożeniem wykresów historycznych.

Adapter dostawcy musi zapewnić prawidłową walutę, rodzaj ceny, datę sesji oraz stabilny klucz zdarzenia. Powtórny zapis tego samego klucza dla instrumentu i źródła jest pomijany; korekty wymagają nowego klucza zdarzenia. Kolejność odbioru nie nadpisuje kolejności czasu notowania.

Migracja uruchamia się automatycznie przy starcie serwera i jest wykonywana w transakcji. Zachowuje transakcje, ustawienia FIFO/AVP, nazwy i symbole. Odtwarza również archiwalne definicje wcześniej usuniętych instrumentów występujących w danych. Stare kursy trafiają do źródła `legacy` bez znanego czasu notowania: pozostają dostępne w bieżącym widoku, lecz są wykluczone z odczytu historycznego.

**Przed pierwszym uruchomieniem nowej wersji wykonaj kopię bazy.** Po migracji starsza wersja aplikacji nie obsłuży nowego schematu; powrót do niej wymaga odtworzenia kopii. Usunięcie transakcji i wczytanie przykładu zachowują historię cen; przykład dopisuje dwa kursy ręczne. Nie ma obecnie operacji usuwania historii cen w interfejsie.

## Rozwijanie w VS Code i Codex

1. Otwórz w VS Code cały folder `Giełda`, a nie pojedynczy plik.
2. Utwórz repozytorium na GitHubie lub prywatnym serwerze Git i ustaw je jako `origin`.
3. Pracuj na osobnej gałęzi, np. `codex/import-csv`.
4. Opisz agentowi oczekiwane zachowanie i poproś o implementację wraz z testami.
5. Sprawdź zmiany w panelu kontroli wersji i uruchom `npm test`.
6. Po scaleniu zmian pobierz je na serwerze i przebuduj kontener.

Stałe wskazówki dla agenta znajdują się w `.cursor/rules/project-conventions.mdc`.

W WSL projekt otwiera się poleceniami:

```bash
cd ~/projects/portfel-gpw
code .
```

W lewym dolnym rogu VS Code powinno być widoczne połączenie `WSL: Debian`. Terminal, Git, Docker i agent pracują wtedy na tych samych linuksowych ścieżkach co projekt.

## Kopia zapasowa

Najważniejszym plikiem jest `/app/data/portfolio.db` wewnątrz wolumenu. Przed aktualizacją schematu bazy wykonaj jego kopię.

## Metoda wyliczania wyniku

Globalny wybór **FIFO / AVP** nad podsumowaniem przelicza historię, koszt otwartych pozycji i wyniki portfela. Domyślną metodą jest FIFO. W formularzu dodawania lub edycji sprzedaży można wybrać **Globalna**, **FIFO** lub **AVP**. Ręczny wybór ma pierwszeństwo przed ustawieniem globalnym. Ustawienia są zapisywane w SQLite i zachowywane po restarcie; istniejące transakcje dziedziczą metodę globalną.

FIFO rozlicza najstarsze partie zakupu. AVP rozlicza średni ważony koszt wszystkich posiadanych akcji i pozostawia resztę jako jedną partię o tym średnim koszcie. Przy mieszaniu metod późniejsza sprzedaż FIFO zaczyna od tej uśrednionej partii, a następnie rozlicza kolejne zakupy. Obie metody uwzględniają prowizje zakupu i sprzedaży.

Kolumna **Metoda** wskazuje sposób rozliczenia sprzedaży. Suma kolumny **Zysk/strata** odpowiada wynikowi zrealizowanemu w podsumowaniu (z możliwymi różnicami groszowymi przy zaokrąglaniu wyświetlanych wierszy). Transakcje są przetwarzane według daty, a w tym samym dniu według kolejności utworzenia. Edycja wcześniejszej transakcji lub jej metody przelicza także późniejsze wyniki.

## Gotówka na koncie maklerskim

Przycisk **Dodaj operację** w widoku **Portfel** otwiera wspólny formularz kupna, sprzedaży, zasilenia i wypłaty. Dla akcji podaje się aktywo, liczbę, cenę i prowizję; dla gotówki datę i kwotę. Podgląd pokazuje wpływ na saldo. Zasilenia i wypłaty można edytować i usuwać na wspólnej liście operacji. Historia jest zapisywana w SQLite. Zasilenie zwiększa saldo, wypłata je zmniejsza, kupno zmniejsza je o wartość akcji i prowizję, a sprzedaż zwiększa o wartość akcji pomniejszoną o prowizję. Rozliczenie każdej transakcji jest zaokrąglane do groszy. Edycja rozlicza różnicę, a usunięcie transakcji cofa jej wpływ na gotówkę. Saldo może być ujemne, np. przy uzupełnianiu historii przed dodaniem wpłat.

Saldo uwzględnia całą zapisaną historię, niezależnie od daty transakcji i kolejności dodawania. Starszy mechanizm punktu odniesienia jest wycofany; aktualizację istniejącej bazy opisuje [plan migracji gotówki](CASH-MIGRATION.md). Ręczne ustawienie salda jest korektą bieżącej kwoty; późniejsze zmiany historii nadal wpływają na saldo. Usunięcie wszystkich transakcji cofa ich wpływ, zachowując zasilenia i korekty. Wczytanie przykładu zastępuje transakcje, więc odpowiednio zmienia saldo.

Podsumowanie pokazuje gotówkę oraz łączną wartość portfela (wartość pozycji + gotówka). Gotówka nie wpływa na wynik zrealizowany ani niezrealizowany.

`PUT /api/settings` przyjmuje `cashBalance` (nieujemna korekta bieżącego salda z dokładnością do groszy) i/lub `costMethod`. Pominięte ustawienie zachowuje swoją wartość. `POST /api/cash-deposits` przyjmuje `date` (`YYYY-MM-DD`) i `amount` (dodatnia kwota w PLN z dokładnością do groszy). `GET /api/state` zwraca historię jako `cashDeposits`.

`POST /api/cash-operations` zapisuje `{ type: "DEPOSIT" | "WITHDRAWAL", date, amount }`. `PUT /api/cash-operations/:type/:id` edytuje datę i kwotę, a `DELETE` usuwa operację i cofa jej wpływ na saldo. `GET /api/state` zwraca obie kategorie jako `cashOperations`; starszy endpoint zasileń pozostaje zgodny.

Operacja **Wypłata dywidendy** (`DIVIDEND`) działa jak zasilenie: dodatnia kwota w PLN zwiększa gotówkę. Podaj kwotę faktycznie zaksięgowaną na rachunku; aplikacja nie nalicza podatku. Dywidenda ma osobne oznaczenie w historii, można ją edytować i usuwać. Nie zmienia wyniku transakcji na akcjach. Przy starcie tworzona jest pusta tabela `cash_dividends`; istniejące operacje i saldo pozostają bez zmian.

Historia **Wszystkie operacje** łączy kupno/sprzedaż akcji, zasilenia, wypłaty i dywidendy. Domyślnie lista pokazuje 5 operacji po uwzględnieniu filtrów i sortowania (standardowo najnowszych). Przycisk **Pokaż wszystkie operacje** rozwija pozostałe wyniki, a **Pokaż tylko 5 operacji** ponownie skraca listę. Przycisk **Dodaj operację** znajduje się w nagłówku historii. Lista ma kompaktowy układ: prowizja, metoda rozliczenia i koszt jednostkowy sprzedaży są dostępne po rozwinięciu przycisku **Szczegóły**. Prowizję i metodę można nadal sortować i filtrować przyciskami nad tabelą. Kolumna **Saldo** oznacza saldo gotówki po operacji. Gdy tabela wymaga przewijania poziomego, nad nią pojawia się dodatkowy zsynchronizowany pasek; data i aktywo pozostają przypięte. Na ekranach do 700 px operacje są wyświetlane jako karty. Kolumna **Saldo gotówki po operacji** pokazuje saldo po rozliczeniu danego wiersza z prowizją. Salda są liczone od najstarszej daty, w ramach dnia według czasu utworzenia, a przy identycznym czasie według identyfikatora operacji; lista jest wyświetlana od najnowszej. Saldo początkowe obejmuje również ewentualne ręczne korekty. Edycja wcześniejszej operacji przelicza późniejsze salda. Przycisk **Usuń transakcje akcji** usuwa wyłącznie kupno/sprzedaż; operacje gotówkowe można usuwać pojedynczo. Połączenie list nie zmienia bazy ani salda rachunku.

Dywidenda wymaga emitenta ze słownika aktywów (pole **Aktywo / emitent**). API dla `DIVIDEND` przyjmuje dodatkowo `ticker`. Powiązanie zapisujemy przez stałe `assets.id`, więc zmiana tickera i archiwizacja nie odłączają dywidendy od emitenta. Przy starcie migracja dodaje opcjonalne `cash_dividends.asset_id` z kluczem obcym. Starsze dywidendy pozostają w saldzie, są oznaczone jako „Nieprzypisany emitent — edytuj” i wymagają ręcznego przypisania; emitent nie jest zgadywany. Nowe i edytowane dywidendy wymagają wskazania emitenta. Kwoty i sposób rozliczania gotówki pozostają bez zmian.

**Wynik całego portfela** to `((wartość wszystkich akcji + saldo gotówki) / suma zasileń − 1) × 100%`. Obok wyniku widoczna jest **Suma wpłat**. W mianowniku liczymy wyłącznie `DEPOSIT`; dywidendy są częścią gotówki, a wypłaty obniżają gotówkę bez pomniejszania sumy wpłat. Przy braku zasileń wynik jest oznaczony „—”. Wskaźnik aktualizuje się razem z wyceną i historią operacji. Nie wymaga migracji danych.

Wybór globalnej metody FIFO/AVP znajduje się w nagłówku obok przełącznika motywu. Podsumowanie domyślnie pokazuje wartość pozycji, wynik portfela, gotówkę i wynik niezrealizowany. Pasek **Więcej szczegółów** rozwija łączną wartość portfela (pozycje + gotówka), sumę wpłat, koszt otwartych pozycji i wynik zrealizowany. W zwartych wierszach pozycji łapka oznacza kurs ręczny, a kropka kurs zewnętrzny (zielona przy działającym odświeżaniu, szara w pozostałych stanach). Po najechaniu na ikonę dostępne są źródło, status, ostatni kurs i czas notowania.

Podpowiedź przy ikonie kursu rozdziela **Ostatni kurs** (cena i czas notowania), **Ostatnie odświeżenie** (czas próby/pobrania i OK, błąd lub trwająca próba) oraz **Źródło**. Czasy podane są w strefie Europe/Warsaw. Przy błędzie widoczny jest też czas ostatniego udanego pobrania. OK oznacza poprawne pobranie; źródło może nadal zwracać starsze notowanie.

Przeniesienie obecnej bazy na inny serwer opisuje [SERVER-MIGRATION.md](SERVER-MIGRATION.md). Narzędzie `scripts/database-transfer.mjs` tworzy spójną kopię SQLite z manifestem i weryfikuje przesłany plik przed importem.

## Przypięte aktywa

W zakładce **Aktywa** przycisk **☆ Przypnij** dodaje instrument do sekcji **Stan na dziś → Pozycje i obserwowane**, także bez zakupu akcji. Kurs, źródło i odświeżanie działają tak samo jak dla pozycji. Instrument bez otwartej pozycji ma oznaczenie **Obserwowane** oraz kreski zamiast liczby akcji, kosztu, wartości i wyniku; nie wpływa na podsumowanie portfela. **★ Odepnij** usuwa przypięcie, ale otwarta pozycja pozostaje widoczna.

Przypięcia przechowuje tabela `pinned_assets` powiązana ze stałym identyfikatorem aktywa. Tabela powstaje automatycznie przy starcie, bez zmiany transakcji i salda. Zmiana tickera zachowuje przypięcie. Archiwizacja ukrywa obserwowany instrument bez pozycji i wstrzymuje pobieranie; przywrócenie przywraca także przypięcie. `PUT /api/pins/:ticker` przyjmuje `{ "pinned": true | false }`, a elementy `assets` w `GET /api/state` zawierają `pinned`.
