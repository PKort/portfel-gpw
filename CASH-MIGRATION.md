# Naprawa salda gotówki

## Przyczyna i zakres

Stara migracja zapisywała sumę istniejących transakcji w `cash_baseline_cents`. Saldo było liczone jako `cash_cents + wpłaty − wypłaty + rozliczenia transakcji − cash_baseline_cents`. Dla niezmienionej historii transakcje znosiły się z punktem odniesienia. Podobny efekt dawała ręczna korekta salda. Nie zależy to od daty transakcji; nowe zakupy powinny były już zmniejszać saldo. Jeżeli problem dotyczy zakupów dodanych po aktualizacji, trzeba sprawdzić wersję wdrożonej aplikacji i raport z rzeczywistej bazy.

Łatka oblicza saldo z całej historii: saldo początkowe + wpłaty − wypłaty − zakupy wraz z prowizjami + sprzedaże po prowizjach. Każda transakcja jest rozliczana do groszy. Edycje i usunięcia są uwzględniane przez ponowne obliczenie historii. Data historyczna nie wyłącza operacji z obliczeń.

Migracja nie zmienia ani nie powiela transakcji, wpłat, wypłat, kursów i definicji aktywów. Tworzy `cash_ledger_settings` oraz jednorazowy zapis w `cash_ledger_migrations`: czas, stare ustawienia i wyliczenie przed/po. Stare kolumny pozostają w bazie do audytu, ale nie są używane do salda. Ponowne uruchomienie migracji niczego nie przelicza ponownie i nie zmienia salda początkowego.

Domyślne saldo początkowe wynosi 0. Jeśli cała historia wpłat została wpisana, jest to właściwy wariant. Dawne ręcznie ustawione saldo było saldem bieżącym, więc nie można automatycznie uznać go za saldo początkowe i dodać ponownie do historii. Przy niepełnej historii należy podać uzgodnione saldo początkowe przez `--opening-cents` (w groszach); nie jest to docelowe saldo bieżące.

Bazy z niezerowym starym saldem lub punktem odniesienia wymagają jawnej migracji przed startem nowego serwera. Serwer kończy start z instrukcją zamiast samodzielnie usuwać niejednoznaczne korekty. Nowe bazy i bazy z oboma starymi polami równymi 0 przechodzą migrację automatycznie.

## Procedura wdrożenia w Docker Compose

Poniższe polecenia wykonaj z katalogu projektu. `portfel-gpw` oznacza usługę z obecnego `compose.yaml`. Skrypt migracyjny jest zawarty w nowym obrazie i działa jako użytkownik `node`.

1. Przygotuj nowy obraz, bez uruchamiania go:

   ```bash
   docker compose build portfel-gpw
   ```

2. Zatrzymaj aplikację, aby zablokować zapisy; wykonaj kopię pliku bazy i ewentualnych plików WAL/SHM. Nie usuwaj wolumenu.

   ```bash
   docker compose stop portfel-gpw
   mkdir -p backups/cash-migration
   docker cp portfel-gpw:/app/data/. backups/cash-migration/
   ```

   Użyj nowego, pustego katalogu kopii dla każdego wdrożenia. Potwierdź, że kopia zawiera niepusty `portfolio.db`, i zabezpiecz ją przed nadpisaniem. W razie przerwania wdrożenia stary kontener nadal można uruchomić przez `docker compose start portfel-gpw`, dopóki nie zastosowano migracji.

3. Uruchom raport **bez zapisu** i zachowaj wynik:

   ```bash
   docker compose run --rm --no-deps portfel-gpw node migrate-cash.js /app/data/portfolio.db > backups/cash-migration/preview.json
   ```

   Sprawdź `transactionCount`, `tradesCents`, `depositsCents`, `withdrawalsCents`, `legacyCashCents`, `legacyBaselineCents`, `previousBalanceCents` i `proposedBalanceCents`. Wszystkie kwoty są w groszach. Przykład: wpłata 2000 zł, wypłata 100 zł, zakup 1000 zł + 5 zł prowizji, sprzedaż 240 zł − 3 zł prowizji daje **1132 zł**, a nie 1900 zł. Uzgodnij wynik z rachunkiem maklerskim. Jeśli potrzeba salda początkowego, powtórz raport z `--opening-cents=KWOTA_W_GROSZACH`.

4. Po sprawdzeniu raportu zastosuj migrację z takim samym saldem początkowym:

   ```bash
   docker compose run --rm --no-deps portfel-gpw node migrate-cash.js /app/data/portfolio.db --apply > backups/cash-migration/applied.json
   docker compose up -d portfel-gpw
   ```

   Jeśli w podglądzie użyto `--opening-cents`, podaj ten sam argument również z `--apply`. Zapis jest wykonywany w transakcji SQLite; błąd wycofuje zmianę. Skrypt wymaga istniejącego pliku bazy i nie tworzy przypadkowo pustej bazy pod błędną ścieżką.

5. Sprawdź logi startu, saldo w interfejsie oraz `GET /api/state`. Porównaj liczbę i wartości operacji z raportem. Zweryfikuj na kopii testowej: historyczny zakup pomniejsza saldo, sprzedaż je zwiększa, edycja prowizji zmienia saldo o różnicę, usunięcie cofa wpływ, restart nie zmienia wyniku.

Poza Dockerem użyj Node.js 24+: `node migrate-cash.js /pełna/ścieżka/portfolio.db`, a po sprawdzeniu raportu dodaj `--apply`. Aplikacja powinna być wtedy zatrzymana.

## Wycofanie

Zatrzymaj aplikację. Przywróć stary obraz/kod oraz całą kopię danych sprzed migracji (również stan WAL, jeśli był obecny); nie mieszaj jej z bieżącymi plikami WAL/SHM. Uruchom starą wersję. Samo cofnięcie obrazu bez odtworzenia bazy nie jest procedurą wycofania. Operacje dodane po migracji wymagają osobnego zachowania przed odtworzeniem kopii.

## Weryfikacja łatki

`npm test` obejmuje przypadek starej bazy z anulowanym wpływem zakupów, podgląd tylko do odczytu, zachowanie wszystkich oryginalnych rekordów, rozliczenie prowizji, saldo początkowe, restart, idempotencję oraz edycję i usunięcie transakcji. `npm run test:api` sprawdza operacje przez HTTP. Testy używają tymczasowych baz; nie modyfikują bazy użytkownika.
