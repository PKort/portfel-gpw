# Przeniesienie portfela na serwer

Instrukcja zakłada Docker Compose na serwerze. Nie łączy dwóch baz. Pakiet zastępuje źródło danych aplikacji pełną kopią obecnego portfela, ale importuje ją do **nowego wolumenu**, zachowując wcześniejszy wolumen serwera. Jeśli serwer ma własne operacje, których nie ma w kopii, nie wykonuj przełączenia: wybierz aktualizację istniejącej bazy opisaną na końcu.

## Przygotowany pakiet

`backups/server-transfer-20261027/` zawiera:

- `portfolio.db` — spójną kopię SQLite, obejmującą także zatwierdzone dane z WAL;
- `portfolio.db.json` — czas wykonania, SHA-256 i liczby rekordów w tabelach;
- `expected-state.json` — saldo gotówki, metoda wyceny i liczby operacji do porównania po imporcie;
- `database-transfer.mjs` — narzędzie tworzenia kopii i kontroli zgodności;
- `compose.import.yaml` — konfigurację nowego wolumenu;
- `INSTRUCTIONS.md` — tę instrukcję.

Baza zawiera dane finansowe; pakiet pozostaje poza Gitem. Kopia jest migawką, nie synchronizacją: późniejsze operacje źródłowe nie trafią automatycznie na serwer. Przed ostatecznym przełączeniem przestań wprowadzać operacje na starym komputerze. Jeśli od wykonania kopii cokolwiek zmieniono, przygotuj nową migawkę.

## 1. Prześlij pakiet

Na komputerze źródłowym zastąp `UZYTKOWNIK@SERWER` rzeczywistym adresem:

```bash
scp -r backups/server-transfer-20261027 UZYTKOWNIK@SERWER:~/portfel-transfer-20261027
```

Na serwerze:

```bash
chmod 700 ~/portfel-transfer-20261027
chmod 600 ~/portfel-transfer-20261027/portfolio.db ~/portfel-transfer-20261027/portfolio.db.json
```

## 2. Przygotuj kod i obraz

Pierwsza instalacja:

```bash
git clone https://github.com/PKort/portfel-gpw.git
cd portfel-gpw
```

Przy istniejącym repozytorium przejdź do jego katalogu i wykonaj `git pull --ff-only`. Sprawdź, że repozytorium zawiera commit `7936444` lub nowszy. Zapisz poprzedni commit i ustawienia wdrożenia, jeżeli aplikacja już działa. Nie uruchamiaj jeszcze nowego serwera.

```bash
docker compose build portfel-gpw
```

Nowy obraz zawiera już obsługę aktualnego schematu i migracji. Pakiet przenosi istniejące oznaczenie naprawy salda gotówki; **nie uruchamiaj ponownie migracji gotówki z nowym saldem początkowym**.

## 3. Sprawdź przesłany pakiet

W katalogu repozytorium na serwerze:

```bash
transfer_dir="$HOME/portfel-transfer-20261027"
docker compose run --rm --no-deps --user root \
  --volume "$transfer_dir:/transfer:ro" \
  portfel-gpw node /transfer/database-transfer.mjs verify /transfer/portfolio.db /transfer/portfolio.db.json
```

Polecenie wymaga wyniku bez błędów. Sprawdza SHA-256, liczbę rekordów, integralność SQLite i klucze obce. Manifest jest punktem odniesienia dla liczb rekordów; historia cen może rosnąć po uruchomieniu pobierania kursów.

## 4. Utwórz nowy wolumen i zaimportuj bazę

```bash
docker volume create portfel-gpw-import-20261027

docker compose -f compose.yaml -f "$transfer_dir/compose.import.yaml" run --rm --no-deps --user root \
  --volume "$transfer_dir:/transfer:ro" portfel-gpw \
  node --input-type=module -e '
    import { copyFileSync, readdirSync, constants, chmodSync, chownSync } from "node:fs";
    if (readdirSync("/app/data").length) throw new Error("Wolumen nie jest pusty. Import przerwany.");
    copyFileSync("/transfer/portfolio.db", "/app/data/portfolio.db", constants.COPYFILE_EXCL);
    chownSync("/app/data/portfolio.db", 1000, 1000);
    chmodSync("/app/data/portfolio.db", 0o600);
  '

docker compose -f compose.yaml -f "$transfer_dir/compose.import.yaml" run --rm --no-deps --user root \
  --volume "$transfer_dir:/transfer:ro" portfel-gpw \
  node /transfer/database-transfer.mjs verify /app/data/portfolio.db /transfer/portfolio.db.json
```

Jednorazowy import i kontrola plików działają jako root, aby odczytać pakiet niezależnie od UID użytkownika serwera. Import nadaje plikowi właściciela `node` (UID/GID 1000) i właściwe prawa i odmawia zapisu do niepustego wolumenu. Sama aplikacja nadal działa bez uprawnień roota. Import nie kopiuje plików WAL/SHM: mechanizm kopii SQLite zawarł już ich zatwierdzoną treść w samodzielnym pliku bazy.

## 5. Zabezpiecz poprzednią instalację i przełącz aplikację

Jeśli na serwerze działa poprzednia instalacja, przed przełączeniem zatrzymaj jej aplikację i skopiuj cały katalog danych do nowego, pustego katalogu kopii:

```bash
docker compose stop portfel-gpw
mkdir -p backups/before-server-import-20261027
docker cp portfel-gpw:/app/data/. backups/before-server-import-20261027/
```

Przy pierwszej instalacji pomiń powyższe polecenia. Następnie uruchom aplikację wraz z nginx na nowym wolumenie:

```bash
docker compose -f compose.yaml -f "$transfer_dir/compose.import.yaml" up -d
docker compose -f compose.yaml -f "$transfer_dir/compose.import.yaml" logs --tail 30 portfel-gpw
```

Aplikacja jest domyślnie dostępna na porcie 8080. `HTTP_PORT` można ustawić w `.env`; zachowaj dotychczasową konfigurację proxy i dostępu do aplikacji.

**Każde kolejne polecenie startu, aktualizacji lub restartu wykonuj z tym samym plikiem `compose.import.yaml`.** Samo `docker compose up` użyje pierwotnego wolumenu i pokaże inne dane. Przykład aktualizacji:

```bash
git pull --ff-only
docker compose -f compose.yaml -f "$transfer_dir/compose.import.yaml" up -d --build
```

## 6. Weryfikacja i zakończenie przełączenia

```bash
docker compose -f compose.yaml -f "$transfer_dir/compose.import.yaml" exec -T portfel-gpw \
  node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:3000/api/state");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const s = await response.json();
    console.log(JSON.stringify({
      transactions: s.transactions.length,
      cashOperations: s.cashOperations.length,
      cashBalance: s.settings.cashBalance,
      deposits: s.cashOperations.filter(i => i.type === "DEPOSIT").length,
      dividends: s.cashOperations.filter(i => i.type === "DIVIDEND").length
    }, null, 2));
  '
```

Porównaj liczbę transakcji, wpłat, dywidend i saldo z plikiem `expected-state.json` w pakiecie. Sprawdź widok portfela przez adres serwera, przypisania emitentów, źródła kursów oraz FIFO/AVP. Wartość akcji i wynik procentowy mogą zmienić się po pobraniu nowych kursów; sama gotówka nie powinna zmienić się wskutek importu. Dopiero po potwierdzeniu przejdź do wprowadzania operacji na nowym serwerze i nie używaj równolegle poprzedniej instalacji do zapisu danych.

## Wycofanie

Zatrzymaj nową aplikację poleceniem Compose z plikiem importu. Zachowaj nowy wolumen, szczególnie jeśli dodano już operacje. Przywróć wcześniejszy kod/obraz i wcześniejszą konfigurację Compose wskazującą poprzedni wolumen. Uruchom poprzednią instalację. Nie wykonuj `docker compose down -v` ani nie usuwaj wolumenów podczas migracji. Dla pierwszej instalacji wycofanie polega na zatrzymaniu nowej aplikacji; źródłowa baza pozostaje niezmieniona.

## Gdy chodzi o aktualizację osobnej bazy serwera

Nie importuj lokalnej migawki — zastąpiłaby niezależną historię serwera. Zatrzymaj starą aplikację, wykonaj kopię całego katalogu danych i zachowaj stary obraz. Na kopii przetestuj uruchomienie nowego kodu. Migracje definicji aktywów i kursów wykonują się przy starcie; niezerowe stare korekty gotówki wymagają osobnego podglądu i zastosowania według `CASH-MIGRATION.md`. Dopiero po sprawdzeniu salda uruchom nowy kod z dotychczasowym wolumenem. Do przygotowania konkretnego planu dla tej bazy potrzebna jest jej kopia lub dostęp do serwera.
