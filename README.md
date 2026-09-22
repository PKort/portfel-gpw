# Portfel GPW

Aplikacja webowa do zapisywania transakcji na GPW i liczenia wyniku metodą FIFO lub AVP. Działa jako kontener, a dane przechowuje w bazie SQLite na trwałym wolumenie.

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

Usunięcie aktywa z otwartą pozycją jest blokowane. Można usunąć aktywa bez transakcji lub z całkowicie zamkniętą pozycją; usunięcie definicji zachowuje transakcje i kurs. Portfel nadal grupuje pozycje według tickera, który zastępuje usuniętą nazwę. Definicja nie wraca automatycznie po restarcie ani po dodaniu transakcji lub aktualizacji kursu; można ją ponownie dodać ręcznie.

Zmiana głównego tickera aktualizuje powiązane transakcje i kurs w jednej transakcji bazy danych. Nie można nadpisać innego istniejącego aktywa. Każda platforma może mieć jeden symbol dla danego aktywa; para platforma–symbol nie może wskazywać dwóch aktywów. Wpisy platform są na razie słownikiem pod przyszłe integracje, bez pobierania notowań i automatycznego rozpoznawania aliasów przy dodawaniu transakcji.

Przy pierwszym uruchomieniu nowej wersji słownik powstaje automatycznie na podstawie istniejących transakcji i kursów. Przed aktualizacją wykonaj kopię bazy (patrz niżej). Definicje są zapisywane w SQLite i pozostają po wyczyszczeniu transakcji lub wczytaniu przykładu.

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
