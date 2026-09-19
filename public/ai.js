(() => {
  let providers = [];
  const $ = s => document.querySelector(s);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function loadProviders() {
    try {
      const data = await window.serverDashboard.api('/api/ai-providers'); providers = data.providers || [];
      const select = $('#aiProviderSelect'); if (select) select.innerHTML = '<option value="server">Server credential</option>' + providers.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.provider)}</option>`).join('');
      updateModels();
      if ($('#aiProviderList')) $('#aiProviderList').innerHTML = providers.map(p => `<div class="user-row"><div><b>${esc(p.name)}</b><small>${esc(p.provider)} · ${esc(p.keyHint)}<br>${esc(p.models.join(', '))}</small></div><button class="danger" data-ai-delete="${esc(p.id)}">Hapus</button></div>`).join('') || '<p class="muted">Belum ada provider.</p>';
    } catch (error) { if (window.serverDashboard?.isVisible()) console.warn(error); }
  }
  function updateModels() { const p = providers.find(item => item.id === $('#aiProviderSelect')?.value); const box = $('#aiModelSelect'); if (!box) return; box.innerHTML = (p?.models || []).map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join(''); $('#aiProviderPicker')?.classList.toggle('hidden', false); $('#aiModelPicker')?.classList.toggle('hidden', !p); }
  const originalFetch = window.fetch;
  window.fetch = async (input, init = {}) => { const url = typeof input === 'string' ? input : input.url; if (url?.match(/^\/api\/projects\/[^/]+\/codex$/) && init.body) { const body = JSON.parse(init.body); body.providerId = $('#aiProviderSelect')?.value || 'server'; body.model = $('#aiModelSelect')?.value || ''; init.body = JSON.stringify(body); } return originalFetch(input, init); };
  $('#aiProviderSelect')?.addEventListener('change', updateModels);
  $('#aiProviderType')?.addEventListener('change', () => { $('#aiBaseUrlLabel').classList.toggle('hidden', $('#aiProviderType').value !== 'zyrouter'); });
  $('#aiProviderForm')?.addEventListener('submit', async e => { e.preventDefault(); try { await window.serverDashboard.api('/api/ai-providers', { method:'POST', body: JSON.stringify({ provider:$('#aiProviderType').value, name:$('#aiProviderName').value.trim(), apiKey:$('#aiProviderKey').value.trim(), models:$('#aiProviderModels').value.split(','), baseUrl:$('#aiProviderBaseUrl').value.trim() }) }); e.target.reset(); $('#aiProviderBaseUrl').value='https://api.zyrouter.com/v1'; window.notify?.('Provider AI berhasil ditambahkan'); await loadProviders(); } catch (error) { window.notify?.(error.message, true); } });
  $('#aiProviderList')?.addEventListener('click', async e => { const button = e.target.closest('[data-ai-delete]'); if (!button || !confirm('Hapus provider ini?')) return; try { await window.serverDashboard.api(`/api/ai-providers/${button.dataset.aiDelete}`, { method:'DELETE' }); window.notify?.('Provider dihapus'); await loadProviders(); } catch (error) { window.notify?.(error.message, true); } });
  const originalShow = window.showDashboard;
  if (originalShow) window.showDashboard = (...args) => { const result = originalShow(...args); loadProviders(); return result; };
  setTimeout(loadProviders, 400);
})();
