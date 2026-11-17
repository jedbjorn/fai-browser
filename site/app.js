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

  document.querySelectorAll('[data-metric]').forEach(function (button) {
    button.addEventListener('click', function () {
      var metric = button.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach(function (item) {
        item.setAttribute('aria-pressed', String(item === button));
      });
      document.querySelectorAll('[data-chart-metric]').forEach(function (chart) {
        chart.hidden = chart.dataset.chartMetric !== metric;
      });
    });
  });
})();
