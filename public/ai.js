(() => {
  let providers = [];
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

  async function updateModels() {
    const selected = providers.find(item => item.id === $('#aiProviderSelect')?.value);
    const modelSelect = $('#aiModelSelect');
    if (!modelSelect) return;
    if (!selected) {
      modelSelect.innerHTML = '';
      $('#aiModelPicker')?.classList.add('hidden');
      return;
    }
    modelSelect.innerHTML = '<option value="">Memuat model...</option>';
    $('#aiModelPicker')?.classList.remove('hidden');
    try {
      const data = await window.serverDashboard.api(`/api/ai-providers/${selected.id}/models`);
      modelSelect.innerHTML = (data.models || []).map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join('') || '<option value="">Tidak ada model</option>';
    } catch (error) {
      modelSelect.innerHTML = '<option value="">Gagal memuat model</option>';
      console.warn(error);
    }
  }

  async function loadProviders() {
    try {
      const data = await window.serverDashboard.api('/api/ai-providers');
      providers = data.providers || [];
      const select = $('#aiProviderSelect');
      if (select) select.innerHTML = '<option value="server">OpenAI credential server</option>' + providers.map(item => `<option value="${esc(item.id)}">${esc(item.name)} - ${esc(item.provider)}</option>`).join('');
      await updateModels();
      const list = $('#aiProviderList');
      if (list) list.innerHTML = providers.map(item => `<div class="user-row"><div><b>${esc(item.name)}</b><small>${esc(item.provider)} - ${esc(item.keyHint)}<br>${esc(item.models.join(', '))}</small></div><button class="danger" data-ai-delete="${esc(item.id)}">Hapus</button></div>`).join('') || '<p class="muted">Belum ada provider.</p>';
    } catch (error) {
      if (window.serverDashboard?.isVisible()) console.warn(error);
    }
  }

  function showAiControls(show) {
    $('#aiProviderPicker')?.classList.toggle('hidden', !show);
    if (!show) $('#aiModelPicker')?.classList.add('hidden');
    else updateModels();
  }

  const originalFetch = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url?.match(/^\/api\/projects\/[^/]+\/codex$/) && init.body) {
      const body = JSON.parse(init.body);
      body.providerId = $('#aiProviderSelect')?.value || 'server';
      body.model = $('#aiModelSelect')?.value || '';
      init.body = JSON.stringify(body);
    }
    return originalFetch(input, init);
  };

  $('#aiProviderSelect')?.addEventListener('change', updateModels);
  $('#codexMode')?.addEventListener('click', async () => { showAiControls(true); await loadProviders(); showAiControls(true); });
  $('#shellMode')?.addEventListener('click', () => showAiControls(false));
  document.addEventListener('click', event => { if (event.target.closest('[data-terminal]')) setTimeout(loadProviders, 100); });
  $('#aiProviderType')?.addEventListener('change', () => $('#aiBaseUrlLabel').classList.toggle('hidden', $('#aiProviderType').value !== 'zyrouter'));
  $('#aiProviderForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await window.serverDashboard.api('/api/ai-providers', { method:'POST', body:JSON.stringify({ provider:$('#aiProviderType').value, name:$('#aiProviderName').value.trim(), apiKey:$('#aiProviderKey').value.trim(), models:$('#aiProviderModels').value.split(','), baseUrl:$('#aiProviderBaseUrl').value.trim() }) });
      event.target.reset(); $('#aiProviderBaseUrl').value = 'https://api.zyrouter.com/v1'; await loadProviders();
    } catch (error) { alert(error.message); }
  });
  $('#aiProviderList')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-ai-delete]');
    if (!button || !confirm('Hapus provider ini?')) return;
    try { await window.serverDashboard.api(`/api/ai-providers/${button.dataset.aiDelete}`, { method:'DELETE' }); await loadProviders(); }
    catch (error) { alert(error.message); }
  });

  setTimeout(() => { if (window.serverDashboard?.isVisible()) loadProviders(); }, 400);
})();
