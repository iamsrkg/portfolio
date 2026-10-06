/* For visitors whose clock is set to Thailand: a short hello and the resume form pre-set to Thailand.
   It goes by the device's time zone, so nothing is looked up and no address is used.
   Everyone else sees the page unchanged. */
(() => {
  'use strict';
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  if (zone !== 'Asia/Bangkok') return;

  const lede = document.querySelector('.opening-lede');
  if (lede) {
    const hello = document.createElement('p');
    hello.className = 'thai-hello';
    hello.innerHTML = '<b lang="th">สวัสดีครับ</b> Hello to Thailand. I\'m a Thai citizen who built his career in India, and I\'d like to bring it to Bangkok. '
      + 'I need no visa or work permit, and I\'m only 1.5 hours behind you, so interviews in your working day are easy.';
    lede.after(hello);
  }
  const country = document.querySelector('#resume-form select[name="country"]');
  if (country && !country.value) country.value = 'Thailand';

  // counted with the other anonymous page statistics, once per visit
  window.addEventListener('load', () => setTimeout(() => {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'visitor-on-thailand-time', title: 'visitor-on-thailand-time', event: true });
  }, 1500));
})();
