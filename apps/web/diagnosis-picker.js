import { escape as e } from './renderers/shared.js';

export const diagnosisFields = `
  <label for="diagnosis-query">Sök diagnos eller ICD-10-SE-kod</label>
  <input id="diagnosis-query" type="search" role="combobox" autocomplete="off"
    aria-autocomplete="list" aria-controls="diagnosis-results" aria-expanded="false"
    placeholder="Till exempel hypertoni eller I10.9" maxlength="100" />
  <p id="diagnosis-status" class="quiet" role="status"></p>
  <button type="button" id="diagnosis-retry" hidden>Försök igen</button>
  <div id="diagnosis-results" role="listbox" aria-label="Diagnoser"></div>
  <div id="diagnosis-selected" hidden></div>
  <label>Debutdatum<input name="onset" type="date" /></label>`;

export function diagnosisPicker(root, search, onChange = () => {}) {
  const input = root.querySelector('#diagnosis-query');
  const list = root.querySelector('#diagnosis-results');
  const status = root.querySelector('#diagnosis-status');
  const selected = root.querySelector('#diagnosis-selected');
  const retry = root.querySelector('#diagnosis-retry');
  let choice = null,
    items = [],
    active = -1,
    timer,
    controller,
    disposed = false;
  function highlight(index) {
    active = index;
    for (const [i, option] of [...list.children].entries())
      option.setAttribute('aria-selected', String(i === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `diagnosis-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const term = items[index];
    if (!term) return;
    if (!term.selectable) {
      input.value = term.code + '.';
      changed();
      input.focus();
      return;
    }
    choice = term;
    onChange();
    input.value = `${term.code} · ${term.display}`;
    list.replaceChildren();
    items = [];
    highlight(-1);
    input.setAttribute('aria-expanded', 'false');
    status.textContent = 'ICD-10-SE 2026';
    selected.hidden = false;
    selected.innerHTML = `<strong>${e(term.code)}</strong><span>${e(term.display)}</span>${term.notPrincipal || term.manifestation ? '<p class="quiet">Kompletterande kod. Kontrollera kodningsanvisningarna för huvuddiagnos och kombinationskodning.</p>' : ''}`;
  }
  async function load() {
    retry.hidden = true;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    status.textContent = 'Söker…';
    try {
      const result = await search(input.value, request.signal);
      if (disposed || request.signal.aborted) return;
      items = result.items;
      list.innerHTML = items
        .map(
          (
            term,
            i,
          ) => `<div role="option" id="diagnosis-${i}" aria-selected="false" data-index="${i}">
        <strong>${e(term.code)}</strong><span>${e(term.display)}${term.selectable ? '' : '<small>Välj underkod</small>'}</span>
      </div>`,
        )
        .join('');
      status.textContent = result.total
        ? `${result.total} träffar${result.total > items.length ? ` · visar ${items.length}` : ''} · ICD-10-SE 2026`
        : 'Inga diagnoser hittades.';
      input.setAttribute('aria-expanded', String(items.length > 0));
      highlight(-1);
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      status.textContent = 'Kunde inte hämta diagnoser.';
      retry.hidden = false;
    }
  }
  function changed() {
    onChange();
    retry.hidden = true;
    choice = null;
    selected.hidden = true;
    controller?.abort();
    clearTimeout(timer);
    list.replaceChildren();
    items = [];
    highlight(-1);
    input.setAttribute('aria-expanded', 'false');
    status.textContent = 'Söker…';
    timer = setTimeout(load, 200);
  }
  input.addEventListener('input', changed);
  retry.onclick = () => {
    void load();
    input.focus();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length)
        highlight(
          active < 0
            ? event.key === 'ArrowDown'
              ? 0
              : items.length - 1
            : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length,
        );
    } else if (event.key === 'Enter' && !choice) {
      event.preventDefault();
      if (active >= 0) choose(active);
    }
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[data-index]');
    if (option) choose(Number(option.dataset.index));
  });
  void load();
  return {
    value() {
      if (!choice) throw new Error('Välj en diagnos i sökresultatet.');
      const { system, version, code, display } = choice;
      return { system, version, code, display };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
