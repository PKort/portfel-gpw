export function quoteStatus(feed, quote, now = Date.now()) {
  const external = quote && !["manual", "legacy"].includes(quote.sourceId);
  const mode = external ? "Zewnętrzne" : quote ? "Ręczne" : "Brak ceny";
  if (!feed || feed.status === "unconfigured") return { tone: "warning", label: `${mode} · brak konfiguracji`, detail: "Brak konfiguracji automatycznego pobierania." };
  if (feed.status === "source_disabled") return { tone: "warning", label: `${mode} · automat wyłączony`, detail: "Automatyczne pobieranie jest wyłączone." };
  const stale = external && quote.sourceId === feed.sourceId && feed.lastSuccessAt != null
    && now - feed.lastSuccessAt > (feed.pollIntervalSeconds ?? 300) * 10_000;
  if (feed.lastError) return { tone: "error", label: `${mode} · błąd pobierania`, detail: feed.lastError, stale };
  if (feed.lastSuccessAt == null) return { tone: "warning", label: `${mode} · oczekuje`, detail: "Nie otrzymano jeszcze poprawnego kursu zewnętrznego." };
  if (stale) {
    return { tone: "stale", label: `${mode} · brak odświeżania`, detail: "Od ostatniego udanego pobrania minęło więcej niż 10 interwałów odświeżania.", stale };
  }
  if (external && quote.sourceId !== feed.sourceId) return { tone: "warning", label: `${mode} · zmiana źródła`, detail: "Wybrany dostawca nie dostarczył jeszcze kursu używanego do wyceny. Zachowano poprzednie źródło." };
  if (!external) return { tone: "warning", label: `${mode} · automat nieaktywny`, detail: "Wycena nie używa kursu zewnętrznego. Kliknij ikonę pobierania, aby pobrać kurs i przełączyć źródło." };
  return { tone: "success", label: "Zewnętrzne · odświeżane", detail: "Wycena używa kursu zewnętrznego; ostatnie pobranie zakończyło się poprawnie. Sprawdź czas notowania w szczegółach kursu." };
}

export function quoteTooltip(feed, quote, sourceName, now = Date.now()) {
  const date = (timestamp, seconds = false) => timestamp == null ? "czas nieznany" : new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23",
  }).format(timestamp).replace(", ", " ");
  const price = new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const external = quote && !["manual", "legacy"].includes(quote.sourceId);
  const source = !quote ? "brak kursu" : external ? `zewnętrzne (${sourceName ?? quote.sourceId})` : quote.sourceId === "legacy" ? "kurs sprzed migracji" : "ręczne";
  let refresh;
  if (feed?.lastError) refresh = `${date(feed.lastAttemptAt, true)} — BŁĄD: ${feed.lastError}`;
  else if (feed?.lastAttemptAt != null && (feed.lastSuccessAt == null || feed.lastAttemptAt > feed.lastSuccessAt)) refresh = `${date(feed.lastAttemptAt, true)} — w trakcie`;
  else if (feed?.lastSuccessAt != null) refresh = `${date(feed.lastSuccessAt, true)} — OK`;
  else refresh = "brak prób";
  const lines = [
    `Ostatni kurs: ${quote ? `${price.format(quote.price)} PLN @ ${date(quote.quotedAt)}` : "brak danych"}`,
    `Ostatnie odświeżenie: ${refresh}`,
    `Źródło — ${source}`,
  ];
  if (feed?.lastSuccessAt != null && (feed.lastError || feed.lastAttemptAt > feed.lastSuccessAt)) {
    lines.push(`Ostatnie udane odświeżenie: ${date(feed.lastSuccessAt, true)}`);
  }
  const status = quoteStatus(feed, quote, now);
  if (status.tone !== "success") lines.push(status.detail);
  return lines.join("\n");
}
