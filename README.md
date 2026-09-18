# Portfel GPW

Aplikacja webowa do zapisywania transakcji na GPW i liczenia wyniku metodą FIFO. Działa jako kontener, a dane przechowuje w bazie SQLite na trwałym wolumenie.

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

Aplikacja będzie dostępna pod `http://ADRES_SERWERA:3000`. Baza znajduje się w nazwanym wolumenie `portfel-data` i pozostaje po odtworzeniu kontenera.

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
