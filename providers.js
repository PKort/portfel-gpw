export const providerNames = { yahoo: 'Yahoo Finance', bankier: 'Bankier.pl' };
export function normalizeProviderSymbol(sourceId, symbol) {
  if (!Object.hasOwn(providerNames, sourceId) || typeof symbol !== 'string') throw Object.assign(new Error('Wybierz dostawcę i podaj alias instrumentu.'), { status: 400 });
  const normalized = symbol.trim().toUpperCase();
  const pattern = sourceId === 'yahoo' ? /^[A-Z0-9][A-Z0-9._-]{0,63}\.WA$/ : /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
  if (!pattern.test(normalized)) throw Object.assign(new Error(`Nieprawidłowy alias ${providerNames[sourceId]}.${sourceId === 'yahoo' ? ' Wymagane zakończenie .WA.' : ''}`), { status: 400 });
  return normalized;
}
