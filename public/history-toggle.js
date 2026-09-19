(() => {
  const section = document.querySelector('#codexHistory');
  const button = document.querySelector('#historyToggle');
  const list = document.querySelector('#historyList');
  if (!section || !button || !list) return;

  function setExpanded(expanded, persist = true) {
    section.classList.toggle('history-collapsed', !expanded);
    button.setAttribute('aria-expanded', String(expanded));
    button.querySelector('span').textContent = expanded ? 'Hide' : 'Show';
    list.setAttribute('aria-hidden', String(!expanded));
    if (persist) localStorage.setItem('promptHistoryExpanded', String(expanded));
  }

  button.addEventListener('click', () => setExpanded(button.getAttribute('aria-expanded') !== 'true'));
  setExpanded(localStorage.getItem('promptHistoryExpanded') === 'true', false);
})();
