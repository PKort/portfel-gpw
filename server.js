import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calculatePortfolio } from "./portfolio.js";
import { createAssetStore } from "./assets.js";
import { createSettingsStore } from "./settings.js";

const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "portfolio.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL,
    ticker TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL')),
    quantity REAL NOT NULL CHECK(quantity > 0), price REAL NOT NULL CHECK(price >= 0),
    fee REAL NOT NULL CHECK(fee >= 0)
  );
  CREATE TABLE IF NOT EXISTS quotes (
    ticker TEXT PRIMARY KEY, price REAL NOT NULL CHECK(price >= 0)
  );
`);

const settings = createSettingsStore(db);
const assets = createAssetStore(db);

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const getTransactions = () => db.prepare("SELECT id, created_at AS createdAt, date, ticker, type, quantity, price, fee, cost_method AS costMethod FROM transactions ORDER BY date, created_at").all();
const getQuotes = () => Object.fromEntries(db.prepare("SELECT ticker, price FROM quotes").all().map(({ ticker, price }) => [ticker, price]));

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": mime[".json"] });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function api(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, { transactions: getTransactions(), quotes: getQuotes(), assets: assets.list(), settings: settings.get() });
  if (request.method === "PUT" && url.pathname === "/api/settings") return sendJson(response, 200, settings.save(await body(request)));
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
    if (updating) {
      db.prepare("UPDATE transactions SET date = ?, ticker = ?, type = ?, quantity = ?, price = ?, fee = ?, cost_method = ? WHERE id = ?").run(transaction.date, transaction.ticker, transaction.type, transaction.quantity, transaction.price, transaction.fee, transaction.costMethod, transaction.id);
    } else {
      db.prepare("INSERT INTO transactions (id, created_at, date, ticker, type, quantity, price, fee, cost_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(transaction.id, transaction.createdAt, transaction.date, transaction.ticker, transaction.type, transaction.quantity, transaction.price, transaction.fee, transaction.costMethod);
    }
    assets.ensure(transaction.ticker);
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
    db.prepare("INSERT INTO quotes (ticker, price) VALUES (?, ?) ON CONFLICT(ticker) DO UPDATE SET price = excluded.price").run(ticker, Number(price));
    assets.ensure(ticker);
    return sendJson(response, 200, { ticker, price: Number(price) });
  }
  if (request.method === "POST" && url.pathname === "/api/demo") {
    db.exec("DELETE FROM transactions; DELETE FROM quotes;");
    const insert = db.prepare("INSERT INTO transactions (id, created_at, date, ticker, type, quantity, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    assets.ensure("PKO");
    assets.ensure("CDR");
    const now = Date.now();
    [["2026-01-12", "PKO", "BUY", 20, 68.2, 5], ["2026-03-04", "PKO", "BUY", 10, 72.5, 5], ["2026-05-20", "PKO", "SELL", 8, 76.1, 5], ["2026-02-10", "CDR", "BUY", 5, 238, 5]].forEach((row, index) => insert.run(crypto.randomUUID(), now + index, ...row));
    db.prepare("INSERT INTO quotes VALUES (?, ?), (?, ?)").run("PKO", 74.8, "CDR", 252.4);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "DELETE" && url.pathname === "/api/state") {
    db.exec("DELETE FROM transactions; DELETE FROM quotes;");
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
    response.writeHead(200, { "Content-Type": mime[extname(safePath)] ?? "application/octet-stream" });
    response.end(content);
  } catch (error) {
    if (error.status) return sendJson(response, error.status, { error: error.message });
    if (error instanceof SyntaxError) return sendJson(response, 400, { error: "Nieprawidłowe dane JSON." });
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "Nie znaleziono pliku." });
    console.error(error); sendJson(response, 500, { error: "Błąd serwera." });
  }
}).listen(port, "0.0.0.0", () => console.log(`Portfel GPW działa na porcie ${server.address().port}`));
