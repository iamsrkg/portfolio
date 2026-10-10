/* For visitors whose clock is set to Thailand, or whose browser is in Thai: a short hello and the resume form pre-set to Thailand.
   It goes by the device's own settings, so nothing is looked up and no address is used.
   Everyone else sees the page unchanged. A link ending in ?th shows it from anywhere, for sending to a recruiter directly. */
(() => {
  'use strict';
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  const query = new URLSearchParams(location.search);
  const preview = query.has('th') || query.get('preview') === 'thailand';   // a link ending in ?th always shows it
  const thaiBrowser = (navigator.languages || [navigator.language || '']).some((l) => /^th(-|$)/i.test(l));   // a Thai-language browser, wherever it is
  if (zone !== 'Asia/Bangkok' && !thaiBrowser && !preview) return;

  const lede = document.querySelector('.opening-lede');
  if (lede) {
    const hello = document.createElement('p');
    hello.className = 'thai-hello';
    hello.innerHTML = '<b lang="th">สวัสดีครับ</b> Hello to Thailand. '
      + "I'm a Thai citizen with family in Thailand. I built my career in India, and now I'm moving to Bangkok to settle down for the long term. "
      + "I need no visa, work permit or sponsorship, and I'm ready to relocate. "
      + "Until then I'm only 1.5 hours behind you, so interviews in your working day are easy. "
      + "If your team is hiring Java backend engineers in Thailand, I'd be glad to talk.";
    lede.after(hello);
  }
  const country = document.querySelector('#resume-form select[name="country"]');
  if (country && !country.value) country.value = 'Thailand';

  // counted with the other anonymous page statistics, once per visit
  if (zone === 'Asia/Bangkok' || thaiBrowser) window.addEventListener('load', () => setTimeout(() => {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'visitor-on-thailand-time', title: 'visitor-on-thailand-time', event: true });
  }, 1500));
})();
