/* "Request my resume": the visitor leaves their email, the role's country and the position.
   FormSubmit (no account) forwards it to my inbox; I reply with the right resume myself. */
(() => {
  'use strict';
  const form = document.getElementById('resume-form');
  if (!form) return;
  const ENDPOINT = 'https://formsubmit.co/ajax/sudheerkgupta@outlook.com';
  const status = form.querySelector('.rr-status');
  const button = form.querySelector('button[type="submit"]');

  const show = (text, tone) => { status.textContent = text; status.dataset.tone = tone || ''; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    if (data._honey) return;                       // bots fill the hidden field; people don't
    const payload = {
      _subject: `Resume request: ${data.position} · ${data.country}`,
      _template: 'table',
      _captcha: 'false',
      email: data.email,                           // FormSubmit sets this as the reply-to address
      // an automatic confirmation to the requester, so they know when to expect it
      _autoresponse: `Hi,

Thanks for requesting my resume for the ${data.position} role (${data.country}). `
        + `I'll send it to this address, usually within 15 to 60 minutes.

`
        + `Meanwhile, my portfolio is at https://iamsrkg.github.io/portfolio/

Best regards,
Sudheer Kumar Gupta`,
      country: data.country,
      position: data.position,
      company: data.company || '(not given)',
      note: data.note || '(none)',
      page: location.href,
    };
    button.disabled = true;
    show('Sending…');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || String(body.success) !== 'true') throw new Error(body.message || `HTTP ${res.status}`);
      form.reset();
      show(`Thanks! I'll email my resume to ${data.email}, usually within 15–60 minutes. A confirmation is on its way to your inbox.`, 'ok');
    } catch (err) {
      const mail = `mailto:sudheerkgupta@outlook.com?subject=${encodeURIComponent(`Resume request: ${data.position} · ${data.country}`)}`
        + `&body=${encodeURIComponent(`Hi Sudheer,\n\nPlease send your resume for: ${data.position} (${data.country}).\n\n${data.company ? 'Company: ' + data.company + '\n' : ''}`)}`;
      status.innerHTML = '';
      status.dataset.tone = 'bad';
      status.append('That didn\'t go through. ');
      const a = Object.assign(document.createElement('a'), { href: mail, textContent: 'Send the request by email instead' });
      status.append(a, '.');
    } finally {
      button.disabled = false;
    }
  });
})();
