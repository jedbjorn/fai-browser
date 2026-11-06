(() => {
  const jobs = document.getElementById('jobs');
  function addJob() {
    const section = document.createElement('section');
    section.className = 'job';
    section.innerHTML = `<h4>Job ${jobs.children.length + 1}</h4><label>Company<input name="job_company" required></label><label>Title<input name="job_title" required></label><label>Years<input name="job_years" required placeholder="2022-2024"></label>`;
    jobs.append(section);
  }
  document.getElementById('add-job').addEventListener('click', addJob);
  addJob();
  document.getElementById('submit').addEventListener('click', async () => {
    const form = document.getElementById('application');
    if (!form.reportValidity()) { document.getElementById('error').textContent = 'Check the highlighted fields and phone format.'; return; }
    const response = await fetch('/api/jobs/submit', { method: 'POST', body: new FormData(form) });
    const result = await response.json();
    if (!response.ok) { document.getElementById('error').textContent = result.error; return; }
    form.hidden = true;
    document.querySelector('main > h2').hidden = true;
    document.getElementById('done').hidden = false;
    document.getElementById('confirmation').textContent = result.confirmation;
  });
})();
