// Skyline Flights (fixtures/long/flights-live): a live-like flight search, modelled on what broke a real Google
// Flights run (bench/long/README.md, "flights-live"). Shared by the search form (index.html), the city marketing page
// (flights-to-london.html) and the results page (search.html).
//
// What it reproduces: a Departure textbox that is read-only and opens a calendar dialog with "Done"; two unnamed
// arrow buttons (bare SVG icons) flanking it; a date change that lands 1.5 s after the click, with the date in the URL
// (base64 `tfs`, `&tfu=` appended once the results are in); a half-rendered first paint ("Top options", rows with times
// only); "Top flights" / "Other flights" headings and a "departing YYYY-MM-DD" sentence (never "Departing flights");
// "View more flights" with no counts; a visually hidden "Loading results" status that never goes away; rows as
// 12-hour ranges with "+1", "Operated by" and one rail mix, without flight numbers.
(function () {
  'use strict';
  function qaBeacon(ev) { try { fetch('/api/beacon?ev=' + encodeURIComponent(ev)); } catch (e) { /* offline */ } }

  // ------------------------------------------------------------------------------------------------ data
  // One schedule every day: dep minutes, duration minutes, airline, operated by, stops, route, base fare.
  // Index 5 (easyJet) leaves at a slightly different time each day, so each day's cheapest 10:00-12:00 row is unique.
  var SCHEDULE = [
    [370, 100, 'Ryanair', null, 'Nonstop', 'MRS–STN', 58],
    [455, 100, 'easyJet', 'easyJet Europe', 'Nonstop', 'MRS–LGW', 61],
    [500, 105, 'British Airways', null, 'Nonstop', 'MRS–LHR', 74],
    [570, 265, 'Air France, Eurostar', 'Eurostar', '1 stop · CDG, Paris Nord (train)', 'MRS–STP', 96],
    [615, 265, 'Vueling', null, '1 stop · BCN', 'MRS–LGW', 88],
    [640, 100, 'easyJet', 'easyJet Europe', 'Nonstop', 'MRS–LGW', 63],
    [655, 100, 'British Airways', null, 'Nonstop', 'MRS–LHR', 77],
    [685, 340, 'Vueling', 'Iberia Express', '1 stop · MAD', 'MRS–LGW', 112],
    [710, 280, 'Air France, Eurostar', 'Eurostar', '1 stop · CDG, Paris Nord (train)', 'MRS–STP', 98],
    [725, 100, 'Ryanair', null, 'Nonstop', 'MRS–STN', 57],
    [1120, 100, 'British Airways', null, 'Nonstop', 'MRS–LHR', 79],
    [1305, 685, 'Lufthansa', 'Lufthansa CityLine', '1 stop · FRA', 'MRS–LHR', 131],
  ];
  var WEEK = {
    '2026-10-12': { early: 645, prices: [44, 52, 96, 118, 79, 74, 121, 88, 131, 48, 110, 142] },
    '2026-10-13': { early: 630, prices: [41, 63, 92, 124, 83, 71, 118, 92, 126, 45, 104, 139] },
    '2026-10-14': { early: 650, prices: [47, 58, 99, 119, 77, 66, 125, 81, 128, 53, 99, 145] },
    '2026-10-15': { early: 640, prices: [43, 55, 101, 122, 84, 58, 119, 86, 133, 42, 95, 137] },
    '2026-10-16': { early: 635, prices: [46, 60, 97, 121, 80, 67, 123, 89, 129, 52, 97, 141] },
    '2026-10-17': { early: 625, prices: [34, 51, 89, 117, 76, 72, 115, 82, 124, 47, 93, 138] },
    '2026-10-18': { early: 620, prices: [49, 45, 93, 120, 81, 64, 117, 85, 130, 50, 102, 140] },
  };
  // Shown first: three top flights, then six other flights; "View more flights" adds the last three, which hold the
  // 10:20-10:50 easyJet (the cheapest 10:00-12:00 departure every day) and two more 10:00-12:00 itineraries.
  var TOP = [0, 9, 2];
  var OTHER_SHOWN = [1, 10, 3, 11, 4, 6];
  var OTHER_MORE = [5, 7, 8];
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parseIso(value) { var p = value.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  function iso(date) { return date.toISOString().slice(0, 10); }
  function addDays(value, n) { var d = parseIso(value); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function shortDate(value) { var d = parseIso(value); return DAY_NAMES[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function hash(s) { var h = 7; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 9973; return h; }
  function dayOf(value) {
    if (WEEK[value]) return WEEK[value];
    var h = hash(value);
    return { early: 630 + (h % 4) * 5, prices: SCHEDULE.map(function (f, i) { return f[6] + ((h + i * 13) % 23) - 11 + (i === 5 ? 20 : 0); }) };
  }
  function clock(min) {
    var m = ((min % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ap;
  }
  function duration(min) { return Math.floor(min / 60) + ' hr' + (min % 60 ? ' ' + (min % 60) + ' min' : ''); }
  function flights(value) {
    var day = dayOf(value);
    return SCHEDULE.map(function (f, i) {
      var dep = i === 5 ? day.early : f[0];
      return { i: i, dep: dep, arr: dep + f[1], dur: f[1], airline: f[2], op: f[3], stops: f[4], route: f[5], price: day.prices[i], co2: 60 + ((i * 17) % 40) };
    });
  }
  function minPrice(value) { return Math.min.apply(null, dayOf(value).prices); }

  // `tfs`: base64url of a small binary record with the date at a fixed, 3-byte-aligned offset, so "-10-13" always
  // encodes to the same 8 characters ("LTEwLTEz"), as on the live site.
  var TFS_HEAD = '\x08\x1c\x10\x02\x1a\x1e\x12\x0a';
  var TFS_TAIL = '\x6a\x05\x12\x03MRS\x72\x05\x12\x03LON\x40\x01\x48\x01\x70\x01\x98\x01\x02';
  function tfsFor(value) { return btoa(TFS_HEAD + value + TFS_TAIL).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function dateFromTfs(tfs) {
    try {
      var raw = atob(String(tfs).replace(/-/g, '+').replace(/_/g, '/'));
      var m = /\d{4}-\d{2}-\d{2}/.exec(raw);
      return m ? m[0] : null;
    } catch (e) { return null; }
  }
  function resultsUrl(value) { return 'search.html?tfs=' + tfsFor(value) + '&hl=en&curr=EUR'; }

  // ------------------------------------------------------------------------------------------------ widgets
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  /** The calendar dialog: October 2026, each day with its lowest any-time fare; "Done" applies the picked day. */
  function calendar(form, onDone) {
    var dlg = el('<div class="cal" role="dialog" aria-modal="true" aria-label="Departure date" hidden></div>');
    var picked = form.date;
    function draw() {
      var cells = '';
      for (var d = 1; d <= 31; d++) {
        var day = '2026-10-' + (d < 10 ? '0' : '') + d;
        cells += '<button type="button" class="day' + (day === picked ? ' on' : '') + '" data-date="' + day + '" aria-pressed="' + (day === picked) + '">'
          + '<span class="n">' + d + '</span> <span class="p">€' + minPrice(day) + '</span></button>';
      }
      dlg.innerHTML = '<div class="cal-head"><span class="picked">' + (picked ? shortDate(picked) : 'Departure') + '</span>'
        + '<button type="button" class="reset">Reset</button></div><div class="month"><h3>October 2026</h3><div class="grid">' + cells + '</div></div>'
        + '<div class="cal-foot"><span>Lowest fares, any time of day</span><button type="button" class="done">Done</button></div>';
    }
    dlg.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      if (b.classList.contains('day')) { picked = b.dataset.date; draw(); }
      else if (b.classList.contains('reset')) { picked = null; draw(); }
      else if (b.classList.contains('done')) { dlg.hidden = true; if (picked) onDone(picked); }
    });
    return { node: dlg, open: function () { if (!dlg.hidden) return; picked = form.date; draw(); dlg.hidden = false; } };
  }

  /** Where to? combobox with an autocomplete list; picking a suggestion (or typing a London name) sets it. */
  function destination(input, form) {
    var list = el('<div class="suggest" role="listbox" id="to-list" aria-label="Destinations" hidden></div>');
    input.setAttribute('aria-controls', 'to-list');
    input.setAttribute('aria-expanded', 'false');
    input.insertAdjacentElement('afterend', list);
    var PLACES = ['London, United Kingdom', 'London Heathrow (LHR)', 'London Gatwick (LGW)', 'London, Ontario, Canada'];
    function show() {
      var q = input.value.trim().toLowerCase();
      var hits = q.length < 2 ? [] : PLACES.filter(function (p) { return p.toLowerCase().indexOf(q) >= 0; });
      list.innerHTML = hits.map(function (p) { return '<div role="option" tabindex="-1" aria-selected="false">' + p + '</div>'; }).join('');
      list.hidden = !hits.length;
      input.setAttribute('aria-expanded', String(!list.hidden));
      form.to = /london/i.test(input.value) && !/ontario/i.test(input.value) ? 'London' : null;
    }
    input.addEventListener('input', show);
    list.addEventListener('click', function (ev) {
      var o = ev.target.closest('[role="option"]');
      if (!o) return;
      input.value = o.textContent;
      form.to = /ontario/i.test(o.textContent) ? null : 'London';
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    });
  }

  // ------------------------------------------------------------------------------------------------ search forms
  /** A search form (index.html, flights-to-london.html): Search opens the calendar until a date is picked. */
  function searchForm(root) {
    var form = { to: root.dataset.to || null, date: null };
    var to = root.querySelector('.to');
    if (to) destination(to, form);
    var dep = root.querySelector('.dep');
    var cal = calendar(form, function (day) { form.date = day; dep.value = shortDate(day); });
    root.appendChild(cal.node);
    dep.addEventListener('click', cal.open);
    var err = root.querySelector('.err');
    root.querySelector('.search').addEventListener('click', function () {
      if (!form.to) { err.textContent = 'Enter a destination'; return; }
      if (!form.date) { cal.open(); return; }
      location.href = resultsUrl(form.date);
    });
  }

  // ------------------------------------------------------------------------------------------------ results page
  function row(f) {
    var plus = Math.floor(f.arr / 1440) > 0 ? '<sup class="plus">+1</sup>' : '';
    return '<li class="row"><div class="times"><span>' + clock(f.dep) + '</span> – <span>' + clock(f.arr) + '</span>' + plus + '</div>'
      + '<div class="air"><span>' + f.airline + '</span>' + (f.op ? '<span class="op">Operated by ' + f.op + '</span>' : '') + '</div>'
      + '<div class="dur">' + duration(f.dur) + '<span class="route">' + f.route + '</span></div>'
      + '<div class="stops">' + f.stops + '</div><div class="co2">' + f.co2 + ' kg CO2e</div><div class="price">€' + f.price + '</div></li>';
  }

  function results() {
    var params = new URLSearchParams(location.search);
    var state = { date: dateFromTfs(params.get('tfs')) || '2026-10-12', expanded: false, timer: null, form: { to: 'London', date: null } };
    var dep = document.getElementById('dep');
    var main = document.getElementById('results');
    var cal = calendar(state.form, function (day) { change(day); });
    document.getElementById('dep-wrap').appendChild(cal.node);
    dep.addEventListener('click', function () { state.form.date = state.date; cal.open(); });
    document.getElementById('prev').addEventListener('click', function () { change(addDays(state.date, -1)); });
    document.getElementById('next').addEventListener('click', function () { change(addDays(state.date, 1)); });

    function half() {
      // The first paint while results stream in: "Top options" and times only.
      var list = flights(state.date);
      main.innerHTML = '<h3>Top options</h3>' + TOP.map(function (i) {
        return '<p class="partial">' + clock(list[i].dep) + ' – ' + clock(list[i].arr) + '</p>';
      }).join('');
    }
    function full() {
      var list = flights(state.date);
      var other = OTHER_SHOWN.concat(state.expanded ? OTHER_MORE : []);
      main.innerHTML = '<p class="track">Track prices for Marseille to London, one way, departing ' + state.date
        + ' <button type="button" role="switch" aria-checked="false" id="track" aria-label="Track prices">'
        + '<span class="knob"></span></button></p>'
        + '<h3>Top flights</h3><p class="sub">Ranked based on price and convenience. Prices include required taxes + fees for 1 adult.</p>'
        + '<ul class="flights">' + TOP.map(function (i) { return row(list[i]); }).join('') + '</ul>'
        + '<h3>Other flights</h3><ul class="flights">' + other.map(function (i) { return row(list[i]); }).join('') + '</ul>'
        + (state.expanded ? '<p><button type="button" id="less">Hide flights</button></p>'
          : '<p><button type="button" id="more" class="more">View more flights</button></p>');
      var more = document.getElementById('more');
      if (more) more.addEventListener('click', function () { state.expanded = true; full(); });
      var less = document.getElementById('less');
      if (less) less.addEventListener('click', function () { state.expanded = false; full(); });
      var tr = document.getElementById('track');
      tr.addEventListener('click', function () { tr.setAttribute('aria-checked', String(tr.getAttribute('aria-checked') !== 'true')); qaBeacon('track-prices'); });
    }
    function paint(date, push) {
      state.date = date;
      state.expanded = false;
      dep.value = shortDate(date);
      if (push) history.pushState({ date: date }, '', resultsUrl(date));
      half();
      state.timer = setTimeout(function () {
        full();
        // Like the live site: a `tfu` parameter is added once the results are in.
        history.replaceState({ date: date }, '', resultsUrl(date) + '&tfu=EgYIABAAGAA');
      }, 600);
    }
    function change(date) {
      // The date change lands 1.5 s after the click (the click itself settles quietly: nothing changes at first).
      clearTimeout(state.timer);
      state.timer = setTimeout(function () { paint(date, true); }, 1500);
    }
    window.addEventListener('popstate', function () { paint(dateFromTfs(new URLSearchParams(location.search).get('tfs')) || state.date, false); });
    function toggleDialog(btn, id) {
      var d = document.getElementById(id);
      d.hidden = !d.hidden;
      btn.setAttribute('aria-expanded', String(!d.hidden));
      if (!d.hidden && id === 'grid') {
        var cells = '';
        for (var n = -3; n <= 3; n++) { var day = addDays(state.date, n); cells += '<tr><th>' + shortDate(day) + '</th><td>€' + minPrice(day) + '</td></tr>'; }
        d.querySelector('tbody').innerHTML = cells;
      }
    }
    var gb = document.getElementById('grid-btn'), pb = document.getElementById('graph-btn');
    gb.addEventListener('click', function () { toggleDialog(gb, 'grid'); });
    pb.addEventListener('click', function () { toggleDialog(pb, 'graph'); });
    Array.prototype.forEach.call(document.querySelectorAll('.close'), function (b) {
      b.addEventListener('click', function () { var d = b.closest('[role="dialog"]'); d.hidden = true; });
    });
    paint(state.date, false);
  }

  window.Skyline = { flights: flights, clock: clock, tfsFor: tfsFor, dateFromTfs: dateFromTfs, week: Object.keys(WEEK) };
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-search-form]'), searchForm);
    if (document.getElementById('results')) results();
  });
})();
