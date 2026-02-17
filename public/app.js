// ─── x402 Demo Frontend ─────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const API = '';  // same origin

// ── DOM refs ────────────────────────────────────────────────────
const btnLogin   = $('#btnLogin');
const btnDrip    = $('#btnDrip');
const btnOnce    = $('#btnOnce');
const btnDrain   = $('#btnDrain');
const btnStop    = $('#btnStop');
const btnCredits = $('#btnCredits');
const btnClear   = $('#btnClear');
const timeline   = $('#timeline');
const walletAddr = $('#walletAddr');
const creditCount = $('#creditCount');

// ── Flow step elements ──────────────────────────────────────────
const flowSteps = {
  auth:  $('#flow-auth'),
  rpc:   $('#flow-rpc'),
  '402': $('#flow-402'),
  pay:   $('#flow-pay'),
  retry: $('#flow-retry'),
};

let loggedIn = false;
let draining = false;

// ── SSE connection ──────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/api/events`);

  es.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    appendLog(data);
    updateFlow(data);
    updateCreditsFromLog(data);
  });

  es.onerror = () => {
    setTimeout(connectSSE, 2000);
    es.close();
  };
}
connectSSE();

// ── Log rendering ───────────────────────────────────────────────
function appendLog({ type, text, ts }) {
  // Remove empty state
  const empty = timeline.querySelector('.timeline-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = `log-entry ${type}`;

  const time = ts ? new Date(ts).toISOString().slice(11, 23) : '';
  el.innerHTML = `
    <span class="log-ts">${time}</span>
    <span class="log-icon"></span>
    <span class="log-text">${escHtml(text)}</span>
  `;
  timeline.appendChild(el);
  timeline.scrollTop = timeline.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Update flow diagram from events ─────────────────────────────
function updateFlow({ type, text }) {
  // Auth
  if (type === 'step' && text.includes('SIWE'))          activateFlow('auth');
  if (type === 'ok'   && text.includes('Authenticated')) completeFlow('auth');

  // RPC calls during drain
  if (type === 'step' && text.includes('RPC'))           activateFlow('rpc');
  if (type === 'step' && text.includes('Drain'))         activateFlow('rpc');
  if (type === 'info' && text.startsWith('#'))            activateFlow('rpc');
  if (type === 'ok'   && text.includes('Result'))        completeFlow('rpc');

  // 402 detection — these come from the server-side hooks
  if (type === 'warn' && text.includes('imminent'))    { completeFlow('rpc'); alertFlow('402'); }
  if (type === 'payment' && text.includes('402'))      { completeFlow('rpc'); completeFlow('402'); activateFlow('pay'); }
  if (type === 'payment' && text.includes('Auto-signing')) activateFlow('pay');
  if (type === 'payment' && text.includes('Retrying')) { completeFlow('pay'); activateFlow('retry'); }
  if (type === 'payment' && text.includes('replenished')) completeFlow('pay');
  if (type === 'ok'   && text.includes('succeeded after payment')) completeFlow('retry');

  // Final verification
  if (type === 'done')                                   completeFlow('retry');
}

function resetFlow() {
  Object.values(flowSteps).forEach((el) => {
    el.className = 'flow-step';
  });
}

function activateFlow(key) {
  if (flowSteps[key]) flowSteps[key].className = 'flow-step active';
}
function completeFlow(key) {
  if (flowSteps[key]) flowSteps[key].className = 'flow-step done';
}
function alertFlow(key) {
  if (flowSteps[key]) flowSteps[key].className = 'flow-step alert';
}

// ── Extract credit numbers from log text ────────────────────────
function updateCreditsFromLog({ type, text }) {
  const match = text.match(/Credits:\s*(\d+)/i)
             || text.match(/credits=(\d+)/i)
             || text.match(/→\s*(\d+)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    creditCount.textContent = n;

    // Color-code credit display
    if (type === 'payment') {
      creditCount.className = 'stat-value credits-paid';
    } else {
      creditCount.className = 'stat-value' +
        (n === 0 ? ' credits-zero' : n <= 5 ? ' credits-low' : '');
    }
  }
}

// ── API calls ───────────────────────────────────────────────────
async function api(endpoint) {
  const res = await fetch(`${API}/api/${endpoint}`, { method: 'POST' });
  return res.json();
}

// ── Button handlers ─────────────────────────────────────────────
btnLogin.addEventListener('click', async () => {
  setLoading(btnLogin, true);
  resetFlow();
  const data = await api('login');
  setLoading(btnLogin, false);

  if (data.error) return;

  loggedIn = true;
  walletAddr.textContent = data.address
    ? `${data.address.slice(0, 6)}…${data.address.slice(-4)}`
    : '—';
  enableButtons();
});

btnCredits.addEventListener('click', async () => {
  setLoading(btnCredits, true);
  await api('credits');
  setLoading(btnCredits, false);
});

btnDrip.addEventListener('click', async () => {
  setLoading(btnDrip, true);
  await api('drip');
  setLoading(btnDrip, false);
});

btnOnce.addEventListener('click', async () => {
  setLoading(btnOnce, true);
  resetFlow();
  completeFlow('auth');
  activateFlow('rpc');
  await api('rpc');
  setLoading(btnOnce, false);
});

btnDrain.addEventListener('click', async () => {
  draining = true;
  resetFlow();
  completeFlow('auth');
  btnDrain.hidden = true;
  btnStop.hidden = false;
  btnStop.disabled = false;
  disableActions();
  await api('drain');
  draining = false;
  btnDrain.hidden = false;
  btnStop.hidden = true;
  enableButtons();
});

btnStop.addEventListener('click', async () => {
  await api('stop');
  btnStop.disabled = true;
});

btnClear.addEventListener('click', () => {
  timeline.innerHTML = '<div class="timeline-empty">Timeline cleared</div>';
  resetFlow();
  if (loggedIn) completeFlow('auth');
});

// ── Helpers ─────────────────────────────────────────────────────
function setLoading(btn, on) {
  btn.classList.toggle('loading', on);
  if (on) btn.disabled = true;
  else if (loggedIn || btn === btnLogin) btn.disabled = false;
}

function enableButtons() {
  [btnDrip, btnOnce, btnDrain, btnCredits].forEach((b) => (b.disabled = false));
}

function disableActions() {
  [btnLogin, btnDrip, btnOnce, btnCredits].forEach((b) => (b.disabled = true));
}
