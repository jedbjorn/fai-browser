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
        var delay = Math.floor(index / 3) * 75;
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
  // Grouped chart (schemaVersion 3): directly labeled bars for all three drivers.
  // ---------------------------------------------------------------------------

  var GROUPED_METRICS = ['passes', 'wall', 'tokens', 'cost'];
  var GROUPED_SERIES = ['playwright', 'agent', 'jev'];
  var BAR_X = 260;
  var BAR_W = 560;
  var ROW_H = 140;

  function validateGrouped(data) {
    if (!data || data.schemaVersion !== 3 || data.kind !== 'grouped' || data.status !== 'complete') return null;
    if (!data.run || !Number.isInteger(data.run.taskCount) || data.run.taskCount < 1) return null;
    if (!data.series || !GROUPED_SERIES.every(function (name) { return typeof data.series[name] === 'string'; })) return null;
    if (!Array.isArray(data.metrics)) return null;
    var byId = {};
    data.metrics.forEach(function (metric) {
      if (metric && typeof metric.id === 'string') byId[metric.id] = metric;
    });
    var ordered = GROUPED_METRICS.map(function (id) { return byId[id]; });
    var valid = ordered.every(function (metric, index) {
      if (!metric || typeof metric.label !== 'string' || !GROUPED_SERIES.every(function (name) { return validPoint(metric[name]); })) return false;
      if (index !== 0) return true;
      var attempted = Number.isInteger(data.run.attempted) && data.run.attempted > 0 ? data.run.attempted : data.run.taskCount;
      return GROUPED_SERIES.every(function (name) { return metric[name].value <= attempted; });
    });
    return valid ? { data: data, metrics: ordered } : null;
  }

  function groupedDisplay(metric, point) {
    if (typeof point.display === 'string' && point.display.trim()) return point.display;
    if (metric.id === 'passes') return numberFormat.format(point.value);
    return numberFormat.format(point.value) + (metric.unit ? ' ' + metric.unit : '');
  }

  function groupedScaleLabel(metric, scale) {
    if (metric.id === 'passes') return 'Shared max · ' + numberFormat.format(scale) + ' runs';
    if (metric.unit === 'USD') return 'Shared max · $' + scale.toFixed(4);
    return 'Shared max · ' + numberFormat.format(scale) + (metric.unit === 's' ? ' s' : ' ' + metric.unit);
  }

  function renderGrouped(result, elements) {
    var data = result.data;
    var metrics = result.metrics;
    var chart = elements.chart;
    var chartHeight = 44 + metrics.length * ROW_H;
    elements.figure.dataset.state = 'complete';
    setStatus(elements.status, 'Measured results · ' + (data.id === 'visual' ? 'screenshots' : 'text'));
    document.getElementById(elements.run).textContent = (data.run.model || 'Measured model') + ' · ' + data.run.taskCount + ' tasks · ' + (data.run.repeats || 1) + ' repeats · local fixtures';

    chart.replaceChildren();
    chart.setAttribute('viewBox', '0 0 1000 ' + chartHeight);
    chart.appendChild(svgElement('title', { id: 'benchmark-' + data.id + '-svg-title' }, data.title + ': ' + GROUPED_SERIES.map(function (name) { return data.series[name]; }).join(', ')));
    chart.appendChild(svgElement('desc', { id: 'benchmark-' + data.id + '-svg-desc' }, metrics.map(function (metric) {
      return metric.label + ': ' + GROUPED_SERIES.map(function (name) { return data.series[name] + ' ' + groupedDisplay(metric, metric[name]); }).join(', ');
    }).join('. ') + '. Each metric uses a common zero baseline and shared scale.'));
    chart.appendChild(svgElement('path', { class: 'chart-grid', d: 'M' + BAR_X + ' 24v' + (chartHeight - 64) + 'M' + (BAR_X + 140) + ' 24v' + (chartHeight - 64) + 'M' + (BAR_X + 280) + ' 24v' + (chartHeight - 64) + 'M' + (BAR_X + 420) + ' 24v' + (chartHeight - 64) + 'M' + (BAR_X + BAR_W) + ' 24v' + (chartHeight - 64), 'aria-hidden': 'true' }));

    metrics.forEach(function (metric, index) {
      var scale = metric.id === 'passes' ? data.run.attempted : Math.max.apply(null, GROUPED_SERIES.map(function (name) { return metric[name].value; }));
      var group = svgElement('g', { transform: 'translate(0 ' + (28 + index * ROW_H) + ')' });
      group.appendChild(svgElement('text', { class: 'metric-name', x: 0, y: 25 }, metric.label));
      group.appendChild(svgElement('text', { class: 'metric-note', x: 0, y: 47 }, metric.id === 'passes' ? data.run.taskCount + ' tasks · ' + data.run.repeats + ' repeats' : 'per task · mean of task medians'));
      group.appendChild(svgElement('line', { class: 'chart-zero', x1: BAR_X, y1: 4, x2: BAR_X, y2: 103, 'aria-hidden': 'true' }));

      GROUPED_SERIES.forEach(function (name, seriesIndex) {
        var point = metric[name];
        var width = point.value / scale * BAR_W;
        var y = 10 + seriesIndex * 31;
        group.appendChild(svgElement('rect', { class: 'chart-track', x: BAR_X, y: y, width: BAR_W, height: 19, rx: 3, 'aria-hidden': 'true' }));
        group.appendChild(svgElement('rect', { class: 'chart-bar chart-bar-' + name, x: BAR_X, y: y, width: 0, height: 19, rx: 3, 'data-width': width.toFixed(2), 'aria-hidden': 'true' }));
        group.appendChild(svgElement('text', { class: 'chart-bar-label chart-bar-label-' + name, x: BAR_X + 10, y: y + 14 }, data.series[name]));
        group.appendChild(svgElement('text', { class: 'chart-value', x: 850, y: y + 14 }, groupedDisplay(metric, point)));
      });
      group.appendChild(svgElement('text', { class: 'chart-scale', x: BAR_X, y: 124 }, '0'));
      group.appendChild(svgElement('text', { class: 'chart-scale', x: BAR_X + BAR_W, y: 124, 'text-anchor': 'end' }, groupedScaleLabel(metric, scale)));
      chart.appendChild(group);
    });

    var caption = elements.figure.querySelector('figcaption');
    caption.querySelector('span').textContent = data.label || 'Measured local fixture evidence';
    var source = data.run.source ? ' Sources: ' + data.run.source + '.' : '';
    var measuredAt = data.run.measuredAt ? ' Measured ' + data.run.measuredAt + '.' : '';
    caption.querySelector('p').textContent = 'Directly labeled bars; lower time, tokens and cost are better. Raw host tokens only; Jev provider tokens are additional and excluded from host-only cost. Each metric shares a zero baseline and scale.' + measuredAt + source;

    var body = document.getElementById(elements.tableBody);
    body.replaceChildren();
    metrics.forEach(function (metric) {
      var row = document.createElement('tr');
      var heading = document.createElement('th');
      heading.scope = 'row';
      heading.textContent = metric.label;
      row.appendChild(heading);
      GROUPED_SERIES.forEach(function (name) {
        var cell = document.createElement('td');
        cell.textContent = groupedDisplay(metric, metric[name]);
        row.appendChild(cell);
      });
      var basis = document.createElement('td');
      basis.textContent = metric.id === 'passes' ? data.run.taskCount + ' tasks × ' + data.run.repeats + ' repeats' : 'Per task · medians over ' + data.run.repeats + ' repeats';
      row.appendChild(basis);
      body.appendChild(row);
    });
    document.getElementById(elements.tableCaption).textContent = 'Measured values only. Jev provider tokens are additional and excluded from host-only cost.' + source;

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

  ['text', 'visual'].forEach(function (id) {
    setupFigure({
      figure: id + '-benchmark', chart: '#benchmark-' + id + '-chart', url: 'media/benchmark-' + id + '-data.json',
      validate: validateGrouped, render: renderGrouped,
      status: id + '-status', run: id + '-run', tableBody: id + '-table-body', tableCaption: id + '-table-caption',
    });
  });
})();
