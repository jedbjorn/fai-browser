(function () {
  'use strict';

  var doc = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var themeButton = document.getElementById('theme');

  function isDark() {
    var selected = doc.getAttribute('data-theme');
    return selected ? selected === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
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

  var figure = document.getElementById('task-benchmark');
  var chart = document.getElementById('benchmark-chart');
  if (!figure || !chart) return;

  var svgNS = 'http://www.w3.org/2000/svg';
  var requiredMetrics = ['passes', 'calls', 'artifacts', 'tokens'];
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

  function validateData(data) {
    if (!data || data.schemaVersion !== 1 || data.status !== 'complete') return null;
    if (!data.run || !Number.isInteger(data.run.taskCount) || data.run.taskCount < 1) return null;
    if (!Array.isArray(data.metrics) || data.metrics.length !== requiredMetrics.length) return null;
    var byId = {};
    data.metrics.forEach(function (metric) {
      if (!metric || typeof metric.id !== 'string') return;
      byId[metric.id] = metric;
    });
    var ordered = requiredMetrics.map(function (id) { return byId[id]; });
    var valid = ordered.every(function (metric, index) {
      if (!metric || typeof metric.label !== 'string' || !validPoint(metric.a) || !validPoint(metric.b)) return false;
      if (index === 0) {
        return metric.a.value <= data.run.taskCount && metric.b.value <= data.run.taskCount;
      }
      return Number.isInteger(metric.matchedTasks) && metric.matchedTasks > 0 && metric.matchedTasks <= data.run.taskCount;
    });
    return valid ? { data: data, metrics: ordered } : null;
  }

  function displayValue(metric, point, taskCount) {
    if (typeof point.display === 'string' && point.display.trim()) return point.display;
    if (metric.id === 'passes') return numberFormat.format(point.value) + ' / ' + taskCount;
    var suffix = metric.unit ? ' ' + metric.unit : '';
    return numberFormat.format(point.value) + suffix;
  }

  function basisFor(metric, taskCount) {
    if (metric.id === 'passes') return taskCount + ' tasks total';
    var aggregation = typeof metric.aggregation === 'string' && metric.aggregation ? metric.aggregation.charAt(0).toUpperCase() + metric.aggregation.slice(1) : 'Measured';
    return aggregation + ' · ' + metric.matchedTasks + ' matched successes';
  }

  function scaleFor(metric, taskCount) {
    var maximum = Math.max(metric.a.value, metric.b.value);
    if (metric.id === 'passes') return taskCount;
    if (finiteNumber(metric.scaleMax) && metric.scaleMax >= maximum && metric.scaleMax > 0) return metric.scaleMax;
    return maximum > 0 ? maximum : 1;
  }

  function scaleLabel(metric, scale) {
    if (metric.id === 'passes') return 'Shared max · ' + numberFormat.format(scale) + ' tasks';
    return 'Shared max · ' + numberFormat.format(scale) + (metric.unit ? ' ' + metric.unit : '');
  }

  function setStatus(text) {
    var status = document.getElementById('benchmark-status');
    var dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    status.replaceChildren(dot, document.createTextNode(text));
  }

  function renderTable(result) {
    var body = document.getElementById('benchmark-table-body');
    var taskCount = result.data.run.taskCount;
    body.replaceChildren();
    result.metrics.forEach(function (metric) {
      var row = document.createElement('tr');
      var heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = metric.label;
      row.appendChild(heading);
      [metric.a, metric.b].forEach(function (point) {
        var cell = document.createElement('td');
        cell.textContent = displayValue(metric, point, taskCount);
        row.appendChild(cell);
      });
      var basis = document.createElement('td');
      basis.textContent = basisFor(metric, taskCount);
      row.appendChild(basis);
      body.appendChild(row);
    });
    var caption = document.getElementById('benchmark-table-caption');
    var source = result.data.run.source ? ' Source: ' + result.data.run.source + '.' : '';
    caption.textContent = 'Measured values only. Each metric uses the aggregation shown in the basis column.' + source;
  }

  function animateBars() {
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

  function observeBars() {
    if (reduce.matches || !('IntersectionObserver' in window)) {
      animateBars();
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        animateBars();
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(figure);
  }

  function renderComplete(result) {
    var data = result.data;
    var metrics = result.metrics;
    var taskCount = data.run.taskCount;
    var chartHeight = 54 + metrics.length * 114;
    var gridDepth = chartHeight - 70;
    var protocol = data.run.protocol || 'Native agents via MCP relay';
    figure.dataset.state = 'complete';
    setStatus('Measured results');
    document.getElementById('benchmark-run').textContent = (data.run.model || 'Measured model') + ' · ' + protocol + ' · ' + taskCount + ' tasks · ' + (data.run.repeats || 1) + ' repeat' + (data.run.repeats === 1 ? '' : 's') + ' · local fixtures';

    chart.replaceChildren();
    chart.setAttribute('viewBox', '0 0 960 ' + chartHeight);
    chart.appendChild(svgElement('title', { id: 'benchmark-svg-title' }, 'FAI Agent direct compared with Playwright MCP'));
    var description = metrics.map(function (metric) {
      return metric.label + ': Playwright MCP ' + displayValue(metric, metric.a, taskCount) + ', FAI Agent direct ' + displayValue(metric, metric.b, taskCount) + '.';
    }).join(' ');
    chart.appendChild(svgElement('desc', { id: 'benchmark-svg-desc' }, description + ' Each pair uses a common zero baseline and shared scale.'));
    chart.appendChild(svgElement('path', { class: 'chart-grid', d: 'M270 30v' + gridDepth + 'M400 30v' + gridDepth + 'M530 30v' + gridDepth + 'M660 30v' + gridDepth + 'M790 30v' + gridDepth, 'aria-hidden': 'true' }));

    metrics.forEach(function (metric, index) {
      var scale = scaleFor(metric, taskCount);
      var group = svgElement('g', { transform: 'translate(0 ' + (38 + index * 114) + ')' });
      group.appendChild(svgElement('text', { class: 'metric-name', x: 0, y: 25 }, metric.label));
      group.appendChild(svgElement('text', { class: 'metric-note', x: 0, y: 47 }, metric.id === 'passes' ? 'out of ' + taskCount + ' tasks' : basisFor(metric, taskCount)));
      group.appendChild(svgElement('line', { class: 'chart-zero', x1: 270, y1: 5, x2: 270, y2: 72, 'aria-hidden': 'true' }));

      [['a', 20, 'chart-bar-a'], ['b', 58, 'chart-bar-b']].forEach(function (series) {
        var key = series[0];
        var y = series[1];
        var point = metric[key];
        var width = point.value / scale * 520;
        group.appendChild(svgElement('text', { class: 'series-name', x: 222, y: y + 5 }, key.toUpperCase()));
        group.appendChild(svgElement('rect', { class: 'chart-track', x: 270, y: y - 8, width: 520, height: 16, rx: 3, 'aria-hidden': 'true' }));
        group.appendChild(svgElement('rect', { class: 'chart-bar ' + series[2], x: 270, y: y - 8, width: 0, height: 16, rx: 3, 'data-width': width.toFixed(2), 'aria-hidden': 'true' }));
        group.appendChild(svgElement('text', { class: 'chart-value', x: 820, y: y + 5 }, displayValue(metric, point, taskCount)));
      });
      group.appendChild(svgElement('text', { class: 'chart-scale', x: 270, y: 94 }, '0'));
      group.appendChild(svgElement('text', { class: 'chart-scale', x: 790, y: 94, 'text-anchor': 'end' }, scaleLabel(metric, scale)));
      chart.appendChild(group);
    });

    var caption = figure.querySelector('figcaption');
    caption.querySelector('span').textContent = data.label || 'Experimental · one repeat · local fixture evidence';
    var source = data.run.source ? ' Source: ' + data.run.source + '.' : '';
    var measuredAt = data.run.measuredAt ? ' Measured ' + data.run.measuredAt + '.' : '';
    caption.querySelector('p').textContent = 'Measured values only. MCP calls, snapshot artifact reads and observed text tokens use matched successful tasks; each pair shares a zero baseline and scale.' + measuredAt + source;
    renderTable(result);
    observeBars();
  }

  function renderPending(data) {
    figure.dataset.state = 'pending';
    setStatus('Benchmark in progress');
    if (data && data.run) {
      var run = data.run;
      document.getElementById('benchmark-run').textContent = (run.model || 'Sol 6.1 medium') + ' · ' + (run.protocol || 'Native agents via MCP relay') + ' · ' + (run.taskCount || 6) + ' tasks · ' + (run.repeats || 1) + ' repeat · local fixtures';
    }
  }

  fetch('media/benchmark-data.json', { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('Benchmark data unavailable');
      return response.json();
    })
    .then(function (data) {
      var result = validateData(data);
      if (result) renderComplete(result);
      else renderPending(data);
    })
    .catch(function () { if (figure.dataset.state !== 'complete') renderPending(null); });
})();
