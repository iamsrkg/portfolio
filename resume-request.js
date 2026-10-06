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

  async function deliver(req, onSlow) {
    for (const [i, service] of services.entries()) {
      if (i > 0 && onSlow) onSlow();
      if (await trySend(service, req)) return true;
    }
    return false;
  }

  // If every service is down, keep the request and try again, so nobody who asked is lost:
  // every minute for 10 minutes while the page is open, and again on the visitor's next visit.
  const QUEUE = 'resume-request-pending';
  const saveQueue = (list) => { try { localStorage.setItem(QUEUE, JSON.stringify(list)); } catch { /* private mode */ } };
  const loadQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE) || '[]'); } catch { return []; } };
  let flushing = false;
  async function flushQueue() {
    if (flushing) return false;
    flushing = true;
    try {
      const left = [];
      for (const req of loadQueue()) if (!(await deliver({ ...req, note: `${req.note} (delivered on a retry)` }))) left.push(req);
      saveQueue(left);
      return left.length === 0;
    } finally {
      flushing = false;
    }
  }
  function keepTrying(req) {
    saveQueue([...loadQueue(), req]);
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      if (await flushQueue()) {
        clearInterval(timer);
        show(`Sent after all. I'll email my resume to ${req.email}, usually within 15–60 minutes.`, 'ok');
      } else if (tries >= 10) clearInterval(timer);
    }, 60000);
  }
  if (loadQueue().length) setTimeout(flushQueue, 3000);   // a request left over from an earlier visit

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
    const sent = await deliver(req, () => show('Still sending, this can take up to 30 seconds…'));
    button.disabled = false;

    if (sent) {
      form.reset();
      show(`Thanks! I'll email my resume to ${data.email}, usually within 15–60 minutes.`, 'ok');
      return;
    }
    const mail = `mailto:sudheerkgupta@outlook.com?subject=${encodeURIComponent(req.subject)}`
      + `&body=${encodeURIComponent(`Hi Sudheer,\n\nPlease send your resume for: ${data.position} (${data.country}).\n\n${data.company ? 'Company: ' + data.company + '\n' : ''}`)}`;
    keepTrying(req);
    status.innerHTML = '';
    status.dataset.tone = 'bad';
    status.append('The form service is busy. I\'ll keep trying in the background, or reach me directly: ');
    const link = (href, text) => Object.assign(document.createElement('a'), { href, textContent: text, target: href.startsWith('http') ? '_blank' : '', rel: 'noopener' });
    status.append(link(mail, 'email'), ' · ', link('https://www.linkedin.com/in/iamsrkg', 'LinkedIn'), ' · ', link('https://line.me/ti/p/~iamsrkg', 'LINE'), '.');
  });
})();

// Two floating buttons, bottom left: "Contact" (email, LinkedIn, LINE) and, under it, "Request my resume",
// which opens the same form in a dialog, so there is one form and one submit path.
(() => {
  'use strict';
  const form = document.getElementById('resume-form');
  if (!form) return;
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  const stack = document.createElement('div');
  stack.className = 'fab-stack';
  stack.innerHTML = `
    <div class="fab-menu" id="fab-menu" hidden>
      <a href="mailto:sudheerkgupta@outlook.com">${icon('mail')}<span><b>Email</b>sudheerkgupta@outlook.com</span></a>
      <a href="https://www.linkedin.com/in/iamsrkg" target="_blank" rel="noopener">${icon('linkedin')}<span><b>LinkedIn</b>in/iamsrkg</span></a>
      <a href="https://line.me/ti/p/~iamsrkg" target="_blank" rel="noopener">${icon('line')}<span><b>LINE</b>iamsrkg</span></a>
    </div>
    <button type="button" class="fab fab-contact" aria-expanded="false" aria-controls="fab-menu">${icon('chat')}<span>Contact</span></button>
    <button type="button" class="fab fab-resume">${icon('doc')}<span class="full">Request my resume</span><span class="short">Resume</span></button>`;
  document.body.append(stack);
  const menu = stack.querySelector('.fab-menu');
  const contact = stack.querySelector('.fab-contact');
  const resume = stack.querySelector('.fab-resume');

  const showMenu = (open) => { menu.hidden = !open; contact.setAttribute('aria-expanded', String(open)); };
  contact.addEventListener('click', () => showMenu(menu.hidden));
  menu.addEventListener('click', () => showMenu(false));
  document.addEventListener('click', (e) => { if (!menu.hidden && !stack.contains(e.target)) showMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { showMenu(false); contact.focus(); } });

  // near the end of the page the form and the contact buttons are on screen, so the floating ones step aside
  new IntersectionObserver(([entry]) => { stack.classList.toggle('away', entry.isIntersecting); if (entry.isIntersecting) showMenu(false); }, { threshold: 0.2 }).observe(form);

  if (!window.HTMLDialogElement) {            // very old browsers: just go to the form
    resume.addEventListener('click', () => form.scrollIntoView({ behavior: 'smooth' }));
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'rr-dialog';
  dialog.setAttribute('aria-label', 'Request my resume');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'rr-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  dialog.append(close);
  document.body.append(dialog);

  // the form lives in the page; while the dialog is open it moves in, and goes back when it closes
  const home = document.createComment('resume form');
  function open() {
    if (dialog.open) return;
    showMenu(false);
    form.replaceWith(home);
    dialog.append(form);
    dialog.showModal();
    form.querySelector('input[name="email"]').focus();
  }
  const putBack = () => { if (home.parentNode) home.replaceWith(form); };
  const shut = () => { dialog.close(); putBack(); };
  dialog.addEventListener('close', putBack);                                              // Escape closes it too
  close.addEventListener('click', shut);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) shut(); });           // a click on the backdrop
  resume.addEventListener('click', open);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href="#resume-form"]');
    if (a) { e.preventDefault(); open(); }
  });
  if (location.hash === '#resume-form') open();
})();
