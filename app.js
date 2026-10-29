import { calculatePortfolioDetails, formatQuantity, transactionCashCents, calculateOperationHistory, calculateTotalReturn } from "./portfolio.js";
import { quoteStatus, quoteTooltip } from "./quote-status.js";
import { providerNames } from "./providers.js";

const money = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const percent = new Intl.NumberFormat("pl-PL", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 3 });
const form = document.querySelector("#transaction-form");
const error = document.querySelector("#form-error");
let transactions = [];
let quotes = {};
let quoteDetails = {};
let observedAssets = [];
let assets = [];
let defaultCostMethod = "FIFO";
let cashBalance = 0;
let cashDeposits = [];
let editingTicker = null;
let editingTransactionId = null;
let editingCashOperation = null;
const operationDialog = document.querySelector("#operation-dialog");
let savingTransaction = false;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const assetLabel = (ticker) => {
  const asset = assets.find(asset => asset.ticker === ticker);
  return asset ? `<strong>${escapeHtml(asset.name)}</strong><small class="asset-ticker">${escapeHtml(ticker)}</small>` : `<strong>${escapeHtml(ticker)}</strong>`;
};
form.elements.date.valueAsDate = new Date();

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", headers: { "Content-Type": "application/json" }, ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Błąd połączenia z serwerem.");
  return result;
}

const historyFilters = new Map();
let historySort = { column: "date", direction: "desc" };
const historyCollator = new Intl.Collator("pl", { numeric: true, sensitivity: "base" });
const historyDialog = document.querySelector("#history-filter");
let filterColumn;
let filterOptions = [];
let filterSelection = new Set();
const historyNames = { BUY: "Kupno", SELL: "Sprzedaż", DEPOSIT: "Zasilenie", WITHDRAWAL: "Wypłata", DIVIDEND: "Wypłata dywidendy" };
function historyValue(item, column, sales) {
  const sale = item.type === "SELL" ? sales.get(item.id) : null;
  switch (column) {
    case "asset": return item.isStock ? (assets.find(asset => asset.ticker === item.ticker)?.name ?? item.ticker) : item.type === "DIVIDEND" ? (item.ticker ? item.assetName ?? item.ticker : "Nieprzypisany emitent — edytuj") : "Gotówka";
    case "type": return historyNames[item.type];
    case "quantity": case "price": case "fee": return item.isStock ? item[column] : null;
    case "value": return item.isStock ? item.quantity * item.price : item.amount;
    case "method": return sale ? `${sale.method}${item.costMethod ? "" : " (globalna)"}` : null;
    case "profit": return sale?.profit ?? null;
    case "balance": return item.cashBalanceAfter;
    default: return item.date;
  }
}
function historyLabel(value, column) {
  if (value == null) return "(Puste)";
  if (["price", "value", "fee", "profit", "balance"].includes(column)) return (column === "price" ? price : money).format(value);
  return column === "quantity" ? formatQuantity(value) : String(value);
}
function historyKey(item, column, sales) { return historyLabel(historyValue(item, column, sales), column); }
function prepareHistory(rows, sales) {
  const filtered = rows.filter(item => [...historyFilters].every(([column, values]) => values.has(historyKey(item, column, sales))));
  const { column, direction } = historySort;
  filtered.sort((a, b) => {
    const left = historyValue(a, column, sales), right = historyValue(b, column, sales);
    if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
    const compared = typeof left === "number" ? left - right : historyCollator.compare(left, right);
    return direction === "asc" ? compared : -compared;
  });
  document.querySelectorAll("[data-column]").forEach(button => {
    const active = button.dataset.column === column;
    button.closest("th").setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
    button.classList.toggle("filtered", historyFilters.has(button.dataset.column));
    button.querySelector("span").textContent = `${historyFilters.has(button.dataset.column) ? "⏷ " : ""}${active ? (direction === "asc" ? "↑" : "↓") : "▾"}`;
    button.setAttribute("aria-label", `${button.textContent.trim()}. Sortowanie i filtrowanie${historyFilters.has(button.dataset.column) ? ", filtr aktywny" : ""}`);
  });
  document.querySelector("#history-status").textContent = `Operacje: ${filtered.length} z ${rows.length}${historyFilters.size ? ` · Aktywne filtry: ${historyFilters.size}` : ""}`;
  return filtered;
}
function renderFilterOptions() {
  const search = document.querySelector("#history-filter-search").value;
  const query = search.toLocaleLowerCase("pl");
  const visible = filterOptions.filter(value => value.toLocaleLowerCase("pl").includes(query));
  document.querySelector("#history-filter-values").innerHTML = visible.length ? visible.map(value => `<label><input type="checkbox" value="${escapeHtml(value)}" ${filterSelection.has(value) ? "checked" : ""}>${escapeHtml(value)}</label>`).join("") : '<p class="hint">Brak pasujących wartości.</p>';
}
document.querySelector("#history-columns").addEventListener("click", event => {
  const button = event.target.closest("[data-column]");
  if (!button) return;
  filterColumn = button.dataset.column;
  const { saleResults } = calculatePortfolioDetails(transactions, quotes, defaultCostMethod);
  const rows = calculateOperationHistory(transactions, cashDeposits, cashBalance);
  const values = rows.map(item => historyValue(item, filterColumn, saleResults));
  values.sort((a, b) => a == null ? 1 : b == null ? -1 : typeof a === "number" ? a - b : historyCollator.compare(a, b));
  filterOptions = [...new Set(values.map(value => historyLabel(value, filterColumn)))];
  filterSelection = new Set(historyFilters.get(filterColumn) ?? filterOptions);
  document.querySelector("#history-filter-title").textContent = button.childNodes[0].textContent.trim();
  document.querySelector("#history-filter-search").value = "";
  renderFilterOptions();
  historyDialog.showModal();
});
document.querySelector("#history-filter-search").addEventListener("input", renderFilterOptions);
document.querySelector("#history-filter-values").addEventListener("change", event => {
  if (event.target.checked) filterSelection.add(event.target.value);
  else filterSelection.delete(event.target.value);
});
for (const [id, checked] of [["history-filter-all", true], ["history-filter-none", false]]) {
  document.getElementById(id).addEventListener("click", () => {
    document.querySelectorAll('#history-filter-values input').forEach(input => {
      if (checked) filterSelection.add(input.value); else filterSelection.delete(input.value);
    });
    renderFilterOptions();
  });
}
document.querySelectorAll("[data-history-direction]").forEach(button => button.addEventListener("click", () => {
  historySort = { column: filterColumn, direction: button.dataset.historyDirection };
  historyDialog.close(); render();
}));
document.querySelector("#history-filter-close").addEventListener("click", () => historyDialog.close());
document.querySelector("#history-filter-apply").addEventListener("click", () => {
  if (filterOptions.every(value => filterSelection.has(value))) historyFilters.delete(filterColumn);
  else historyFilters.set(filterColumn, new Set(filterSelection));
  historyDialog.close(); render();
});
document.querySelector("#history-filter-clear").addEventListener("click", () => {
  historyFilters.delete(filterColumn); historyDialog.close(); render();
});
document.querySelector("#history-reset").addEventListener("click", () => {
  historyFilters.clear(); historySort = { column: "date", direction: "desc" }; render();
});

async function refresh() {
  const state = await request("/api/state");
  transactions = state.transactions;
  quotes = state.quotes;
  quoteDetails = state.quoteDetails ?? {};
  observedAssets = state.observedAssets ?? [];
  assets = state.assets;
  defaultCostMethod = state.settings.costMethod;
  cashBalance = state.settings.cashBalance ?? 0;
  cashDeposits = state.cashOperations ?? [];

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
        <td>${money.format(position.averageCost)}</td><td><div class="position-quote"><input class="quote" data-ticker="${escapeHtml(position.ticker)}" type="number" min="0" step="0.01" value="${position.quote ?? ""}" placeholder="0,00" ${Object.hasOwn(providerNames, quoteDetails[position.ticker]?.sourceId ?? "") ? 'readonly title="Kurs pobierany ze źródła zewnętrznego"' : ""}>${quoteCaption(position.ticker, true)}${externalQuoteButton(position.ticker)}</div></td>
        <td>${money.format(position.marketValue)}</td><td class="${tone(position.unrealized)}">${money.format(position.unrealized)}</td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">Brak otwartych pozycji.</td></tr>';
  const allHistory = calculateOperationHistory(transactions, cashDeposits, cashBalance);
  const history = prepareHistory(allHistory, saleResults);
  const operationNames = { BUY: "Kupno", SELL: "Sprzedaż", DEPOSIT: "Zasilenie", WITHDRAWAL: "Wypłata", DIVIDEND: "Wypłata dywidendy" };
  document.querySelector("#transactions-body").innerHTML = history.length
    ? history.map(item => {
      const sale = item.type === "SELL" ? saleResults.get(item.id) : null;
      const actions = item.isStock
        ? `<button type="button" class="secondary" data-edit-transaction="${escapeHtml(item.id)}">Edytuj</button> <button class="icon-button" data-remove="${escapeHtml(item.id)}" aria-label="Usuń transakcję">×</button>`
        : `<button type="button" class="secondary" data-edit-cash="${escapeHtml(item.key)}">Edytuj</button> <button class="icon-button" data-remove-cash="${escapeHtml(item.key)}" aria-label="Usuń operację gotówkową">×</button>`;
      return `<tr>
        <td>${escapeHtml(item.date)}</td><td>${item.isStock ? assetLabel(item.ticker) : item.type === "DIVIDEND" ? (item.ticker ? `<strong>${escapeHtml(item.assetName ?? item.ticker)}</strong><small class="asset-ticker">${escapeHtml(item.ticker)}</small>` : "Nieprzypisany emitent — edytuj") : "Gotówka"}</td>
        <td><span class="pill ${item.cashChangeCents < 0 ? "sell" : "buy"}">${operationNames[item.type]}</span></td>
        <td>${item.isStock ? formatQuantity(item.quantity) : "—"}</td><td>${item.isStock ? price.format(item.price) : "—"}</td>
        <td>${money.format(item.isStock ? item.quantity * item.price : item.amount)}</td><td>${item.isStock ? money.format(item.fee) : "—"}</td>
        <td>${sale ? `${sale.method}${item.costMethod ? "" : " (globalna)"}` : "—"}</td>
        <td class="${sale ? tone(sale.profit) : ""}" ${sale ? `title="Koszt jednostkowy rozliczony metodą ${sale.method}: ${price.format(sale.averageAcquisitionCost)}"` : ""}>${sale ? money.format(sale.profit) : "—"}</td>
        <td class="cash-after ${tone(item.cashBalanceAfter)}">${money.format(item.cashBalanceAfter)}</td><td>${actions}</td></tr>`;
    }).join("")
    : `<tr><td colspan="11" class="empty">${allHistory.length ? 'Brak operacji spełniających wybrane filtry.' : 'Dodaj pierwszą operację.'}</td></tr>`;
  const totals = positions.reduce((sum, p) => ({ marketValue: sum.marketValue + p.marketValue, cost: sum.cost + p.cost, unrealized: sum.unrealized + p.unrealized, realized: sum.realized + p.realized }), { marketValue: 0, cost: 0, unrealized: 0, realized: 0 });
  const { totalDeposits, returnRate } = calculateTotalReturn(totals.marketValue, cashBalance, cashDeposits);
  setMetric("total-deposits", totalDeposits);
  const returnMetric = document.querySelector("#total-return");
  returnMetric.textContent = returnRate === null ? "—" : percent.format(returnRate);
  returnMetric.className = returnRate === null ? "" : returnRate > 0.00005 ? "positive" : returnRate < -0.00005 ? "negative" : "";
  returnMetric.title = returnRate === null ? "Dodaj zasilenie konta, aby obliczyć wynik." : "(Wartość akcji + gotówka) / suma wpłat − 1. Suma wpłat obejmuje tylko zasilenia; wypłaty jej nie pomniejszają, a dywidendy nie są wpłatami.";
  setMetric("cash-value", cashBalance);
  setMetric("portfolio-value", totals.marketValue + cashBalance);
  setMetric("market-value", totals.marketValue); setMetric("open-cost", totals.cost);
  setMetric("unrealized", totals.unrealized, true); setMetric("realized", totals.realized, true);
}

const quoteDate = timestamp => timestamp == null ? "czas nieznany" : new Date(timestamp).toLocaleString("pl-PL");
function quoteCaption(ticker, compact = false) {
  const quote = quoteDetails[ticker];
  const feed = observedAssets.find(item => item.ticker === ticker);
  const status = quoteStatus(feed, quote);
  if (compact) {
    const external = quote && Object.hasOwn(providerNames, quote.sourceId);
    const manual = quote && !external;
    const detail = quoteTooltip(feed, quote, providerNames[quote?.sourceId]);
    const hand = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7h-1c-2 0-3.5-1-5-3l-4-5a1.5 1.5 0 0 1 2-2l2 2"/></svg>';
    const dot = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>';
    return `<button type="button" class="quote-info ${external && status.tone === "success" ? "quote-info-active" : "quote-info-muted"}" title="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}">${manual ? hand : dot}</button>`;
  }
  const badge = `<span class="quote-status quote-status-${status.tone}" title="${escapeHtml(status.detail)}">${escapeHtml(status.label)}</span>`;
  if (!quote) return badge;
  const source = Object.hasOwn(providerNames, quote.sourceId) ? `${providerNames[quote.sourceId]} · kurs zewnętrzny` : quote.sourceId === "legacy" ? "Kurs sprzed migracji" : "Kurs ręczny";
  return `${badge}<small class="asset-ticker">${escapeHtml(source)}<br>${escapeHtml(quoteDate(quote.quotedAt))}</small>`;
}
function externalQuoteButton(ticker) {
  const feed = observedAssets.find(item => item.ticker === ticker);
  if (!feed) return "";
  return `<button type="button" class="icon-button external-quote-button" data-external-quote="${escapeHtml(ticker)}" aria-label="Pobierz kurs zewnętrzny i włącz automatyczne kursy dla ${escapeHtml(ticker)}" title="Pobierz kurs zewnętrzny i przełącz na automatyczne kursy" ${feed.status === "source_disabled" ? "disabled" : ""}>↻</button>`;
}
function feedCaption(ticker) {
  const feed = observedAssets.find(item => item.ticker === ticker);
  if (!feed) return "Oczekuje na konfigurację";
  if (feed.status === "source_disabled") return "Automatyczne pobieranie wyłączone";
  if (feed.lastError) return `Błąd: ${feed.lastError}`;
  return feed.lastSuccessAt ? `Ostatnie pobranie: ${quoteDate(feed.lastSuccessAt)}` : "Oczekuje na pobranie";
}
function setMetric(id, value, colored = false) { const element = document.querySelector(`#${id}`); element.textContent = money.format(value); if (colored) element.className = tone(value); }
function tone(value) { return value > .005 ? "positive" : value < -.005 ? "negative" : ""; }
function showError(caught) { error.textContent = caught.message; }

function updateCostMethodField() {
  const isSale = form.elements.type.value === "SELL";
  const isCash = ["DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(form.elements.type.value);
  for (const field of form.querySelectorAll("[data-stock-field]")) {
    field.hidden = isCash;
    field.querySelector("input").disabled = isCash;
  }
  const needsAsset = !isCash || form.elements.type.value === "DIVIDEND";
  document.querySelector("#operation-asset-field").hidden = !needsAsset;
  form.elements.ticker.disabled = !needsAsset;
  document.querySelector("#cash-amount-field").hidden = !isCash;
  form.elements.amount.disabled = !isCash;
  updateOperationEffect();
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

function updateOperationEffect() {
  const type = form.elements.type.value;
  const isCash = ["DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(type);
  const amount = isCash ? form.elements.amount.valueAsNumber : form.elements.quantity.valueAsNumber * form.elements.price.valueAsNumber;
  const fee = isCash ? 0 : form.elements.fee.valueAsNumber;
  const rawDelta = type === "BUY" || type === "WITHDRAWAL" ? -(amount + fee) : amount - fee;
  const delta = Number.isFinite(rawDelta) && Number.isSafeInteger(Math.round(Math.abs(rawDelta) * 100)) ? (isCash ? rawDelta : transactionCashCents({ type, quantity: form.elements.quantity.valueAsNumber, price: form.elements.price.valueAsNumber, fee })) / (isCash ? 1 : 100) : NaN;
  document.querySelector("#operation-effect").textContent = Number.isFinite(delta) ? `Zmiana gotówki: ${delta > 0 ? "+" : ""}${money.format(delta)} · Saldo po operacji: ${money.format(cashBalance + delta)}` : "Kwoty w PLN. Prowizja jest uwzględniana w saldzie gotówki.";
  if (editingTransactionId || editingCashOperation) document.querySelector("#operation-effect").textContent = "Zapisanie zmian skoryguje saldo gotówki o różnicę względem poprzedniej operacji.";
}
form.addEventListener("input", updateOperationEffect);
document.querySelector("#new-operation").addEventListener("click", () => { resetTransactionForm(); operationDialog.showModal(); });
function closeOperation() { if (!savingTransaction) { operationDialog.close(); resetTransactionForm(); } }
document.querySelector("#close-operation").addEventListener("click", closeOperation);
operationDialog.addEventListener("cancel", event => { if (savingTransaction) event.preventDefault(); });
operationDialog.addEventListener("close", () => { if (!savingTransaction) resetTransactionForm(); });
document.querySelector("#transactions-body").addEventListener("click", async event => {
  if (savingTransaction) return;
  const edit = event.target.closest("[data-edit-cash]");
  const remove = event.target.closest("[data-remove-cash]");
  if (remove) {
    if (!confirm("Usunąć operację gotówkową? Saldo zostanie skorygowane.")) return;
    try { await request(`/api/cash-operations/${remove.dataset.removeCash}`, { method: "DELETE" }); await refresh(); } catch (caught) { showError(caught); }
  }
  if (!edit) return;
  const item = cashDeposits.find(item => `${item.type}/${item.id}` === edit.dataset.editCash);
  if (!item) return;
  resetTransactionForm();
  editingCashOperation = edit.dataset.editCash;
  for (const key of ["date", "type", "amount"]) form.elements[key].value = item[key];
  form.elements.ticker.value = item.ticker ?? "";
  form.elements.type.disabled = true;
  updateCostMethodField();
  document.querySelector("#transaction-heading").textContent = "Edytuj operację";
  document.querySelector("#transaction-mode").textContent = "Edycja";
  operationDialog.showModal();
});

function resetTransactionForm() {
  editingTransactionId = null;
  editingCashOperation = null;
  form.elements.type.disabled = false;
  form.reset();
  updateCostMethodField();
  form.elements.date.valueAsDate = new Date();
  error.textContent = "";
  document.querySelector("#transaction-mode").textContent = "Nowy zapis";
  document.querySelector("#transaction-heading").textContent = "Dodaj operację";
  form.querySelector('[type="submit"]').textContent = "Zapisz";
  document.querySelector("#cancel-transaction").hidden = false;
}

document.querySelector("#cancel-transaction").addEventListener("click", () => {
  closeOperation();
});
document.querySelector("#transactions-body").addEventListener("click", event => {
  const button = event.target.closest("[data-edit-transaction]");
  if (!button || savingTransaction) return;
  const item = transactions.find(item => item.id === button.dataset.editTransaction);
  if (!item) return;
  resetTransactionForm();
  editingTransactionId = item.id;
  for (const key of ["date", "ticker", "type", "quantity", "price", "fee"]) form.elements.namedItem(key).value = item[key];
  form.elements.costMethod.value = item.costMethod ?? "";
  updateCostMethodField();
  error.textContent = "";
  document.querySelector("#transaction-mode").textContent = "Edycja";
  document.querySelector("#transaction-heading").textContent = "Edytuj transakcję";
  form.querySelector('[type="submit"]').textContent = "Zapisz zmiany";
  document.querySelector("#cancel-transaction").hidden = false;
  form.elements.type.disabled = true;
  operationDialog.showModal();
  form.elements.date.focus({ preventScroll: true });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingTransaction) return;
  error.textContent = "";
  const data = new FormData(form);
  const item = { id: crypto.randomUUID(), createdAt: Date.now(), date: data.get("date"), ticker: (data.get("ticker") ?? "").trim().toUpperCase(), type: form.elements.type.value, quantity: Number(data.get("quantity")), price: Number(data.get("price")), fee: Number(data.get("fee")), costMethod: data.get("type") === "SELL" ? (data.get("costMethod") || null) : null };
  savingTransaction = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  document.querySelector("#cancel-transaction").disabled = true;
  try {
    if (["DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(form.elements.type.value)) {
      await request(editingCashOperation ? `/api/cash-operations/${editingCashOperation}` : "/api/cash-operations", { method: editingCashOperation ? "PUT" : "POST", body: JSON.stringify({ type: form.elements.type.value, date: data.get("date"), amount: form.elements.amount.valueAsNumber, ...(form.elements.type.value === "DIVIDEND" ? { ticker: form.elements.ticker.value.trim().toUpperCase() } : {}) }) });
    } else {
      item.costMethod = form.elements.type.value === "SELL" ? (data.get("costMethod") || null) : null;
      await request(editingTransactionId ? `/api/transactions/${encodeURIComponent(editingTransactionId)}` : "/api/transactions", { method: editingTransactionId ? "PUT" : "POST", body: JSON.stringify(item) });
    }
    operationDialog.close();
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
document.querySelector("#clear-all").addEventListener("click", async () => { if (!transactions.length || !confirm("Usunąć wszystkie transakcje akcji? Operacje gotówkowe i historia cen zostaną zachowane.")) return; try { await request("/api/state", { method: "DELETE" }); await refresh(); } catch (caught) { showError(caught); } });

const assetForm = document.querySelector("#asset-form");
const assetError = document.querySelector("#asset-error");
const assetStatus = document.querySelector("#asset-status");

const feedDrafts = new Map();
function feedDraft(asset) {
  const feed = observedAssets.find(item => item.ticker === asset.ticker);
  return feedDrafts.get(asset.ticker) ?? {
    selected: feed?.sourceId ?? 'yahoo', defaultSource: feed?.sourceId ?? 'yahoo',
    symbols: Object.fromEntries(Object.entries(providerNames).map(([id,name]) => [id,
      feed?.aliases?.[id] ?? (feed?.sourceId === id ? feed.sourceSymbol : null)
      ?? asset.symbols.find(item => item.platform.toLowerCase() === name.toLowerCase())?.symbol
      ?? (id === 'yahoo' ? `${asset.ticker}.WA` : asset.ticker)])),
  };
}
function feedEditor(asset) {
  const draft = feedDraft(asset);
  const isDefault = draft.selected === draft.defaultSource;
  return `<div class="feed-fields">
    <label>Dostawca<select data-feed-source="${escapeHtml(asset.ticker)}" aria-label="Dostawca kursów ${escapeHtml(asset.ticker)}">${Object.entries(providerNames).map(([id,name]) => `<option value="${id}" ${id === draft.selected ? "selected" : ""} ${id === draft.defaultSource ? 'class="default-provider"' : ""}>${name}${id === draft.defaultSource ? ' ★ (domyślny)' : ''}</option>`).join("")}</select></label>
    <label>Symbol instrumentu<input data-provider-alias="${draft.selected}" aria-label="Alias ${providerNames[draft.selected]} ${escapeHtml(asset.ticker)}" value="${escapeHtml(draft.symbols[draft.selected])}" maxlength="67"></label>
    <label class="feed-default"><input type="checkbox" data-feed-default="${escapeHtml(asset.ticker)}" ${isDefault ? 'checked disabled' : ''} title="Aby zmienić domyślnego dostawcę, wybierz innego i zaznacz to pole">Domyślny</label>
    </div><button type="button" class="secondary" data-save-feed="${escapeHtml(asset.ticker)}">Zapisz</button>${externalQuoteButton(asset.ticker)}${quoteCaption(asset.ticker)}<small class="asset-ticker">${escapeHtml(feedCaption(asset.ticker))}</small>`;
}
function renderAssets() {
  document.querySelector("#assets-body").innerHTML = assets.length ? assets.map(asset => `<tr>
    <td>${escapeHtml(asset.name)}</td><td>${escapeHtml(asset.ticker)}</td>
    <td>${asset.symbols.map(item => `${escapeHtml(item.platform)}: ${escapeHtml(item.symbol)}`).join("<br>") || "—"}</td>
    <td class="feed-editor">${feedEditor(asset)}</td>
    <td><button type="button" class="secondary" data-edit-asset="${escapeHtml(asset.ticker)}" aria-label="Edytuj ${escapeHtml(asset.name)}">Edytuj</button> <button type="button" class="secondary danger" data-remove-asset="${escapeHtml(asset.ticker)}" aria-label="Archiwizuj ${escapeHtml(asset.name)}">Archiwizuj</button></td>
  </tr>`).join("") : '<tr><td colspan="5" class="empty">Brak aktywów. Dodaj pierwsze aktywo lub transakcję.</td></tr>';
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
document.querySelector("#assets-body").addEventListener("input", event => {
  if (!event.target.matches('[data-provider-alias]')) return;
  const cell = event.target.closest('td');
  const ticker = cell.querySelector('[data-feed-source]').dataset.feedSource;
  const draft = feedDraft(assets.find(asset => asset.ticker === ticker));
  draft.symbols[draft.selected] = event.target.value;
  feedDrafts.set(ticker, draft);
});
document.querySelector("#assets-body").addEventListener("change", event => {
  const select = event.target.closest('[data-feed-source]');
  const checkbox = event.target.closest('[data-feed-default]');
  if (!select && !checkbox) return;
  const ticker = select?.dataset.feedSource ?? checkbox.dataset.feedDefault;
  const asset = assets.find(asset => asset.ticker === ticker);
  const draft = feedDraft(asset);
  if (select) draft.selected = select.value;
  if (checkbox?.checked) draft.defaultSource = draft.selected;
  feedDrafts.set(ticker, draft);
  event.target.closest('td').innerHTML = feedEditor(asset);
});
document.querySelector("#assets-body").addEventListener("click", async event => {
  const saveFeed = event.target.closest("[data-save-feed]");
  if (saveFeed) {
    saveFeed.disabled = true;
    try {
      const ticker = saveFeed.dataset.saveFeed;
      const asset = assets.find(asset => asset.ticker === ticker);
      const draft = feedDraft(asset);
      const feed = observedAssets.find(item => item.ticker === ticker);
      const changedDefault = draft.defaultSource !== (feed?.sourceId ?? 'yahoo');
      const sourceId = changedDefault ? draft.defaultSource : draft.selected;
      const makeDefault = changedDefault || sourceId === draft.defaultSource;
      await request(`/api/price-feeds/${encodeURIComponent(ticker)}`, { method: "PUT", body: JSON.stringify({ sourceId, symbols: draft.symbols, makeDefault }) });
      feedDrafts.delete(ticker);
      if (makeDefault) {
        try {
          await request(`/api/quotes/refresh/${encodeURIComponent(ticker)}`, { method: "POST" });
          assetStatus.textContent = `Zapisano. Domyślne źródło: ${providerNames[sourceId]}.`;
        } catch (caught) { assetStatus.textContent = `Zapisano konfigurację. ${caught.message} Zachowano dotychczasową wycenę.`; }
      } else assetStatus.textContent = "Zapisano alias. Domyślny dostawca pozostaje bez zmian.";
      await refresh();
    } catch (caught) { assetStatus.textContent = caught.message; }
    finally { saveFeed.disabled = false; }
    return;
  }
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
      assetStatus.textContent = `Zarchiwizowano aktywo: ${ticker}.`;
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

const refreshQuotes = document.querySelector("#refresh-quotes");
refreshQuotes.addEventListener("click", async () => {
  refreshQuotes.disabled = true;
  const status = document.querySelector("#quotes-status");
  status.textContent = "Pobieranie kursów…";
  try {
    const result = await request("/api/quotes/refresh", { method: "POST" });
    await refresh();
    status.textContent = result.status === "disabled" ? "Automatyczne pobieranie jest wyłączone."
      : result.status === "backoff" ? `Pobrano: ${result.updated}, błędy: ${result.failed}. Jeden z dostawców ograniczył dostęp; pozostałe źródła nadal działają.`
      : result.updated === 0 && result.failed === 0
        ? result.skipped > 0
          ? `Nie wysłano żądań: ${result.skipped} instrumentów oczekuje na interwał. Najbliższa próba nie wcześniej niż ${quoteDate(result.nextAttemptAt)}. Aby pobrać pojedynczy kurs teraz, użyj ikony ↻.`
          : "Brak aktywnych instrumentów ze skonfigurowanym źródłem. Sprawdź tabelę Aktywa."
        : `Pobrano: ${result.updated}, błędy: ${result.failed}, oczekuje na interwał: ${result.skipped ?? 0}.`;
  } catch (caught) { status.textContent = caught.message; }
  finally { refreshQuotes.disabled = false; }
});
setInterval(() => {
  // Do not overwrite fields while a user edits a transaction, asset or provider symbol.
  if (document.hidden || operationDialog.open || feedDrafts.size > 0 || editingTransactionId || !assetForm.hidden || savingTransaction || document.activeElement?.matches("input, select, textarea")) return;
  refresh().catch(showError);
}, 60_000);

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-external-quote]");
  if (!button) return;
  const ticker = button.dataset.externalQuote;
  document.querySelectorAll("[data-external-quote]").forEach(item => { item.disabled = true; });
  button.setAttribute("aria-busy", "true");
  const status = document.querySelector("#quotes-status");
  let message;
  try {
    await request(`/api/quotes/refresh/${encodeURIComponent(ticker)}`, { method: "POST" });
    message = `${ticker}: pobrano kurs i włączono wycenę ze źródła zewnętrznego.`;
  } catch (caught) { message = `${ticker}: ${caught.message}`; showError(new Error(message)); }
  finally {
    try { await refresh(); } catch (caught) { showError(caught); }
    document.querySelectorAll("[data-external-quote]").forEach(item => {
      item.disabled = observedAssets.find(feed => feed.ticker === item.dataset.externalQuote)?.status === "source_disabled";
      item.removeAttribute("aria-busy");
    });
    status.textContent = message;
  }
});
