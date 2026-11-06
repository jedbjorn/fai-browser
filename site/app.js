(function () {
  'use strict';

  var doc = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var themeButton = document.getElementById('theme');

  function isDark() {
    var selected = doc.getAttribute('data-theme');
    return selected ? selected === 'dark' : false;
  }

  function syncTheme() {
    if (themeButton) themeButton.setAttribute('aria-pressed', String(isDark()));
  }

  if (themeButton) {
    themeButton.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      doc.setAttribute('data-theme', next);
      try { localStorage.setItem('fai-theme', next); } catch (e) {}
      syncTheme();
    });
    syncTheme();
  }

  var menuButton = document.getElementById('menu-button');
  var primaryNav = document.getElementById('primary-nav');

  function closeMenu(returnFocus) {
    if (!menuButton || !primaryNav) return;
    primaryNav.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
    if (returnFocus) menuButton.focus();
  }

  if (menuButton && primaryNav) {
    menuButton.addEventListener('click', function () {
      var open = menuButton.getAttribute('aria-expanded') !== 'true';
      menuButton.setAttribute('aria-expanded', String(open));
      primaryNav.classList.toggle('open', open);
    });
    primaryNav.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeMenu(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && primaryNav.classList.contains('open')) closeMenu(true);
    });
    document.addEventListener('click', function (event) {
      if (primaryNav.classList.contains('open') && !event.target.closest('.header-inner')) closeMenu(false);
    });
  }

  var revealItems = document.querySelectorAll('.reveal');
  if (reduce.matches || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(revealItems, function (item) { item.classList.add('in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px' });
    Array.prototype.forEach.call(revealItems, function (item) { revealObserver.observe(item); });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.copy-button'), function (button) {
    button.addEventListener('click', function () {
      var label = button.querySelector('span');
      var original = label.textContent;
      var done = function () {
        label.textContent = 'Copied';
        window.setTimeout(function () { label.textContent = original; }, 1600);
      };
      var text = button.getAttribute('data-copy') || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { label.textContent = 'Copy failed'; });
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (e) { label.textContent = 'Copy failed'; }
        document.body.removeChild(area);
      }
    });
  });

  var svgNS = 'http://www.w3.org/2000/svg';
  var numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

  function svgElement(name, attributes, text) {
    var element = document.createElementNS(svgNS, name);
    Object.keys(attributes || {}).forEach(function (key) { element.setAttribute(key, attributes[key]); });
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function validPoint(point) {
    return point && finiteNumber(point.value) && (point.display === undefined || typeof point.display === 'string');
  }

  function animateBars(chart, figure) {
    if (chart.dataset.animated === 'true') return;
    chart.dataset.animated = 'true';
    var bars = Array.prototype.slice.call(chart.querySelectorAll('.chart-bar'));
    if (reduce.matches) {
      bars.forEach(function (bar) { bar.setAttribute('width', bar.dataset.width); });
      return;
    }
    var started = null;
    var duration = 950;
    function frame(now) {
      if (started === null) started = now;
      var elapsed = now - started;
      bars.forEach(function (bar, index) {
        var delay = Math.floor(index / 2) * 75;
        var progress = Math.max(0, Math.min(1, (elapsed - delay) / duration));
        var eased = 1 - Math.pow(1 - progress, 3);
        bar.setAttribute('width', (Number(bar.dataset.width) * eased).toFixed(2));
      });
      if (elapsed < duration + 225 && !reduce.matches) window.requestAnimationFrame(frame);
      else bars.forEach(function (bar) { bar.setAttribute('width', bar.dataset.width); });
    }
    window.requestAnimationFrame(frame);
  }

  function observeBars(chart, figure) {
    if (reduce.matches || !('IntersectionObserver' in window)) {
      animateBars(chart, figure);
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        animateBars(chart, figure);
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(figure);
  }

  // ---------------------------------------------------------------------------
  // Paired A/B chart (schemaVersion 2, kind "paired"): one bar pair per metric.
  // ---------------------------------------------------------------------------

  var PAIRED_METRICS = ['passes', 'wall', 'tokens', 'cost'];

  function validatePaired(data) {
    if (!data || data.schemaVersion !== 2 || data.kind !== 'paired' || data.status !== 'complete') return null;
    if (!data.run || !Number.isInteger(data.run.taskCount) || data.run.taskCount < 1) return null;
    if (!data.series || typeof data.series.a !== 'string' || typeof data.series.b !== 'string') return null;
    if (!Array.isArray(data.metrics)) return null;
    var byId = {};
    data.metrics.forEach(function (metric) {
      if (metric && typeof metric.id === 'string') byId[metric.id] = metric;
    });
    var ordered = PAIRED_METRICS.map(function (id) { return byId[id]; });
    var valid = ordered.every(function (metric, index) {
      if (!metric || typeof metric.label !== 'string' || !validPoint(metric.a) || !validPoint(metric.b)) return false;
      if (index === 0) {
        var attempted = Number.isInteger(data.run.attempted) && data.run.attempted > 0 ? data.run.attempted : data.run.taskCount;
        return metric.a.value <= attempted && metric.b.value <= attempted;
      }
      return true;
    });
    return valid ? { data: data, metrics: ordered } : null;
  }

  function pairedDisplay(metric, point) {
    if (typeof point.display === 'string' && point.display.trim()) return point.display;
    if (metric.id === 'passes') return numberFormat.format(point.value);
    return numberFormat.format(point.value) + (metric.unit ? ' ' + metric.unit : '');
  }

  function pairedScale(metric, taskCount, attempted) {
    var maximum = Math.max(metric.a.value, metric.b.value);
    if (metric.id === 'passes') return attempted || taskCount;
    return maximum > 0 ? maximum : 1;
  }

  function pairedScaleLabel(metric, scale, taskCount) {
    if (metric.id === 'passes') return 'Shared max · ' + numberFormat.format(scale) + ' tasks';
    if (metric.unit === 'USD') return 'Shared max · $' + scale;
    var unit = metric.unit === 's' ? ' s' : ' ' + (metric.unit || '');
    return 'Shared max · ' + numberFormat.format(scale) + unit;
  }

  function renderPaired(result, elements) {
    var data = result.data;
    var metrics = result.metrics;
    var taskCount = data.run.taskCount;
    var chart = elements.chart;
    var chartHeight = 54 + metrics.length * 114;
    var gridDepth = chartHeight - 70;
    elements.figure.dataset.state = 'complete';
    setStatus(elements.status, 'Measured results');
    document.getElementById(elements.run).textContent = (data.run.model || 'Measured model') + ' · ' + (data.run.driver || '') + ' · ' + (data.run.protocol || '') + ' · ' + taskCount + ' tasks · ' + (data.run.repeats || 1) + ' repeat' + (data.run.repeats === 1 ? '' : 's') + ' · local fixtures';

    chart.replaceChildren();
    chart.setAttribute('viewBox', '0 0 960 ' + chartHeight);
    chart.appendChild(svgElement('title', { id: elements.chartId + '-svg-title' }, data.series.b + ' compared with ' + data.series.a));
    var description = metrics.map(function (metric) {
      return metric.label + ': ' + data.series.a + ' ' + pairedDisplay(metric, metric.a) + ', ' + data.series.b + ' ' + pairedDisplay(metric, metric.b) + '.';
    }).join(' ');
    chart.appendChild(svgElement('desc', { id: elements.chartId + '-svg-desc' }, description + ' Each pair uses a common zero baseline and shared scale.'));
    chart.appendChild(svgElement('path', { class: 'chart-grid', d: 'M270 30v' + gridDepth + 'M400 30v' + gridDepth + 'M530 30v' + gridDepth + 'M660 30v' + gridDepth + 'M790 30v' + gridDepth, 'aria-hidden': 'true' }));

    metrics.forEach(function (metric, index) {
      var scale = pairedScale(metric, taskCount, data.run.attempted);
      var group = svgElement('g', { transform: 'translate(0 ' + (38 + index * 114) + ')' });
      group.appendChild(svgElement('text', { class: 'metric-name', x: 0, y: 25 }, metric.label));
      group.appendChild(svgElement('text', { class: 'metric-note', x: 0, y: 47 }, metric.id === 'passes' ? 'out of ' + (data.run.attempted || taskCount) + ' runs' : 'per task · suite of per-task medians · ' + (data.run.repeats || 1) + ' repeats'));
      group.appendChild(svgElement('line', { class: 'chart-zero', x1: 270, y1: 5, x2: 270, y2: 72, 'aria-hidden': 'true' }));

      [['a', 20, 'chart-bar-a', data.series.a], ['b', 58, 'chart-bar-b', data.series.b]].forEach(function (series) {
        var key = series[0];
        var y = series[1];
        var point = metric[key];
        var width = point.value / scale * 520;
        group.appendChild(svgElement('text', { class: 'series-name', x: 222, y: y + 5 }, key.toUpperCase()));
        group.appendChild(svgElement('rect', { class: 'chart-track', x: 270, y: y - 8, width: 520, height: 16, rx: 3, 'aria-hidden': 'true' }));
        group.appendChild(svgElement('rect', { class: 'chart-bar ' + series[2], x: 270, y: y - 8, width: 0, height: 16, rx: 3, 'data-width': width.toFixed(2), 'aria-hidden': 'true' }));
        group.appendChild(svgElement('text', { class: 'chart-value', x: 820, y: y + 5 }, pairedDisplay(metric, point)));
      });
      group.appendChild(svgElement('text', { class: 'chart-scale', x: 270, y: 94 }, '0'));
      group.appendChild(svgElement('text', { class: 'chart-scale', x: 790, y: 94, 'text-anchor': 'end' }, pairedScaleLabel(metric, scale, taskCount)));
      chart.appendChild(group);
    });

    var caption = elements.figure.querySelector('figcaption');
    caption.querySelector('span').textContent = data.label || 'Measured local fixture evidence';
    var source = data.run.source ? ' Source: ' + data.run.source + '.' : '';
    var measuredAt = data.run.measuredAt ? ' Measured ' + data.run.measuredAt + '.' : '';
    caption.querySelector('p').textContent = 'Measured values only; each pair shares a zero baseline and scale. Per-task figures are suites of per-task medians over repeats.' + measuredAt + source;

    var body = document.getElementById(elements.tableBody);
    body.replaceChildren();
    metrics.forEach(function (metric) {
      var row = document.createElement('tr');
      var heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = metric.label;
      row.appendChild(heading);
      [metric.a, metric.b].forEach(function (point) {
        var cell = document.createElement('td');
        cell.textContent = pairedDisplay(metric, point);
        row.appendChild(cell);
      });
      var basis = document.createElement('td');
      basis.textContent = metric.id === 'passes' ? (data.run.attempted || taskCount) + ' runs total' : 'Per task · medians over ' + (data.run.repeats || 1) + ' repeats each';
      row.appendChild(basis);
      body.appendChild(row);
    });
    var captionEl = document.getElementById(elements.tableCaption);
    captionEl.textContent = 'Measured values only. Per-task figures are suites of per-task medians over repeats.' + source;

    observeBars(chart, elements.figure);
  }

  // ---------------------------------------------------------------------------
  // Ratio chart (schemaVersion 2, kind "ratio"): one bar per host per metric,
  // value = how many times better than baseline; parity line at 1×.
  // ---------------------------------------------------------------------------

  var RATIO_METRICS = ['wall', 'tokens', 'cost'];

  function validateRatio(data) {
    if (!data || data.schemaVersion !== 2 || data.kind !== 'ratio' || data.status !== 'complete') return null;
    if (!data.series || typeof data.series.a !== 'string' || typeof data.series.b !== 'string') return null;
    if (!Array.isArray(data.metrics)) return null;
    var byId = {};
    data.metrics.forEach(function (metric) {
      if (metric && typeof metric.id === 'string') byId[metric.id] = metric;
    });
    var ordered = RATIO_METRICS.map(function (id) { return byId[id]; });
    var valid = ordered.every(function (metric) {
      return metric && typeof metric.label === 'string' &&
        Array.isArray(metric.hosts) && metric.hosts.length > 0 &&
        metric.hosts.every(function (host) { return host && typeof host.name === 'string' && validPoint(host); });
    });
    return valid ? { data: data, metrics: ordered } : null;
  }

  function renderRatio(result, elements) {
    var data = result.data;
    var metrics = result.metrics;
    var hostCount = metrics[0].hosts.length;
    var chart = elements.chart;
    var rowH = 40;
    var chartHeight = 70 + metrics.length * (34 + hostCount * rowH + 20);
    elements.figure.dataset.state = 'complete';
    setStatus(elements.status, 'Measured results');
    document.getElementById(elements.run).textContent = (data.run.model || 'Measured models') + ' · ' + (data.run.driver || '') + ' · ' + data.run.taskCount + ' tasks · ' + (data.run.repeats || 1) + ' repeats · local fixtures';

    var max = 0;
    metrics.forEach(function (metric) {
      metric.hosts.forEach(function (host) { if (host.value > max) max = host.value; });
    });
    max = max * 1.12 || 1;
    var x = function (v) { return 270 + (v / max) * 520; };

    chart.replaceChildren();
    chart.setAttribute('viewBox', '0 0 960 ' + chartHeight);
    chart.appendChild(svgElement('title', { id: 'jev-svg-title' }, data.series.b + ' compared with ' + data.series.a + ' across ' + hostCount + ' host models'));
    chart.appendChild(svgElement('desc', { id: 'jev-svg-desc' }, metrics.map(function (metric) {
      return metric.label + ': ' + metric.hosts.map(function (host) { return host.name + ' ' + host.display; }).join(', ');
    }).join('. ') + '. Bars pass the 1× parity line when FAI is better.'));

    var y = 30;
    metrics.forEach(function (metric) {
      chart.appendChild(svgElement('text', { class: 'metric-name', x: 0, y: y + 16 }, metric.label));
      chart.appendChild(svgElement('text', { class: 'metric-note', x: 0, y: y + 36 }, data.series.a + ' ÷ ' + data.series.b + ' · bars past 1× favour FAI'));
      y += 50;
      chart.appendChild(svgElement('line', { class: 'chart-zero', x1: x(1).toFixed(1), y1: y - 8, x2: x(1).toFixed(1), y2: y + hostCount * rowH - 8, 'aria-hidden': 'true' }));
      metric.hosts.forEach(function (host, index) {
        var ry = y + index * rowH;
        var width = host.value / max * 520;
        chart.appendChild(svgElement('text', { class: 'series-name', x: 150, y: ry + 22 }, host.name));
        chart.appendChild(svgElement('rect', { class: 'chart-track', x: 270, y: ry + 6, width: 520, height: 16, rx: 3, 'aria-hidden': 'true' }));
        chart.appendChild(svgElement('rect', { class: 'chart-bar chart-bar-b', x: 270, y: ry + 6, width: 0, height: 16, rx: 3, 'data-width': width.toFixed(2), 'aria-hidden': 'true' }));
        chart.appendChild(svgElement('text', { class: 'chart-value', x: 820, y: ry + 22 }, host.display));
      });
      y += hostCount * rowH + 26;
      chart.appendChild(svgElement('text', { class: 'chart-scale', x: 270, y: y - 12 }, '0'));
      chart.appendChild(svgElement('text', { class: 'chart-scale', x: 790, y: y - 12, 'text-anchor': 'end' }, 'Shared max · ' + max.toFixed(1) + '×'));
    });

    var caption = elements.figure.querySelector('figcaption');
    caption.querySelector('span').textContent = data.label || 'Experimental · local fixture evidence';
    var source = data.run.source ? ' Source: ' + data.run.source + '.' : '';
    var measuredAt = data.run.measuredAt ? ' Measured ' + data.run.measuredAt + '.' : '';
    caption.querySelector('p').textContent = 'Bars show ' + data.series.a + ' ÷ ' + data.series.b + ' per host; a bar past the 1× parity line means FAI is faster or cheaper on that host. Raw model tokens per vendor tokenizer; cost priced from bench/prices.json.' + measuredAt + source;

    var body = document.getElementById(elements.tableBody);
    body.replaceChildren();
    if (Array.isArray(data.hosts)) {
      data.hosts.forEach(function (host) {
        var row = document.createElement('tr');
        var heading = document.createElement('th');
        heading.scope = 'row';
        heading.textContent = host.name;
        row.appendChild(heading);
        [host.wall, host.tokens, host.cost].forEach(function (value) {
          var cell = document.createElement('td');
          cell.textContent = Number.isFinite(value) ? value.toFixed(2) + '×' : '—';
          row.appendChild(cell);
        });
        var pass = document.createElement('td');
        pass.textContent = (host.pass && host.pass.a ? host.pass.a + ' → ' : '') + (host.pass && host.pass.b ? host.pass.b : '—');
        row.appendChild(pass);
        body.appendChild(row);
      });
    }

    observeBars(chart, elements.figure);
  }

  // ---------------------------------------------------------------------------

  function setStatus(statusId, text) {
    var status = document.getElementById(statusId);
    if (!status) return;
    var dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    status.replaceChildren(dot, document.createTextNode(text));
  }

  function setupFigure(config) {
    var figure = document.getElementById(config.figure);
    var chart = document.querySelector(config.chart);
    if (!figure || !chart) return;
    fetch(config.url, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('data unavailable');
        return response.json();
      })
      .then(function (data) {
        var result = config.validate(data);
        // On failure keep the static fallback baked into the HTML.
        if (result) config.render(result, { figure: figure, chart: chart, chartId: config.chart.slice(1), status: config.status, run: config.run, tableBody: config.tableBody, tableCaption: config.tableCaption });
      })
      .catch(function (error) { console.error('benchmark chart fallback:', error); /* static fallback stays */ });
  }

  setupFigure({
    figure: 'task-benchmark', chart: '#benchmark-chart', url: 'media/benchmark-data.json',
    validate: validatePaired, render: renderPaired,
    status: 'benchmark-status', run: 'benchmark-run', tableBody: 'benchmark-table-body', tableCaption: 'benchmark-table-caption',
  });

  setupFigure({
    figure: 'jev-benchmark', chart: '#jev-chart', url: 'media/jev-matrix-data.json',
    validate: validateRatio, render: renderRatio,
    status: 'jev-status', run: 'jev-run', tableBody: 'jev-table-body', tableCaption: 'jev-table-caption',
  });
})();
