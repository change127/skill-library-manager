export async function runButtonAction(button, operation, options = {}) {
  const originalText = button.textContent;
  const originalDisabled = button.disabled;
  const setTimer = options.setTimer ?? ((callback) => globalThis.setTimeout(callback, 800));
  const notify = options.notify ?? (() => {});
  button.classList.remove('action-success', 'action-error');
  button.classList.add('action-busy');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (options.busyText) button.textContent = options.busyText;

  try {
    const value = await operation();
    button.classList.remove('action-busy');
    button.classList.add('action-success');
    button.removeAttribute('aria-busy');
    if (options.successText) button.textContent = options.successText;
    if (options.successMessage) notify(options.successMessage, 'success');
    setTimer(() => restoreButton(button, originalText, originalDisabled));
    return { ok: true, value };
  } catch (error) {
    button.classList.remove('action-busy');
    button.classList.add('action-error');
    button.removeAttribute('aria-busy');
    if (options.errorText) button.textContent = options.errorText;
    const message = typeof options.errorMessage === 'function'
      ? options.errorMessage(error)
      : options.errorMessage || error.message;
    if (message) notify(message, 'error');
    setTimer(() => restoreButton(button, originalText, originalDisabled));
    return { ok: false, error };
  }
}

function restoreButton(button, originalText, originalDisabled) {
  button.classList.remove('action-busy', 'action-success', 'action-error');
  button.removeAttribute('aria-busy');
  button.disabled = originalDisabled;
  button.textContent = originalText;
}
