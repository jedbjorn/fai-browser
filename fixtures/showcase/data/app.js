(() => {
  const names = ['Aster Labs', 'Boreal Works', 'Cedar Logic', 'Drift Systems', 'Ember Analytics', 'Fjord Digital', 'Grove Software', 'Harbor Cloud', 'Iris Data', 'Juniper Group', 'Keystone Apps', 'Lumen Services'];
  const rows = [{ name: 'Aster Labs', region: 'North', revenue: 98200, status: 'Active' }, { name: 'Boreal Works', region: 'North', revenue: 96500, status: 'Active' }, { name: 'Cedar Logic', region: 'North', revenue: 94100, status: 'Active' }];
  for (let i = 3; i < 66; i += 1) rows.push({ name: `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`, region: i < 54 ? 'North' : i % 2 ? 'South' : 'West', revenue: 18000 + ((i * 7919) % 72000), status: i % 4 ? 'Active' : 'Review' });
  let page = 1;
  const size = 2;
  function draw() {
    const region = document.getElementById('region').value;
    const sort = document.getElementById('sort').value;
    const filtered = rows.filter(row => region === 'All' || row.region === region);
    filtered.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'revenue-desc' ? b.revenue - a.revenue : a.revenue - b.revenue);
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    page = Math.min(page, pages);
    const visible = filtered.slice((page - 1) * size, page * size);
    document.getElementById('summary').textContent = `${filtered.length} matching accounts · Page ${page} of ${pages}`;
    document.getElementById('rows').innerHTML = visible.map(row => `<tr><td>${row.name}</td><td>${row.region}</td><td>$${row.revenue.toLocaleString('en-US')}</td><td>${row.status}</td></tr>`).join('');
    document.getElementById('previous').disabled = page === 1;
    document.getElementById('next').disabled = page === pages;
  }
  for (const id of ['region', 'sort']) document.getElementById(id).addEventListener('change', () => { page = 1; draw(); });
  document.getElementById('previous').addEventListener('click', () => { page -= 1; draw(); });
  document.getElementById('next').addEventListener('click', () => { page += 1; draw(); });
  draw();
})();
