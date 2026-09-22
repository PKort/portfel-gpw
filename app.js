import { calculatePortfolioDetails, formatQuantity } from "./portfolio.js";

const money = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const price = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 3 });
const form = document.querySelector("#transaction-form");
const error = document.querySelector("#form-error");
let transactions = [];
let quotes = {};
let assets = [];
let defaultCostMethod = "FIFO";
let editingTicker = null;
let editingTransactionId = null;
let savingTransaction = false;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const assetLabel = (ticker) => {
  const asset = assets.find(asset => asset.ticker === ticker);
  return asset ? `<strong>${escapeHtml(asset.name)}</strong><small class="asset-ticker">${escapeHtml(ticker)}</small>` : `<strong>${escapeHtml(ticker)}</strong>`;
};
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
  assets = state.assets;
  defaultCostMethod = state.settings.costMethod;
  document.querySelector("#global-cost-method").value = defaultCostMethod;
  form.elements.costMethod.options[0].textContent = `Globalna (${defaultCostMethod})`;
  if (editingTransactionId && !transactions.some(item => item.id === editingTransactionId)) resetTransactionForm();
  render();
}

function render() {
  const { positions, saleResults } = calculatePortfolioDetails(transactions, quotes, defaultCostMethod);
  renderAssets(positions);
  const open = positions.filter((position) => position.quantity > 1e-9);
  document.querySelector("#positions-body").innerHTML = open.length
    ? open.map((position) => `<tr><td>${assetLabel(position.ticker)}</td><td>${formatQuantity(position.quantity)}</td>
        <td>${money.format(position.averageCost)}</td><td><input class="quote" data-ticker="${escapeHtml(position.ticker)}" type="number" min="0" step="0.01" value="${position.quote || ""}" placeholder="0,00"></td>
        <td>${money.format(position.marketValue)}</td><td class="${tone(position.unrealized)}">${money.format(position.unrealized)}</td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">Brak otwartych pozycji.</td></tr>';
  document.querySelector("#transactions-body").innerHTML = transactions.length
    ? [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).map((item) => `<tr>
        <td>${escapeHtml(item.date)}</td><td>${assetLabel(item.ticker)}</td><td><span class="pill ${item.type.toLowerCase()}">${item.type === "BUY" ? "Kupno" : "Sprzedaż"}</span></td>
        <td>${formatQuantity(item.quantity)}</td><td>${price.format(item.price)}</td><td>${money.format(item.quantity * item.price)}</td><td>${money.format(item.fee)}</td><td>${item.type === "SELL" ? `${saleResults.get(item.id).method}${item.costMethod ? "" : " (globalna)"}` : "—"}</td><td class="${item.type === "SELL" ? tone(saleResults.get(item.id).profit) : ""}" ${item.type === "SELL" ? `title="Koszt jednostkowy rozliczony metodą ${saleResults.get(item.id).method}: ${price.format(saleResults.get(item.id).averageAcquisitionCost)}"` : ""}>${item.type === "SELL" ? money.format(saleResults.get(item.id).profit) : "—"}</td><td><button type="button" class="secondary" data-edit-transaction="${escapeHtml(item.id)}">Edytuj</button> <button class="icon-button" data-remove="${escapeHtml(item.id)}" aria-label="Usuń transakcję">×</button></td></tr>`).join("")
    : '<tr><td colspan="10" class="empty">Dodaj pierwszą transakcję.</td></tr>';
  const totals = positions.reduce((sum, p) => ({ marketValue: sum.marketValue + p.marketValue, cost: sum.cost + p.cost, unrealized: sum.unrealized + p.unrealized, realized: sum.realized + p.realized }), { marketValue: 0, cost: 0, unrealized: 0, realized: 0 });
  setMetric("market-value", totals.marketValue); setMetric("open-cost", totals.cost);
  setMetric("unrealized", totals.unrealized, true); setMetric("realized", totals.realized, true);
}

function setMetric(id, value, colored = false) { const element = document.querySelector(`#${id}`); element.textContent = money.format(value); if (colored) element.className = tone(value); }
function tone(value) { return value > .005 ? "positive" : value < -.005 ? "negative" : ""; }
function showError(caught) { error.textContent = caught.message; }

function updateCostMethodField() {
  const isSale = form.elements.type.value === "SELL";
  document.querySelector("#transaction-cost-method").hidden = !isSale;
  form.elements.costMethod.disabled = !isSale;
}
form.elements.type.addEventListener("change", updateCostMethodField);
updateCostMethodField();
document.querySelector("#global-cost-method").addEventListener("change", async event => {
  const select = event.target;
  const status = document.querySelector("#settings-status");
  select.disabled = true;
  status.textContent = "";
  try {
    const saved = await request("/api/settings", { method: "PUT", body: JSON.stringify({ costMethod: select.value }) });
    defaultCostMethod = saved.costMethod;
    await refresh();
    status.textContent = `Zapisano metodę globalną: ${defaultCostMethod}.`;
  } catch (caught) {
    select.value = defaultCostMethod;
    status.textContent = caught.message;
  } finally { select.disabled = false; }
});

function resetTransactionForm() {
  editingTransactionId = null;
  form.reset();
  updateCostMethodField();
  form.elements.date.valueAsDate = new Date();
  error.textContent = "";
  document.querySelector("#transaction-mode").textContent = "Nowy zapis";
  document.querySelector("#transaction-heading").textContent = "Dodaj transakcję";
  form.querySelector('[type="submit"]').textContent = "Dodaj transakcję";
  document.querySelector("#cancel-transaction").hidden = true;
}

document.querySelector("#cancel-transaction").addEventListener("click", () => {
  if (!savingTransaction) resetTransactionForm();
});
document.querySelector("#transactions-body").addEventListener("click", event => {
  const button = event.target.closest("[data-edit-transaction]");
  if (!button || savingTransaction) return;
  const item = transactions.find(item => item.id === button.dataset.editTransaction);
  if (!item) return;
  editingTransactionId = item.id;
  for (const key of ["date", "ticker", "type", "quantity", "price", "fee"]) form.elements.namedItem(key).value = item[key];
  form.elements.costMethod.value = item.costMethod ?? "";
  updateCostMethodField();
  error.textContent = "";
  document.querySelector("#transaction-mode").textContent = "Edycja";
  document.querySelector("#transaction-heading").textContent = "Edytuj transakcję";
  form.querySelector('[type="submit"]').textContent = "Zapisz zmiany";
  document.querySelector("#cancel-transaction").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  form.elements.date.focus({ preventScroll: true });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingTransaction) return;
  error.textContent = "";
  const data = new FormData(form);
  const item = { id: crypto.randomUUID(), createdAt: Date.now(), date: data.get("date"), ticker: data.get("ticker").trim().toUpperCase(), type: data.get("type"), quantity: Number(data.get("quantity")), price: Number(data.get("price")), fee: Number(data.get("fee")), costMethod: data.get("type") === "SELL" ? (data.get("costMethod") || null) : null };
  savingTransaction = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  document.querySelector("#cancel-transaction").disabled = true;
  try {
    await request(editingTransactionId ? `/api/transactions/${encodeURIComponent(editingTransactionId)}` : "/api/transactions", { method: editingTransactionId ? "PUT" : "POST", body: JSON.stringify(item) });
    resetTransactionForm();
    await refresh();
  } catch (caught) { showError(caught); }
  finally {
    savingTransaction = false;
    submit.disabled = false;
    document.querySelector("#cancel-transaction").disabled = false;
  }
});

document.addEventListener("change", async (event) => { if (!event.target.matches(".quote")) return; try { await request(`/api/quotes/${encodeURIComponent(event.target.dataset.ticker)}`, { method: "PUT", body: JSON.stringify({ price: Number(event.target.value) }) }); await refresh(); } catch (caught) { showError(caught); } });
document.addEventListener("click", async (event) => { const id = event.target.dataset.remove; if (!id) return; try { await request(`/api/transactions/${encodeURIComponent(id)}`, { method: "DELETE" }); await refresh(); } catch (caught) { showError(caught); } });
document.querySelector("#load-demo").addEventListener("click", async () => { try { await request("/api/demo", { method: "POST" }); await refresh(); } catch (caught) { showError(caught); } });
document.querySelector("#clear-all").addEventListener("click", async () => { if (!transactions.length || !confirm("Usunąć wszystkie transakcje i kursy?")) return; try { await request("/api/state", { method: "DELETE" }); await refresh(); } catch (caught) { showError(caught); } });

const assetForm = document.querySelector("#asset-form");
const assetError = document.querySelector("#asset-error");
const assetStatus = document.querySelector("#asset-status");

function renderAssets(positions) {
  const openTickers = new Set(positions.filter(position => position.quantity > 1e-9).map(position => position.ticker));
  document.querySelector("#assets-body").innerHTML = assets.length ? assets.map(asset => `<tr>
    <td>${escapeHtml(asset.name)}</td><td>${escapeHtml(asset.ticker)}</td>
    <td>${asset.symbols.map(item => `${escapeHtml(item.platform)}: ${escapeHtml(item.symbol)}`).join("<br>") || "—"}</td>
    <td><button type="button" class="secondary" data-edit-asset="${escapeHtml(asset.ticker)}" aria-label="Edytuj ${escapeHtml(asset.name)}">Edytuj</button> <button type="button" class="secondary danger" data-remove-asset="${escapeHtml(asset.ticker)}" aria-label="Usuń ${escapeHtml(asset.name)}" ${openTickers.has(asset.ticker) ? 'disabled title="Nie można usunąć aktywa z otwartą pozycją"' : ""}>Usuń</button></td>
  </tr>`).join("") : '<tr><td colspan="4" class="empty">Brak aktywów. Dodaj pierwsze aktywo lub transakcję.</td></tr>';
  document.querySelector("#asset-options").innerHTML = assets.map(asset => `<option value="${escapeHtml(asset.ticker)}">${escapeHtml(asset.name)}</option>`).join("");
}

function addSymbol(item = { platform: "", symbol: "" }) {
  const row = document.createElement("div");
  row.className = "symbol-row";
  row.innerHTML = `<label>Platforma<input class="symbol-platform" maxlength="60" required placeholder="np. GPW" value="${escapeHtml(item.platform)}" /></label>
    <label>Symbol lub nazwa<input class="symbol-value" maxlength="120" required placeholder="np. PKO" value="${escapeHtml(item.symbol)}" /></label>
    <button type="button" class="secondary danger" aria-label="Usuń symbol platformy">Usuń</button>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  document.querySelector("#asset-symbols").append(row);
}

function editAsset(asset) {
  editingTicker = asset?.ticker ?? null;
  assetForm.reset();
  assetError.textContent = "";
  assetStatus.textContent = "";
  assetForm.elements.namedItem("name").value = asset?.name ?? "";
  assetForm.elements.ticker.value = asset?.ticker ?? "";
  document.querySelector("#asset-editor-heading").textContent = asset ? "Edytuj aktywo" : "Dodaj aktywo";
  document.querySelector("#asset-symbols").replaceChildren();
  asset?.symbols.forEach(addSymbol);
  assetForm.hidden = false;
  assetForm.elements.namedItem("name").focus();
}

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  const active = button.dataset.view;
  document.querySelector("#portfolio-view").hidden = active !== "portfolio";
  document.querySelector("#assets-view").hidden = active !== "assets";
  document.querySelectorAll("[data-view]").forEach(item => {
    const selected = item === button;
    item.classList.toggle("secondary", !selected);
    if (selected) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}));
document.querySelector("#new-asset").addEventListener("click", () => editAsset());
document.querySelector("#assets-body").addEventListener("click", async event => {
  const remove = event.target.closest("[data-remove-asset]");
  if (remove) {
    const ticker = remove.dataset.removeAsset;
    remove.disabled = true;
    assetStatus.textContent = "";
    try {
      await request(`/api/assets/${encodeURIComponent(ticker)}`, { method: "DELETE" });
      if (editingTicker === ticker) {
        editingTicker = null;
        assetForm.hidden = true;
      }
      await refresh();
      assetStatus.textContent = `Usunięto aktywo: ${ticker}.`;
    } catch (caught) { assetStatus.textContent = caught.message; }
    finally { remove.disabled = false; }
    return;
  }
  const button = event.target.closest("[data-edit-asset]");
  if (button) editAsset(assets.find(asset => asset.ticker === button.dataset.editAsset));
});
document.querySelector("#add-symbol").addEventListener("click", () => addSymbol());
document.querySelector("#cancel-asset").addEventListener("click", () => { assetForm.hidden = true; });
assetForm.addEventListener("submit", async event => {
  event.preventDefault();
  assetError.textContent = "";
  const submit = assetForm.querySelector('[type="submit"]');
  submit.disabled = true;
  const data = {
    ticker: assetForm.elements.ticker.value,
    name: assetForm.elements.namedItem("name").value,
    symbols: [...document.querySelectorAll(".symbol-row")].map(row => ({ platform: row.querySelector(".symbol-platform").value, symbol: row.querySelector(".symbol-value").value })),
  };
  try {
    const saved = await request(editingTicker ? `/api/assets/${encodeURIComponent(editingTicker)}` : "/api/assets", { method: editingTicker ? "PUT" : "POST", body: JSON.stringify(data) });
    // Preserve the saved identity even if refreshing the portfolio fails.
    editingTicker = saved.ticker;
    await refresh();
    assetForm.hidden = true;
    assetStatus.textContent = `Zapisano aktywo: ${saved.name}.`;
  } catch (caught) { assetError.textContent = caught.message; }
  finally { submit.disabled = false; }
});

refresh().catch(showError);
