(() => {
  const flights = [
    { airline: 'Skyline Connect', departure: '05:50', price: 29, stops: '1 stop' },
    { airline: 'Ryanair', departure: '06:10', price: 41, stops: 'Nonstop' },
    { airline: 'easyJet', departure: '07:35', price: 52, stops: 'Nonstop' },
    { airline: 'British Airways', departure: '09:20', price: 68, stops: 'Nonstop' },
    { airline: 'Vueling', departure: '12:45', price: 37, stops: '1 stop' },
    { airline: 'Air France', departure: '15:05', price: 81, stops: 'Nonstop' },
    { airline: 'Ryanair', departure: '18:30', price: 58, stops: 'Nonstop' },
    { airline: 'Lufthansa', departure: '20:15', price: 47, stops: '1 stop' },
  ];
  let date = null;
  const to = document.getElementById('to');
  const places = document.getElementById('places');
  to.addEventListener('input', () => {
    const q = to.value.toLowerCase();
    const options = ['London, United Kingdom', 'London Heathrow (LHR)', 'London Gatwick (LGW)', 'London, Ontario'].filter(x => q.length > 1 && x.toLowerCase().includes(q));
    places.innerHTML = options.map(x => `<div role="option" tabindex="-1">${x}</div>`).join('');
    places.hidden = !options.length;
  });
  places.addEventListener('click', event => {
    const option = event.target.closest('[role=option]');
    if (!option) return;
    to.value = option.textContent;
    places.hidden = true;
  });
  const calendar = document.getElementById('calendar');
  const days = document.getElementById('days');
  for (let day = 1; day <= 30; day += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(day);
    button.dataset.date = `2026-11-${String(day).padStart(2, '0')}`;
    button.addEventListener('click', () => { date = button.dataset.date; document.getElementById('date-open').textContent = `Departure: ${date}`; });
    days.append(button);
  }
  document.getElementById('date-open').addEventListener('click', () => { calendar.hidden = false; });
  document.getElementById('date-done').addEventListener('click', () => { calendar.hidden = true; });
  function draw() {
    const nonstop = document.getElementById('nonstop').checked;
    const sort = document.getElementById('sort').value;
    const rows = flights.filter(f => !nonstop || f.stops === 'Nonstop');
    if (sort === 'price') rows.sort((a, b) => a.price - b.price);
    if (sort === 'departure') rows.sort((a, b) => a.departure.localeCompare(b.departure));
    document.getElementById('flight-list').innerHTML = rows.map(f => `<div class="flight"><strong>${f.airline}</strong><span>Departs ${f.departure}</span><span>${f.stops}</span><strong>€${f.price}</strong></div>`).join('') || '<p>No flights match.</p>';
  }
  document.getElementById('search').addEventListener('click', () => {
    if (!/london/i.test(to.value) || /ontario/i.test(to.value) || !date) {
      document.getElementById('form-error').textContent = 'Choose London and a departure date.';
      return;
    }
    document.getElementById('form-error').textContent = '';
    document.getElementById('selected-date').textContent = date;
    document.getElementById('results').hidden = false;
    draw();
  });
  document.getElementById('nonstop').addEventListener('change', draw);
  document.getElementById('sort').addEventListener('change', draw);
})();
