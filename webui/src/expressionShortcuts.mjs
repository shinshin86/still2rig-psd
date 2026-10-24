function isEditing(target) {
  return Boolean(target?.isContentEditable || target?.closest?.('input, textarea, select') ||
    target?.parentElement?.isContentEditable);
}

/** Resolve only an available expression; leave typing and browser shortcuts alone. */
export function expressionShortcut(event, choices) {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isEditing(event.target) || event.composedPath?.().some(isEditing)) return null;
  const digit = /^[1-9]$/.test(event.key) ? event.key : /^Numpad[1-9]$/.test(event.code ?? '') ? event.code.slice(-1) : null;
  if (!digit) return null;
  const choice = choices[Number(digit) - 1];
  return choice && !choice.disabled ? choice.id : null;
}
