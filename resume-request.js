/* "Request my resume": the visitor leaves their email, the role's country and the position,
   and I get one email about it. I reply with the right resume myself; nothing goes back automatically.
   Web3Forms is tried first (fast, 250 a month free). If it fails or the month's limit is used up,
   FormSubmit takes over (no limit, but slower). If both are down, the visitor gets a ready-made email. */
(() => {
  'use strict';
  const form = document.getElementById('resume-form');
  if (!form) return;
  const status = form.querySelector('.rr-status');
  const button = form.querySelector('button[type="submit"]');
  const show = (text, tone) => { status.textContent = text; status.dataset.tone = tone || ''; };

  // Both keys are public by design: they can only send messages to my inbox.
  const services = [
    {
      name: 'web3forms',
      timeoutMs: 15000,
      send: (req, signal) => {
        const body = new FormData();
        Object.entries({ access_key: 'df5b7021-7887-4bc1-b19b-20d9bdaafe8d', from_name: 'Portfolio: resume request', botcheck: '', ...req })
          .forEach(([k, v]) => body.append(k, v));
        return fetch('https://api.web3forms.com/submit', { method: 'POST', body, signal });
      },
      ok: (reply) => reply.success === true,
    },
    {
      name: 'formsubmit',
      timeoutMs: 45000,                            // FormSubmit can take ~30 s to answer
      send: (req, signal) => fetch('https://formsubmit.co/ajax/sudheerkgupta@outlook.com', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _subject: req.subject, _template: 'table', _captcha: 'false', ...req }),
      }),
      ok: (reply) => String(reply.success) === 'true',
    },
  ];

  async function trySend(service, req) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), service.timeoutMs);
    try {
      const res = await service.send(req, ctl.signal);
      const reply = await res.json().catch(() => ({}));
      return res.ok && service.ok(reply);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    if (data._honey) return;                       // bots fill the hidden field; people don't
    const req = {
      subject: `Resume request: ${data.position} · ${data.country}`,
      email: data.email,                           // becomes the reply-to, so "Reply" goes to the requester
      country: data.country,
      position: data.position,
      company: data.company || '(not given)',
      note: data.note || '(none)',
      message: `${data.email} is asking for my resume for the "${data.position}" role in ${data.country}`
        + `${data.company ? ` at ${data.company}` : ''}.${data.note ? ` Note: ${data.note}` : ''} Reply to this email to send it.`,
      page: location.href,
    };

    button.disabled = true;
    show('Sending…');
    let sent = false;
    for (const [i, service] of services.entries()) {
      if (i > 0) show('Still sending, this can take up to 30 seconds…');
      if (await trySend(service, req)) { sent = true; break; }
    }
    button.disabled = false;

    if (sent) {
      form.reset();
      show(`Thanks! I'll email my resume to ${data.email}, usually within 15–60 minutes.`, 'ok');
      return;
    }
    const mail = `mailto:sudheerkgupta@outlook.com?subject=${encodeURIComponent(req.subject)}`
      + `&body=${encodeURIComponent(`Hi Sudheer,\n\nPlease send your resume for: ${data.position} (${data.country}).\n\n${data.company ? 'Company: ' + data.company + '\n' : ''}`)}`;
    status.innerHTML = '';
    status.dataset.tone = 'bad';
    status.append('The form couldn\'t send just now. ');
    const a = Object.assign(document.createElement('a'), { href: mail, textContent: 'Send the request by email instead' });
    status.append(a, '.');
  });
})();
