export const providerNames = { yahoo: 'Yahoo Finance', bankier: 'Bankier.pl', bossa: 'bossaAPI Notowania' };

export function validIsin(isin) {
  if (typeof isin !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) || isin === 'PLDEMO000000') return false;
  const digits = [...isin].map(char => /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char).join('');
  return [...digits].reverse().reduce((sum, digit, index) => {
    const value = Number(digit) * (index % 2 ? 2 : 1);
    return sum + (value > 9 ? value - 9 : value);
  }, 0) % 10 === 0;
}

export function normalizeProviderSymbol(sourceId, symbol) {
  if (!Object.hasOwn(providerNames, sourceId) || typeof symbol !== 'string') throw Object.assign(new Error('Wybierz dostawcę i podaj alias instrumentu.'), { status: 400 });
  let normalized = symbol.trim().toUpperCase();
  if (sourceId === 'bossa') {
    if (!normalized.includes(':')) normalized = `GPW:${normalized}`;
    if (!normalized.startsWith('GPW:') || !validIsin(normalized.slice(4))) throw Object.assign(new Error('bossaAPI: podaj GPW:ISIN lub sam poprawny ISIN, np. PLPKO0000016.'), { status: 400 });
    return normalized;
  }
  const pattern = sourceId === 'yahoo' ? /^[A-Z0-9][A-Z0-9._-]{0,63}\.WA$/ : /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
  if (!pattern.test(normalized)) throw Object.assign(new Error(`Nieprawidłowy alias ${providerNames[sourceId]}.${sourceId === 'yahoo' ? ' Wymagane zakończenie .WA.' : ''}`), { status: 400 });
  return normalized;
}
