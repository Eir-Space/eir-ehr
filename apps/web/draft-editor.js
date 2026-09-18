import { escape as e } from './renderers/shared.js';

// Serialize saves: an older response must never replace a newer revision or edited text.
export function draftEditor(
  target,
  { initial = '', save, loadLatest, adoptLatest, onDirty, onDiscard },
) {
  target.innerHTML = `<label>Journaltext<textarea name="text" aria-label="Journaltext" required maxlength="20000">${e(initial)}</textarea></label><p class="draft-status quiet" role="status">${initial ? 'Sparat utkast' : 'Nytt utkast'}</p><section class="draft-conflict" hidden><h3>Sparad version</h3><p></p><button type="button" id="draft-use-latest">Läs in sparad version</button></section><button type="button" id="draft-retry" hidden>Försök spara igen</button><button type="button" id="draft-discard">Stäng utan att spara ändringar</button>`;
  const input = target.querySelector('textarea'),
    status = target.querySelector('[role=status]');
  const retry = target.querySelector('#draft-retry'),
    conflict = target.querySelector('.draft-conflict');
  let saved = initial,
    timer,
    pending,
    disposed = false,
    blocked = false,
    latest;
  const dirty = () => input.value !== saved;
  async function showLatest() {
    try {
      latest = await loadLatest();
      if (!latest) throw new Error('Utkastet kunde inte hämtas.');
      conflict.hidden = false;
      conflict.querySelector('p').textContent = latest.data.text;
      target.querySelector('#draft-use-latest').disabled = latest.data.status !== 'draft';
      retry.hidden = true;
    } catch {
      retry.textContent = 'Hämta sparad version';
      retry.hidden = false;
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (pending) {
      await pending;
      return flush();
    }
    if (!dirty() || disposed) return;
    if (blocked)
      throw new Error('Utkastet har ändrats. Granska den sparade versionen innan du fortsätter.');
    const text = input.value;
    if (!text.trim())
      throw new Error('Journaltext kan inte vara tom. Den senast sparade versionen finns kvar.');
    status.textContent = 'Sparar…';
    retry.hidden = true;
    pending = (async () => {
      try {
        await save(text);
        saved = text;
        status.textContent =
          'Sparat ' +
          new Date().toLocaleTimeString('sv-SE', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
        onDirty(dirty());
      } catch (error) {
        status.textContent = 'Inte sparat. ' + error.message;
        retry.hidden = false;
        if (error.status === 409) {
          blocked = true;
          retry.hidden = true;
          await showLatest();
        }
        throw error;
      } finally {
        pending = null;
      }
    })();
    await pending;
    if (dirty()) await flush();
  }
  input.oninput = () => {
    onDirty(dirty());
    clearTimeout(timer);
    if (blocked) return;
    status.textContent = 'Osparade ändringar';
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 900);
  };
  retry.onclick = () => {
    void (blocked ? showLatest() : flush()).catch(() => {});
  };
  target.querySelector('#draft-discard').onclick = async () => {
    if (
      dirty() &&
      !confirm('Stäng och lämna osparade ändringar? Tidigare sparade versioner finns kvar.')
    )
      return;
    clearTimeout(timer);
    disposed = true;
    try {
      await pending;
    } catch {
      /* The user explicitly chose to leave unsaved changes. */
    }
    onDiscard();
  };
  target.querySelector('#draft-use-latest').onclick = () => {
    if (!latest || latest.data.status !== 'draft') return;
    if (dirty() && !confirm('Ersätt din osparade text med den sparade versionen?')) return;
    adoptLatest(latest);
    input.value = saved = latest.data.text;
    blocked = false;
    conflict.hidden = true;
    status.textContent = 'Sparad version inläst';
    onDirty(false);
  };
  return {
    flush,
    dispose() {
      clearTimeout(timer);
      disposed = true;
      onDirty(false);
    },
  };
}
