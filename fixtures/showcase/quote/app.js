(() => {
  let step = 1;
  const titles = ['Driver', 'Driving history', 'Coverage', 'Review'];
  const value = id => document.getElementById(id).value;
  function payload() {
    return new URLSearchParams({ full_name: value('full_name'), date_of_birth: value('date_of_birth'), prior_claims: value('prior_claims'), claim_count: value('claim_count'), annual_km: value('annual_km'), plan: value('plan'), excess: document.querySelector('input[name=excess]:checked')?.value || '', roadside: document.getElementById('roadside').checked ? 'on' : '' });
  }
  function show() {
    for (let n = 1; n <= 4; n += 1) document.getElementById(`step${n}`).hidden = n !== step;
    document.getElementById('heading').textContent = `Step ${step} of 4: ${titles[step - 1]}`;
    document.getElementById('back').hidden = step === 1;
    document.getElementById('next').hidden = step === 4;
    document.getElementById('submit').hidden = step !== 4;
    if (step === 4) document.getElementById('review').textContent = [...payload().entries()].map(([key, val]) => `${key}: ${val}`).join('\n');
  }
  document.getElementById('prior_claims').addEventListener('change', event => { document.getElementById('claims-label').hidden = event.target.value !== 'yes'; });
  document.getElementById('back').addEventListener('click', () => { step -= 1; document.getElementById('error').textContent = ''; show(); });
  document.getElementById('next').addEventListener('click', async () => {
    document.getElementById('error').textContent = '';
    if (step === 1 && (!value('full_name') || !value('date_of_birth'))) { document.getElementById('error').textContent = 'Enter your name and date of birth.'; return; }
    if (step === 2 && value('prior_claims') === 'yes' && !value('claim_count')) { document.getElementById('error').textContent = 'Enter the number of prior claims.'; return; }
    if (step === 3) {
      if (!document.querySelector('input[name=excess]:checked')) { document.getElementById('error').textContent = 'Choose an excess.'; return; }
      const response = await fetch('/api/quote/validate', { method: 'POST', body: payload() });
      const result = await response.json();
      if (!response.ok) { document.getElementById('error').textContent = result.error; return; }
    }
    step += 1;
    show();
  });
  document.getElementById('submit').addEventListener('click', async () => {
    const response = await fetch('/api/quote/submit', { method: 'POST', body: payload() });
    const result = await response.json();
    if (!response.ok) { document.getElementById('error').textContent = result.error; return; }
    document.querySelector('main').querySelectorAll('section, nav, #heading, #error').forEach(el => { el.hidden = true; });
    document.getElementById('done').hidden = false;
    document.getElementById('reference').textContent = result.reference;
  });
  show();
})();
