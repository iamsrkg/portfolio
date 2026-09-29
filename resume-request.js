/* "Request my resume": the visitor leaves their email, the role's country and the position.
   Web3Forms (no account, just an access key) forwards it to my inbox; I reply with the right resume myself. */
(() => {
  'use strict';
  const form = document.getElementById('resume-form');
  if (!form) return;
  const ENDPOINT = 'https://api.web3forms.com/submit';
  // Public by design: this key can only send messages to my inbox.
  const ACCESS_KEY = 'df5b7021-7887-4bc1-b19b-20d9bdaafe8d';
  const status = form.querySelector('.rr-status');
  const button = form.querySelector('button[type="submit"]');

  const show = (text, tone) => { status.textContent = text; status.dataset.tone = tone || ''; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    if (data._honey) return;                       // bots fill the hidden field; people don't
    const payload = {
      access_key: ACCESS_KEY,
      subject: `Resume request: ${data.position} · ${data.country}`,
      from_name: 'Portfolio: resume request',
      email: data.email,                           // becomes the reply-to, so "Reply" goes to the requester
      country: data.country,
      position: data.position,
      company: data.company || '(not given)',
      note: data.note || '(none)',
      message: `${data.email} is asking for my resume for the "${data.position}" role in ${data.country}`
        + `${data.company ? ` at ${data.company}` : ''}.${data.note ? ` Note: ${data.note}` : ''} Reply to this email to send it.`,
      page: location.href,
      botcheck: '',
    };
    button.disabled = true;
    show('Sending…');
    try {
      // never leave a visitor on "Sending…": give up after 15 s and offer the email route
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 15000);
      const body = new FormData();
      Object.entries(payload).forEach(([k, v]) => body.append(k, v));
      const res = await fetch(ENDPOINT, { method: 'POST', body, signal: timeout.signal })
        .finally(() => clearTimeout(timer));
      const reply = await res.json().catch(() => ({}));
      if (!res.ok || reply.success !== true) throw new Error(reply.message || `HTTP ${res.status}`);
      form.reset();
      show(`Thanks! I'll email my resume to ${data.email}, usually within 15–60 minutes.`, 'ok');
    } catch (err) {
      const mail = `mailto:sudheerkgupta@outlook.com?subject=${encodeURIComponent(`Resume request: ${data.position} · ${data.country}`)}`
        + `&body=${encodeURIComponent(`Hi Sudheer,\n\nPlease send your resume for: ${data.position} (${data.country}).\n\n${data.company ? 'Company: ' + data.company + '\n' : ''}`)}`;
      status.innerHTML = '';
      status.dataset.tone = 'bad';
      status.append('The form couldn\'t send just now. ');
      const a = Object.assign(document.createElement('a'), { href: mail, textContent: 'Send the request by email instead' });
      status.append(a, '.');
    } finally {
      button.disabled = false;
    }
  });
})();
