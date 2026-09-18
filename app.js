import { calculatePortfolio, formatQuantity } from "./portfolio.js";

const money = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const form = document.querySelector("#transaction-form");
const error = document.querySelector("#form-error");
let transactions = [];
let quotes = {};
form.elements.date.valueAsDate = new Date();

async function request(path, options) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Błąd połączenia z serwerem.");
  return result;
}

async function refresh() {
  const state = await request("/api/state");
  transactions = state.transactions;
  quotes = state.quotes;
  render();
}

function render() {
  const positions = calculatePortfolio(transactions, quotes);
  const open = positions.filter((position) => position.quantity > 1e-9);
  document.querySelector("#positions-body").innerHTML = open.length
    ? open.map((position) => `<tr><td><strong>${position.ticker}</strong></td><td>${formatQuantity(position.quantity)}</td>
        <td>${money.format(position.averageCost)}</td><td><input class="quote" data-ticker="${position.ticker}" type="number" min="0" step="0.01" value="${position.quote || ""}" placeholder="0,00"></td>
        <td>${money.format(position.marketValue)}</td><td class="${tone(position.unrealized)}">${money.format(position.unrealized)}</td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">Brak otwartych pozycji.</td></tr>';
  document.querySelector("#transactions-body").innerHTML = transactions.length
    ? [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).map((item) => `<tr>
        <td>${item.date}</td><td><strong>${item.ticker}</strong></td><td><span class="pill ${item.type.toLowerCase()}">${item.type === "BUY" ? "Kupno" : "Sprzedaż"}</span></td>
        <td>${formatQuantity(item.quantity)}</td><td>${money.format(item.price)}</td><td>${money.format(item.fee)}</td><td><button class="icon-button" data-remove="${item.id}" aria-label="Usuń transakcję">×</button></td></tr>`).join("")
    : '<tr><td colspan="7" class="empty">Dodaj pierwszą transakcję.</td></tr>';
  const totals = positions.reduce((sum, p) => ({ marketValue: sum.marketValue + p.marketValue, cost: sum.cost + p.cost, unrealized: sum.unrealized + p.unrealized, realized: sum.realized + p.realized }), { marketValue: 0, cost: 0, unrealized: 0, realized: 0 });
  setMetric("market-value", totals.marketValue); setMetric("open-cost", totals.cost);
  setMetric("unrealized", totals.unrealized, true); setMetric("realized", totals.realized, true);
}

function setMetric(id, value, colored = false) { const element = document.querySelector(`#${id}`); element.textContent = money.format(value); if (colored) element.className = tone(value); }
function tone(value) { return value > .005 ? "positive" : value < -.005 ? "negative" : ""; }
function showError(caught) { error.textContent = caught.message; }

form.addEventListener("submit", async (event) => {
  event.preventDefault(); error.textContent = "";
  const data = new FormData(form);
  const item = { id: crypto.randomUUID(), createdAt: Date.now(), date: data.get("date"), ticker: data.get("ticker").trim().toUpperCase(), type: data.get("type"), quantity: Number(data.get("quantity")), price: Number(data.get("price")), fee: Number(data.get("fee")) };
  try { await request("/api/transactions", { method: "POST", body: JSON.stringify(item) }); form.reset(); form.elements.date.valueAsDate = new Date(); form.elements.fee.value = "0"; await refresh(); }
  catch (caught) { showError(caught); }
});

document.addEventListener("change", async (event) => { if (!event.target.matches(".quote")) return; try { await request(`/api/quotes/${event.target.dataset.ticker}`, { method: "PUT", body: JSON.stringify({ price: Number(event.target.value) }) }); await refresh(); } catch (caught) { showError(caught); } });
document.addEventListener("click", async (event) => { const id = event.target.dataset.remove; if (!id) return; try { await request(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" }); await refresh(); } catch (caught) { showError(caught); } });
document.querySelector("#load-demo").addEventListener("click", async () => { try { await request("/api/demo", { method: "POST" }); await refresh(); } catch (caught) { showError(caught); } });
document.querySelector("#clear-all").addEventListener("click", async () => { if (!transactions.length || !confirm("Usunąć wszystkie transakcje i kursy?")) return; try { await request("/api/state", { method: "DELETE" }); await refresh(); } catch (caught) { showError(caught); } });

refresh().catch(showError);
