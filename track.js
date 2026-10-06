/* Which buttons get used. Sent to GoatCounter as events: no cookies, nothing about the person, only the name of the action. */
(() => {
  'use strict';
  const sent = new Set();
  function event(name, once) {
    if (once && sent.has(name)) return;
    sent.add(name);
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true });
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('a, button');
    if (!el) return;
    const href = el.getAttribute('href') || '';
    if (el.matches('.fab-resume') || href === '#resume-form') return event('resume-form-opened');
    if (el.matches('.fab-contact')) return event('contact-menu-opened');
    if (el.matches('.mesh-hud button')) return event('background-explained', true);
    if (el.matches('[data-scenario]')) return event('live-api-used', true);
    if (el.closest('#pg-form') && el.matches('button')) return event('live-api-used', true);
    if (href.startsWith('mailto:')) return event('contact-email');
    if (href.includes('linkedin.com')) return event('contact-linkedin');
    if (href.includes('line.me')) return event('contact-line');
    if (href.includes('codespaces.new')) return event('run-real-api');
    if (href.includes('credly.com')) return event('aws-certificate');
    const repo = href.match(/github\.com\/iamsrkg\/?([\w.-]*)/);
    if (repo) return event('github-' + (repo[1] || 'profile'));
    if (/iamsrkg\.github\.io\/(tic-tac-toe|Video-Based)/.test(href)) return event('demo-' + (href.includes('tic-tac-toe') ? 'tic-tac-toe' : 'video-auth'));
  }, true);

  // a resume request that went through
  const status = document.querySelector('#resume-form .rr-status');
  if (status) new MutationObserver(() => { if (status.dataset.tone === 'ok') event('resume-request-sent'); }).observe(status, { attributes: true, attributeFilter: ['data-tone'] });
})();
