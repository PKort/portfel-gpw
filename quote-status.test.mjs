import assert from 'node:assert/strict';
import { quoteStatus, quoteTooltip } from './quote-status.js';
const feed = { sourceId: 'yahoo', status: 'configured', lastSuccessAt: 1_000_000, pollIntervalSeconds: 300, lastError: null };
const external = { sourceId: 'yahoo' };
assert.equal(quoteStatus(feed, external, 1_000_001).tone, 'success');
assert.match(quoteStatus(feed, { sourceId: 'manual' }, 1_000_001).label, /Ręczne.*nieaktywny/);
assert.equal(quoteStatus({ ...feed, lastError: 'Nieznany symbol' }, external).tone, 'error');
assert.equal(quoteStatus({ ...feed, lastSuccessAt: null }, external).tone, 'warning');
assert.match(quoteStatus({ ...feed, status: 'source_disabled' }, external).label, /wyłączony/);
assert.match(quoteStatus(null, null).label, /Brak ceny.*brak konfiguracji/);
assert.match(quoteStatus(feed, external, 2_000_000).label, /brak odświeżania/);
console.log('Testy statusów kursów: źródło wyceny, brak danych, błędy i przerwane pobieranie OK');

assert.match(quoteStatus({ ...feed, sourceId: 'bankier' }, external, 1_000_001).label, /zmiana źródła/);

const quoteTime = Date.parse("2026-10-27T12:56:00Z");
const fetchTime = Date.parse("2026-10-27T13:39:00Z");
const exampleQuote = { sourceId: "bankier", price: 119.4, quotedAt: quoteTime };
const exampleFeed = { status: "configured", sourceId: "bankier", lastAttemptAt: fetchTime - 100, lastSuccessAt: fetchTime, lastError: null };
const tooltip = quoteTooltip(exampleFeed, exampleQuote, "Bankier.pl", fetchTime);
assert.equal(tooltip, "Ostatni kurs: 119,40 PLN @ 27.10.2026 13:56\nOstatnie odświeżenie: 27.10.2026 14:39 — OK\nŹródło — zewnętrzne (Bankier.pl)");
const failed = quoteTooltip({ ...exampleFeed, lastAttemptAt: fetchTime + 300000, lastError: "HTTP 503" }, exampleQuote, "Bankier.pl", fetchTime + 300000);
assert.match(failed, /Ostatnie odświeżenie: 27.10.2026 14:44 — BŁĄD: HTTP 503/);
assert.match(failed, /Ostatnie udane odświeżenie: 27.10.2026 14:39/);
assert.match(quoteTooltip({ ...exampleFeed, lastAttemptAt: fetchTime + 1 }, exampleQuote, "Bankier.pl", fetchTime + 1), /w trakcie/);
assert.match(quoteTooltip(null, { ...exampleQuote, sourceId: "manual" }), /Źródło — ręczne/);
assert.match(quoteTooltip(null, null), /brak danych\nOstatnie odświeżenie: brak prób/);
assert.match(quoteTooltip({ ...exampleFeed, status: "source_disabled" }, exampleQuote, "Bankier.pl", fetchTime), /wyłączone/);
console.log("Testy podpowiedzi kursów: osobne czasy notowania i pobrania, błędy, brak prób i źródło OK");
