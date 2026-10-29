import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calculatePortfolio, transactionCashCents } from "./portfolio.js";
import { createAssetStore } from "./assets.js";
import { createSettingsStore } from "./settings.js";
import { migrateDatabase, priceToUnits } from "./database.js";
import { createPriceStore } from "./prices.js";
import { createQuoteCollector } from "./quote-collector.js";

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "portfolio.db"));

migrateDatabase(db);
const settings = createSettingsStore(db);
const assets = createAssetStore(db);
const prices = createPriceStore(db);
const collector = createQuoteCollector(db, prices, {
  enabled: process.env.QUOTES_ENABLED !== "0", intervalSeconds: Number(process.env.QUOTES_INTERVAL_SECONDS ?? 300),
});

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const getTransactions = () => db.prepare(`SELECT t.id, t.created_at AS createdAt, t.date, a.ticker, t.type, t.quantity, t.price, t.fee, t.cost_method AS costMethod
  FROM transactions t JOIN assets a ON a.id = t.asset_id ORDER BY t.date, t.created_at`).all();
const getQuotes = () => prices.getQuotes();

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": mime[".json"], "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, { transactions: getTransactions(), quotes: getQuotes(), assets: assets.list(), settings: settings.get(), cashDeposits: settings.deposits(), cashOperations: settings.cashOperations(), quoteDetails: prices.getQuoteDetails(), observedAssets: prices.listObserved() });
  if (request.method === "GET" && url.pathname === "/api/observed-assets") return sendJson(response, 200, prices.listObserved());
  if (request.method === "POST" && url.pathname === "/api/quotes/refresh") return sendJson(response, 200, await collector.run());
  if (request.method === "POST" && url.pathname.startsWith("/api/quotes/refresh/")) {
    const ticker = decodeURIComponent(url.pathname.slice("/api/quotes/refresh/".length));
    const asset = db.prepare("SELECT id FROM assets WHERE ticker = ? AND market = 'XWAR' AND archived_at IS NULL").get(ticker);
    if (!asset) return sendJson(response, 404, { error: "Nie znaleziono aktywnego instrumentu." });
    const feed = db.prepare("SELECT source_id FROM asset_price_feeds WHERE asset_id = ?").get(asset.id);
    if (feed && !["yahoo", "bankier"].includes(feed.source_id)) return sendJson(response, 409, { error: "Instrument ma skonfigurowane inne źródło." });
    const result = await collector.refreshAsset(asset.id);
    const current = prices.listObserved().find(item => item.assetId === asset.id);
    if (result.status === "disabled") return sendJson(response, 409, { error: "Automatyczne pobieranie jest wyłączone." });
    if (result.status === "backoff") return sendJson(response, 429, { error: "Dostawca ograniczył dostęp. Spróbuj ponownie po zakończeniu przerwy.", retryAt: result.retryAt });
    if (!result.updated) return sendJson(response, 502, { error: current?.lastError ?? "Nie pobrano kursu. Sprawdź konfigurację lub archiwizację instrumentu." });
    return sendJson(response, 200, { ...result, quote: prices.getQuoteDetails()[ticker] });
  }
  if (request.method === "PUT" && url.pathname.startsWith("/api/price-feeds/")) {
    const ticker = decodeURIComponent(url.pathname.slice(17));
    const asset = db.prepare("SELECT id FROM assets WHERE ticker = ? AND market = 'XWAR' AND archived_at IS NULL").get(ticker);
    if (!asset) return sendJson(response, 404, { error: "Nie znaleziono aktywnego instrumentu." });
    const input = await body(request);
    const sourceId = input.sourceId ?? 'yahoo';
    const symbols = input.symbols ?? { [sourceId]: input.symbol };
    if (!symbols || typeof symbols !== 'object' || Array.isArray(symbols)) return sendJson(response, 400, { error: "Podaj aliasy dostawców." });
    if (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean') return sendJson(response, 400, { error: "Nieprawidłowe ustawienie domyślnego dostawcy." });
    prices.saveFeedSettings(asset.id, sourceId, symbols, { makeDefault: input.makeDefault ?? true });
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/cash-operations") return sendJson(response, 201, settings.saveCash(await body(request)));
  const cashRoute = url.pathname.match(/^\/api\/cash-operations\/(DEPOSIT|WITHDRAWAL|DIVIDEND)\/(\d+)$/);
  if (cashRoute && request.method === "PUT") return sendJson(response, 200, settings.saveCash({ ...await body(request), type: cashRoute[1] }, Number(cashRoute[2])));
  if (cashRoute && request.method === "DELETE") {
    settings.removeCash(cashRoute[1], Number(cashRoute[2]));
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/cash-deposits") return sendJson(response, 201, settings.deposit(await body(request)));
  if (request.method === "PUT" && url.pathname === "/api/settings") return sendJson(response, 200, settings.save(await body(request)));
  if (request.method === "PUT" && url.pathname.startsWith("/api/pins/")) {
    return sendJson(response, 200, assets.pin(decodeURIComponent(url.pathname.slice(10)), (await body(request)).pinned));
  }
  if (request.method === "POST" && url.pathname === "/api/assets") return sendJson(response, 201, assets.save(null, await body(request)));
  if (request.method === "DELETE" && url.pathname.startsWith("/api/assets/")) {
    assets.remove(decodeURIComponent(url.pathname.slice(12)));
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "PUT" && url.pathname.startsWith("/api/assets/")) return sendJson(response, 200, assets.save(decodeURIComponent(url.pathname.slice(12)), await body(request)));
  if ((request.method === "POST" && url.pathname === "/api/transactions") || (request.method === "PUT" && url.pathname.startsWith("/api/transactions/"))) {
    const updating = request.method === "PUT";
    const existing = updating ? getTransactions().find(item => item.id === decodeURIComponent(url.pathname.slice(18))) : null;
    if (updating && !existing) return sendJson(response, 404, { error: "Nie znaleziono transakcji." });
    const item = await body(request);
    const costMethod = item.costMethod === undefined ? (existing?.costMethod ?? null) : item.costMethod;
    if (costMethod !== null && !["FIFO", "AVP"].includes(costMethod)) return sendJson(response, 400, { error: "Wybierz metodę globalną, FIFO lub AVP." });
    const transaction = { costMethod: item.type === "BUY" ? null : costMethod, id: existing?.id ?? String(item.id), createdAt: existing?.createdAt ?? Number(item.createdAt), date: String(item.date), ticker: String(item.ticker).trim().toUpperCase(), type: String(item.type), quantity: Number(item.quantity), price: Number(item.price), fee: Number(item.fee) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.date) || !transaction.ticker || !["BUY", "SELL"].includes(transaction.type) || !Number.isFinite(transaction.quantity) || transaction.quantity <= 0 || !Number.isFinite(transaction.price) || transaction.price < 0 || !Number.isFinite(transaction.fee) || transaction.fee < 0) return sendJson(response, 400, { error: "Nieprawidłowe dane transakcji." });
    try { calculatePortfolio([...getTransactions().filter(item => item.id !== existing?.id), transaction], getQuotes(), settings.get().costMethod); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
    transactionCashCents(transaction);
    const assetId = assets.ensure(transaction.ticker);
    if (updating) {
      db.prepare("UPDATE transactions SET date = ?, asset_id = ?, type = ?, quantity = ?, price = ?, fee = ?, cost_method = ? WHERE id = ?").run(transaction.date, assetId, transaction.type, transaction.quantity, transaction.price, transaction.fee, transaction.costMethod, transaction.id);
    } else {
      db.prepare("INSERT INTO transactions (id, created_at, date, asset_id, type, quantity, price, fee, cost_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(transaction.id, transaction.createdAt, transaction.date, assetId, transaction.type, transaction.quantity, transaction.price, transaction.fee, transaction.costMethod);
    }
    return sendJson(response, updating ? 200 : 201, transaction);
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/api/transactions/")) {
    db.prepare("DELETE FROM transactions WHERE id = ?").run(decodeURIComponent(url.pathname.slice(18)));
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "PUT" && url.pathname.startsWith("/api/quotes/")) {
    const ticker = decodeURIComponent(url.pathname.slice(12)).toUpperCase();
    const { price } = await body(request);
    if (!ticker || !Number.isFinite(Number(price)) || Number(price) < 0) return sendJson(response, 400, { error: "Nieprawidłowy kurs." });
    priceToUnits(Number(price));
    prices.saveManual(assets.ensure(ticker), Number(price));
    return sendJson(response, 200, { ticker, price: Number(price) });
  }
  if (request.method === "POST" && url.pathname === "/api/demo") {
    db.exec("DELETE FROM transactions;");
    const insert = db.prepare("INSERT INTO transactions (id, created_at, date, asset_id, type, quantity, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    assets.ensure("PKO");
    assets.ensure("CDR");
    const now = Date.now();
    [["2026-01-12", "PKO", "BUY", 20, 68.2, 5], ["2026-03-04", "PKO", "BUY", 10, 72.5, 5], ["2026-05-20", "PKO", "SELL", 8, 76.1, 5], ["2026-02-10", "CDR", "BUY", 5, 238, 5]].forEach((row, index) => insert.run(crypto.randomUUID(), now + index, row[0], assets.ensure(row[1]), ...row.slice(2)));
    prices.saveManual(assets.ensure("PKO"), 74.8);
    prices.saveManual(assets.ensure("CDR"), 252.4);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "DELETE" && url.pathname === "/api/state") {
    db.exec("DELETE FROM transactions;");
    return sendJson(response, 200, { ok: true });
  }
  return sendJson(response, 404, { error: "Nie znaleziono zasobu." });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const content = await readFile(join(process.cwd(), safePath));
    response.writeHead(200, { "Content-Type": mime[extname(safePath)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(content);
  } catch (error) {
    if (error.status) return sendJson(response, error.status, { error: error.message });
    if (error instanceof SyntaxError) return sendJson(response, 400, { error: "Nieprawidłowe dane JSON." });
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "Nie znaleziono pliku." });
    console.error(error); sendJson(response, 500, { error: "Błąd serwera." });
  }
}).listen(port, "0.0.0.0", () => console.log(`Portfel GPW działa na porcie ${server.address().port}`));

collector.start();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  collector.stop();
  server.close(() => process.exit(0));
});
