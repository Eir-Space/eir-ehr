const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const states = {
  pending: 'I kö',
  sending: 'Pågår',
  received: 'Mottaget i EHR',
  retry: 'Nytt försök väntar',
  quarantined: 'Kräver åtgärd i EHR',
  applied: 'Journalfört',
};
async function api(path, data) {
  const response = await fetch(path, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'content-type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Åtgärden misslyckades');
  return result;
}
async function perform(action) {
  try {
    $('#error').textContent = '';
    await action();
  } catch (e) {
    $('#error').textContent = e.message;
  }
}
let selectedOrder;
async function refresh() {
  const data = await api('/workspace');
  $('#ehr').href = data.ehr;
  $('#mode').value = data.mode;
  $('#orders').innerHTML =
    data.orders
      .map(
        (o) =>
          `<article><div><strong>${escape(o.patient.name)}</strong><p>${escape(o.order.test)} · ${escape(o.order.specimen)}</p><p>${escape(o.order.question)}</p><small>${escape(o.orderId)}</small></div><button data-result="${escape(o.orderId)}">Registrera svar</button></article>`,
      )
      .join('') || '<p>Inga mottagna beställningar.</p>';
  $('#results').innerHTML =
    data.results
      .map(
        (r) =>
          `<article><div><strong>${escape(r.result.name)}: ${escape(r.result.value)} ${escape(r.result.unit)}</strong><p>${escape(states[r.state] ?? r.state)}${r.code ? ` · ${escape(r.code)}` : ''}</p><small>${escape(r.messageId)}</small></div>${['retry', 'pending'].includes(r.state) ? `<button data-retry="${escape(r.id)}">Försök igen</button>` : ''}</article>`,
      )
      .join('') || '<p>Inga skickade svar.</p>';
  document.querySelectorAll('[data-result]').forEach((button) => {
    button.onclick = () => {
      selectedOrder = button.dataset.result;
      $('#result-form').reset();
      $('#result-form').elements.name.value = data.orders.find(
        (o) => o.orderId === selectedOrder,
      ).order.test;
      $('#result-form').elements.supersedesMessageId.innerHTML =
        '<option value="">Första svaret</option>' +
        data.results
          .filter((r) => r.orderId === selectedOrder)
          .map(
            (r) =>
              `<option value="${escape(r.messageId)}">${escape(r.messageId)} · ${escape(r.state)}</option>`,
          )
          .join('');
      $('#result-dialog').showModal();
    };
  });
  document.querySelectorAll('[data-retry]').forEach((button) => {
    button.onclick = () =>
      perform(async () => {
        await api(`/results/${button.dataset.retry}/retry`, {});
        await refresh();
      });
  });
}
$('#refresh').onclick = () => perform(refresh);
$('#mode').onchange = () =>
  perform(async () => {
    await api('/mode', { mode: $('#mode').value });
    await refresh();
  });
$('#cancel').onclick = () => $('#result-dialog').close();
$('#result-form').onsubmit = (event) => {
  event.preventDefault();
  const button = $('#result-form button[type=submit]');
  button.disabled = true;
  perform(async () => {
    await api(`/orders/${selectedOrder}/results`, Object.fromEntries(new FormData(event.target)));
    $('#result-dialog').close();
    await refresh();
  }).finally(() => {
    button.disabled = false;
  });
};
await perform(refresh);
