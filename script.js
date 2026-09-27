/* ============================================================
   BARKAT TIFFIN SERVICE — app.js
   Offline-first tiffin management. IndexedDB + vanilla JS.
   ============================================================ */
'use strict';

/* ==========================
   CONFIGURATION
   ========================== */
const CFG = {
  DB_NAME: 'BarkatDB',
  DB_VERSION: 1,
  BACKUP_FILE: 'barkat-data.json',
  BACKUP_VERSION: 1,
  STORES: ['customers','companies','foodItems','dailyEntries','dailyEntryItems','payments','bills','settings']
};

const DEFAULT_SETTINGS = {
  businessName: 'Barkat Tiffin Service',
  businessMobile: '',
  businessAddress: '',
  defaultTiffinRate: 80,
  currency: '₹',
  registerEmpty: 'blank',   // 'blank' | 'zero'
  seeded: false
};

const ENTRY_STATUS = ['DELIVERED','NOT_TAKEN','SKIPPED','CANCELLED'];
const FOOD_TYPES   = ['MEAL','EXTRA','OTHER'];
const PAYMENT_MODES= ['Cash','UPI','Bank Transfer','Other'];

/* ==========================
   SMALL UTILITIES
   ========================== */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

function uid(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
}
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
function isoOf(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), a=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${a}`;
}
function todayISO(){ return isoOf(new Date()); }
function currentMonth(){ return todayISO().slice(0,7); }
function monthLabel(ym){
  const [y,m] = ym.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-IN',{month:'long', year:'numeric'});
}
function dateLabel(iso){
  if(!iso) return '';
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('en-IN',{day:'2-digit', month:'short', year:'numeric'});
}
function dayLabel(iso){
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d).toLocaleDateString('en-IN',{day:'2-digit', month:'short'});
}
function daysInMonth(ym){
  const [y,m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function monthStart(ym){ return ym + '-01'; }
function monthEnd(ym){ return ym + '-' + String(daysInMonth(ym)).padStart(2,'0'); }
function money(n){
  const c = state.data.settings.currency || '₹';
  const v = Number(n) || 0;
  return c + v.toLocaleString('en-IN',{maximumFractionDigits:2});
}
function num(n){ return (Number(n)||0).toLocaleString('en-IN'); }
function firstName(n){ return String(n||'').trim().split(/\s+/)[0] || '?'; }
function statusLabel(s){
  return ({DELIVERED:'Delivered', NOT_TAKEN:'Not Taken', SKIPPED:'Skipped', CANCELLED:'Cancelled'})[s] || s || '';
}

/* ==========================
   DATABASE (IndexedDB)
   ========================== */
let _db = null;

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name, keyPath, indexes=[]) => {
        if (db.objectStoreNames.contains(name)) return;
        const st = db.createObjectStore(name, {keyPath});
        indexes.forEach(([iname, path, opts]) => st.createIndex(iname, path, opts || {}));
      };
      mk('customers','id',[['by_company','companyId'],['by_status','status']]);
      mk('companies','id',[]);
      mk('foodItems','id',[['by_type','type'],['by_status','status']]);
      mk('dailyEntries','id',[['by_customer_date',['customerId','date']],['by_date','date'],['by_customer','customerId']]);
      mk('dailyEntryItems','id',[['by_entry','dailyEntryId']]);
      mk('payments','id',[['by_customer','customerId'],['by_date','paymentDate']]);
      mk('bills','id',[['by_customer','customerId'],['by_period','period']]);
      mk('settings','key',[]);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function st(name, mode='readonly'){ return _db.transaction(name, mode).objectStore(name); }
function pr(req){ return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

const dbAll   = (n)       => pr(st(n).getAll());
const dbGet   = (n, k)    => pr(st(n).get(k));
const dbPut   = (n, o)    => pr(st(n, 'readwrite').put(o));
const dbDel   = (n, k)    => pr(st(n, 'readwrite').delete(k));
const dbClear = (n)       => pr(st(n, 'readwrite').clear());
const dbIdx   = (n, i, q) => pr(st(n).index(i).getAll(q));

/* ==========================
   UI STATE
   ========================== */
const state = {
  view: 'dashboard',
  params: {},
  data: {
    customers: [], companies: [], foodItems: [],
    dailyEntries: [], dailyEntryItems: [], payments: [], bills: [],
    settings: Object.assign({}, DEFAULT_SETTINGS)
  },
  index: { entryMap: new Map(), itemsByEntry: new Map() },
  ui: {
    focus: null,
    custSearch: '',
    custTab: 'daily',
    custMonth: currentMonth(),
    entryDate: todayISO(),
    entrySearch: '',
    entryCompany: 'all',
    editing: null,
    registerMonth: currentMonth(),
    registerCompany: 'all',
    registerSearch: '',
    payMonth: currentMonth(),
    billMonth: currentMonth(),
    report: 'outstanding',
    reportMonth: currentMonth(),
    reportFrom: monthStart(currentMonth()),
    reportTo: todayISO(),
    reportCustomer: '',
    reportCompany: 'all',
    companyMonth: currentMonth()
  }
};

/* ==========================
   DATA ACCESS
   ========================== */
async function loadAll(){
  const [customers, companies, foodItems, dailyEntries, dailyEntryItems, payments, bills, settingsRows] =
    await Promise.all(CFG.STORES.map(n => dbAll(n)));

  const D = state.data;
  D.customers = customers;
  D.companies = companies;
  D.foodItems = foodItems;
  D.dailyEntries = dailyEntries;
  D.dailyEntryItems = dailyEntryItems;
  D.payments = payments;
  D.bills = bills;

  D.settings = Object.assign({}, DEFAULT_SETTINGS);
  settingsRows.forEach(r => { if (r.key === 'app' && r.value) Object.assign(D.settings, r.value); });

  const entryMap = new Map();
  dailyEntries.forEach(e => entryMap.set(e.customerId + '|' + e.date, e));
  const itemsByEntry = new Map();
  dailyEntryItems.forEach(i => {
    if (!itemsByEntry.has(i.dailyEntryId)) itemsByEntry.set(i.dailyEntryId, []);
    itemsByEntry.get(i.dailyEntryId).push(i);
  });
  itemsByEntry.forEach(list => list.sort((a,b)=> (a.foodItemNameSnapshot||'').localeCompare(b.foodItemNameSnapshot||'')));

  state.index.entryMap = entryMap;
  state.index.itemsByEntry = itemsByEntry;
}

async function refresh(){ await loadAll(); render(); }

async function saveSettings(patch){
  const s = Object.assign({}, state.data.settings, patch);
  await dbPut('settings', { key: 'app', value: s });
  state.data.settings = s;
}

/* ==========================
   LOOKUPS
   ========================== */
const customerById = id => state.data.customers.find(c => c.id === id) || null;
const companyById  = id => state.data.companies.find(c => c.id === id) || null;
const foodItemById = id => state.data.foodItems.find(f => f.id === id) || null;
const customerName = id => (customerById(id) || {}).name || 'Unknown';
const companyName  = id => (companyById(id) || {}).companyName || '';

/* ==========================
   CALCULATIONS
   ========================== */
function sumEntries(customerId, from, to){
  return state.data.dailyEntries
    .filter(e => e.customerId === customerId
              && (!from || e.date >= from)
              && (!to   || e.date <= to))
    .reduce((s, e) => s + (Number(e.totalAmount) || 0), 0);
}
function sumPayments(customerId, from, to){
  return state.data.payments
    .filter(p => (!customerId || p.customerId === customerId)
              && (!from || (p.paymentDate||'') >= from)
              && (!to   || (p.paymentDate||'') <= to))
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
}
function customerOutstanding(customerId){
  return sumEntries(customerId) - sumPayments(customerId);
}
function countExtras(entries){
  let q = 0;
  entries.forEach(e => {
    (state.index.itemsByEntry.get(e.id) || []).forEach(it => {
      const f = foodItemById(it.foodItemId);
      const type = f ? f.type : 'OTHER';
      if (type !== 'MEAL') q += Number(it.quantity) || 0;
    });
  });
  return q;
}
function entrySummary(entry){
  const items = state.index.itemsByEntry.get(entry.id) || [];
  if (!items.length) return entry.status === 'DELIVERED' ? 'Tiffin' : statusLabel(entry.status);
  const meals = [], extras = [];
  items.forEach(it => {
    const f = foodItemById(it.foodItemId);
    const t = f ? f.type : 'OTHER';
    const label = (Number(it.quantity) > 1 ? it.quantity + ' × ' : '') + it.foodItemNameSnapshot;
    (t === 'MEAL' ? meals : extras).push(label);
  });
  const all = meals.concat(extras);
  return all.join(' + ') || '—';
}
function salesInRange(from, to){
  return state.data.dailyEntries
    .filter(e => e.date >= from && e.date <= to)
    .reduce((s, e) => s + (Number(e.totalAmount) || 0), 0);
}
function paymentsInRange(from, to){
  return state.data.payments
    .filter(p => (p.paymentDate||'') >= from && (p.paymentDate||'') <= to)
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
}

/* Monthly register matrix — always generated from live transactions */
function buildRegister(ym, companyId, search){
  const dim = daysInMonth(ym);
  let customers = state.data.customers.slice();
  if (companyId && companyId !== 'all') customers = customers.filter(c => c.companyId === companyId);
  if (search){
    const q = search.toLowerCase();
    customers = customers.filter(c =>
      (c.name||'').toLowerCase().includes(q) || (c.mobile||'').includes(q));
  }
  customers = customers.filter(c => c.status === 'ACTIVE' ||
    state.data.dailyEntries.some(e => e.customerId === c.id && e.date.startsWith(ym)));
  customers.sort((a,b) => (a.name||'').localeCompare(b.name||''));

  const rows = customers.map(c => {
    const days = [];
    let subtotal = 0;
    for (let d = 1; d <= dim; d++){
      const date = `${ym}-${String(d).padStart(2,'0')}`;
      const e = state.index.entryMap.get(c.id + '|' + date);
      const amt = e ? (Number(e.totalAmount) || 0) : 0;
      days.push({ date, day: d, amount: amt, entryId: e ? e.id : null });
      subtotal += amt;
    }
    return { customer: c, days, subtotal };
  });

  const dayTotals = [];
  for (let i = 0; i < dim; i++) dayTotals.push(rows.reduce((s,r) => s + r.days[i].amount, 0));
  const grand = rows.reduce((s,r) => s + r.subtotal, 0);
  return { dim, rows, dayTotals, grand };
}

/* ==========================
   TOASTS / CONFIRM / MODAL
   ========================== */
function toast(msg, type){
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2400);
  setTimeout(() => el.remove(), 2800);
}

let confirmResolver = null;
function askConfirm(msg, okLabel){
  $('#confirmMsg').textContent = msg;
  $('#confirmOk').textContent = okLabel || 'Confirm';
  $('#confirm').classList.add('open');
  return new Promise(res => { confirmResolver = res; });
}
function closeConfirm(val){
  $('#confirm').classList.remove('open');
  if (confirmResolver){ confirmResolver(val); confirmResolver = null; }
}

function openModal(title, bodyHtml, footerHtml){
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalFooter').innerHTML = footerHtml || '';
  $('#modalBody').scrollTop = 0;
  $('#modal').classList.add('open');
}
function closeModal(){
  $('#modal').classList.remove('open');
  state.ui.editing = null;
}

/* ==========================
   NAVIGATION
   ========================== */
function nav(view, params){
  state.view = view;
  state.params = params || {};
  closeDrawer();
  closeModal();
  render();
  window.scrollTo(0, 0);
}
function openDrawer(){ $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); }
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }

const VIEW_TITLES = {
  dashboard:'Dashboard', customers:'Customers', customerDetail:'Customer',
  companies:'Companies', foodItems:'Food Items', dailyEntry:'Daily Entry',
  register:'Monthly Register', payments:'Payments', bills:'Bills',
  reports:'Reports', backup:'Backup & Restore', settings:'Settings'
};

function updateBottomNav(){
  const map = { dashboard:'dashboard', dailyEntry:'dailyEntry', register:'register', customers:'customers' };
  $$('.bottomnav button').forEach(b => {
    const v = b.dataset.view;
    b.classList.toggle('active', !!v && map[state.view] === v);
  });
}

/* ==========================
   RENDERING
   ========================== */
const VIEWS = {};

function render(){
  $('#viewTitle').textContent = VIEW_TITLES[state.view] || '';
  $('#brandName').textContent = state.data.settings.businessName || 'Barkat Tiffin Service';
  const fn = VIEWS[state.view] || VIEWS.dashboard;
  $('#view').innerHTML = fn();
  updateBottomNav();
  restoreFocus();
}

function restoreFocus(){
  const id = state.ui.focus;
  state.ui.focus = null;
  if (!id) return;
  const el = document.getElementById(id);
  if (el){
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch(e){}
  }
}

function emptyState(icon, title, text, actions){
  return `<div class="card empty">
    <div class="big">${icon}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    <div style="margin-top:12px">${actions || ''}</div>
  </div>`;
}

/* ---------- DASHBOARD ---------- */
VIEWS.dashboard = function(){
  const D = state.data;

  if (!D.customers.length && !D.foodItems.length){
    return `<div class="card" style="text-align:center;padding:26px 16px">
      <h2 style="color:var(--primary-dark)">BARKAT TIFFIN SERVICE</h2>
      <p style="color:var(--muted)">No customers yet. Start by adding a customer and your food items.</p>
      <div style="display:grid;gap:8px;margin-top:14px">
        <button class="btn primary block" data-action="add-customer">+ Add Customer</button>
        <button class="btn ghost block" data-action="add-food">+ Add Food Item</button>
        <button class="btn block" data-action="seed-demo">Load Demo Data</button>
      </div>
      <p class="hint">Everything is stored offline in this device's IndexedDB.</p>
    </div>`;
  }

  const today = todayISO();
  const ym = currentMonth();
  const todays = D.dailyEntries.filter(e => e.date === today);
  const todaySales = todays.reduce((s,e) => s + (Number(e.totalAmount)||0), 0);
  const tiffins = todays.filter(e => e.status === 'DELIVERED').length;
  const extras = countExtras(todays);

  const monthEntries = D.dailyEntries.filter(e => e.date.startsWith(ym));
  const monthSales = monthEntries.reduce((s,e) => s + (Number(e.totalAmount)||0), 0);
  const monthReceived = paymentsInRange(monthStart(ym), monthEnd(ym));
  const monthDue = monthSales - monthReceived;
  const activeCustomers = D.customers.filter(c => c.status === 'ACTIVE').length;

  const recent = D.dailyEntries
    .slice()
    .sort((a,b) => (b.updatedAt||'').localeCompare(a.updatedAt||''))
    .slice(0, 6);

  return `
    <div class="section-title">Today · ${esc(dateLabel(today))}</div>
    <div class="stats">
      <div class="stat"><div class="k">Customers</div><div class="v">${todays.length}</div></div>
      <div class="stat"><div class="k">Tiffins</div><div class="v">${tiffins}</div></div>
      <div class="stat"><div class="k">Extra Items</div><div class="v">${extras}</div></div>
      <div class="stat good"><div class="k">Sales</div><div class="v small">${money(todaySales)}</div></div>
    </div>

    <div class="section-title">${esc(monthLabel(ym))}</div>
    <div class="stats">
      <div class="stat"><div class="k">Total Sales</div><div class="v small">${money(monthSales)}</div></div>
      <div class="stat good"><div class="k">Received</div><div class="v small">${money(monthReceived)}</div></div>
      <div class="stat ${monthDue > 0 ? 'bad' : ''}"><div class="k">Outstanding</div><div class="v small">${money(monthDue)}</div></div>
      <div class="stat"><div class="k">Active Customers</div><div class="v">${activeCustomers}</div></div>
    </div>

    <div class="section-title">Quick Actions</div>
    <div class="qa-grid">
      <button class="btn primary" data-action="add-customer">+ Customer</button>
      <button class="btn primary" data-action="nav" data-view="dailyEntry">Daily Entry</button>
      <button class="btn ghost" data-action="nav" data-view="register">Register</button>
      <button class="btn ghost" data-action="add-payment">+ Payment</button>
    </div>

    <div class="section-title">Recent Activity</div>
    <div class="card tight">
      ${recent.length ? recent.map(e => `
        <div class="list-item" data-action="open-entry-day" data-id="${e.customerId}" data-date="${e.date}">
          <div class="avatar">${esc(firstName(customerName(e.customerId)).charAt(0))}</div>
          <div class="li-main">
            <div class="li-title">${esc(customerName(e.customerId))}</div>
            <div class="li-sub">${esc(dayLabel(e.date))} · ${esc(entrySummary(e))}</div>
          </div>
          <div class="li-right"><div class="li-amount">${money(e.totalAmount)}</div></div>
        </div>`).join('')
      : '<div class="empty"><p>No entries yet. Tap “Daily Entry” to start.</p></div>'}
    </div>
  `;
};

/* ---------- CUSTOMERS ---------- */
function customerCard(c){
  const ym = currentMonth();
  const monthAmt = sumEntries(c.id, monthStart(ym), monthEnd(ym));
  const due = customerOutstanding(c.id);
  return `<div class="list-item" data-action="open-customer" data-id="${c.id}">
    <div class="avatar">${esc(firstName(c.name).charAt(0).toUpperCase())}</div>
    <div class="li-main">
      <div class="li-title">${esc(c.name)}
        <span class="badge ${c.status === 'ACTIVE' ? 'ok' : 'off'}">${c.status === 'ACTIVE' ? 'Active' : 'Inactive'}</span>
      </div>
      <div class="li-sub">${esc(c.mobile || '—')}${c.companyId ? ' • ' + esc(companyName(c.companyId)) : ''}</div>
    </div>
    <div class="li-right">
      <div class="li-amount">${money(monthAmt)}</div>
      <div class="li-sub">${due > 0 ? 'Due ' + money(due) : 'Settled'}</div>
    </div>
  </div>`;
}

VIEWS.customers = function(){
  const q = state.ui.custSearch.toLowerCase();
  let list = state.data.customers.slice().sort((a,b) => (a.name||'').localeCompare(b.name||''));
  if (q) list = list.filter(c => (c.name||'').toLowerCase().includes(q) || (c.mobile||'').includes(q));

  return `
    <div class="filters">
      <input class="full" id="custSearch" type="search" placeholder="Search name or mobile…" value="${esc(state.ui.custSearch)}">
    </div>
    <button class="btn primary block" data-action="add-customer">+ Add Customer</button>
    <div class="section-title">${list.length} customer${list.length === 1 ? '' : 's'}</div>
    <div class="card tight">
      ${list.length ? list.map(customerCard).join('')
        : '<div class="empty"><p>No customers found.</p></div>'}
    </div>
  `;
};

VIEWS.customerDetail = function(){
  const c = customerById(state.params.id);
  if (!c) return emptyState('⚠️','Customer not found','It may have been removed.','<button class="btn primary" data-action="nav" data-view="customers">Back to Customers</button>');
  const ym = state.ui.custMonth;
  const entries = state.data.dailyEntries
    .filter(e => e.customerId === c.id && e.date.startsWith(ym))
    .sort((a,b) => b.date.localeCompare(a.date));
  const monthAmt = entries.reduce((s,e) => s + (Number(e.totalAmount)||0), 0);
  const tiffinCount = entries.filter(e => e.status === 'DELIVERED').length;
  const extraCount = countExtras(entries);
  const paid = sumPayments(c.id, monthStart(ym), monthEnd(ym));
  const outstanding = monthAmt - paid;
  const bills = state.data.bills.filter(b => b.customerId === c.id).sort((a,b)=>b.period.localeCompare(a.period));
  const payments = state.data.payments.filter(p => p.customerId === c.id).sort((a,b)=>(b.paymentDate||'').localeCompare(a.paymentDate||''));
  const tab = state.ui.custTab;

  let tabHtml = '';
  if (tab === 'daily'){
    tabHtml = entries.length ? `<div class="card tight">${entries.map(e => `
      <div class="list-item" data-action="open-entry-day" data-id="${c.id}" data-date="${e.date}">
        <div class="li-main">
          <div class="li-title">${esc(dateLabel(e.date))}</div>
          <div class="li-sub">${esc(entrySummary(e))}</div>
        </div>
        <div class="li-right"><div class="li-amount">${money(e.totalAmount)}</div></div>
      </div>`).join('')}</div>`
      : '<div class="card empty"><p>No entries this month.</p></div>';
  } else if (tab === 'bills'){
    tabHtml = bills.length ? `<div class="card tight">${bills.map(b => `
      <div class="list-item" data-action="view-bill" data-id="${b.id}">
        <div class="li-main">
          <div class="li-title">${esc(b.periodLabel || b.period)}</div>
          <div class="li-sub">${esc(b.billNo || '')}</div>
        </div>
        <div class="li-right"><div class="li-amount">${money(b.total)}</div></div>
      </div>`).join('')}</div>`
      : '<div class="card empty"><p>No bills generated yet.</p></div>';
  } else {
    tabHtml = payments.length ? `<div class="card tight">${payments.map(p => `
      <div class="list-item">
        <div class="li-main">
          <div class="li-title">${money(p.amount)} <span class="badge info">${esc(p.paymentMode||'')}</span></div>
          <div class="li-sub">${esc(dateLabel(p.paymentDate))}${p.reference ? ' • ' + esc(p.reference) : ''}</div>
        </div>
        <div class="li-right"><button class="btn sm danger ghost" data-action="delete-payment" data-id="${p.id}">Delete</button></div>
      </div>`).join('')}</div>`
      : '<div class="card empty"><p>No payments recorded.</p></div>';
  }

  return `
    <button class="btn sm ghost" data-action="nav" data-view="customers">← Customers</button>
    <div class="card" style="margin-top:10px">
      <div class="li-title" style="font-size:17px">${esc(c.name)}
        <span class="badge ${c.status === 'ACTIVE' ? 'ok' : 'off'}">${c.status}</span></div>
      <div class="kv"><span class="k">Mobile</span><span class="v">${esc(c.mobile || '—')}</span></div>
      <div class="kv"><span class="k">Email</span><span class="v">${esc(c.email || '—')}</span></div>
      <div class="kv"><span class="k">Address</span><span class="v">${esc(c.address || '—')}</span></div>
      <div class="kv"><span class="k">Company</span><span class="v">${esc(companyName(c.companyId) || '—')}</span></div>
      <div class="kv"><span class="k">Code</span><span class="v">${esc(c.customerCode || '—')}</span></div>
      ${c.notes ? `<div class="kv"><span class="k">Notes</span><span class="v">${esc(c.notes)}</span></div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn sm primary" data-action="edit-customer" data-id="${c.id}">Edit</button>
        <button class="btn sm ghost" data-action="add-payment" data-id="${c.id}">+ Payment</button>
        <button class="btn sm ${c.status === 'ACTIVE' ? 'danger ghost' : 'ghost'}" data-action="toggle-customer" data-id="${c.id}">
          ${c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</button>
      </div>
    </div>

    <div class="filters" style="grid-template-columns:1fr">
      <input type="month" id="custMonth" value="${ym}">
    </div>

    <div class="stats">
      <div class="stat"><div class="k">Tiffins</div><div class="v">${tiffinCount}</div></div>
      <div class="stat"><div class="k">Extras</div><div class="v">${extraCount}</div></div>
      <div class="stat"><div class="k">Amount</div><div class="v small">${money(monthAmt)}</div></div>
      <div class="stat ${outstanding > 0 ? 'bad' : 'good'}"><div class="k">Outstanding</div><div class="v small">${money(outstanding)}</div></div>
    </div>

    <div class="tabs">
      <button class="${tab === 'daily' ? 'active' : ''}" data-action="cust-tab" data-tab="daily">Daily History</button>
      <button class="${tab === 'bills' ? 'active' : ''}" data-action="cust-tab" data-tab="bills">Bills</button>
      <button class="${tab === 'payments' ? 'active' : ''}" data-action="cust-tab" data-tab="payments">Payments</button>
    </div>
    ${tabHtml}
  `;
};

/* ---------- COMPANIES ---------- */
VIEWS.companies = function(){
  const ym = state.ui.companyMonth;
  const list = state.data.companies.slice().sort((a,b)=>(a.companyName||'').localeCompare(b.companyName||''));
  return `
    <button class="btn primary block" data-action="add-company">+ Add Company</button>
    <div class="section-title">${list.length} compan${list.length === 1 ? 'y' : 'ies'}</div>
    <div class="card tight">
      ${list.length ? list.map(c => {
        const custs = state.data.customers.filter(x => x.companyId === c.id);
        const sales = custs.reduce((s,x) => s + sumEntries(x.id, monthStart(ym), monthEnd(ym)), 0);
        return `<div class="list-item">
          <div class="avatar">${esc((c.companyName||'?').charAt(0).toUpperCase())}</div>
          <div class="li-main">
            <div class="li-title">${esc(c.companyName)}
              <span class="badge ${c.status === 'ACTIVE' ? 'ok' : 'off'}">${c.status}</span></div>
            <div class="li-sub">${custs.length} customer${custs.length===1?'':'s'}${c.mobile ? ' • ' + esc(c.mobile) : ''}</div>
          </div>
          <div class="li-right">
            <div class="li-amount">${money(sales)}</div>
            <div class="li-sub">
              <button class="btn sm ghost" data-action="edit-company" data-id="${c.id}">Edit</button>
            </div>
          </div>
        </div>`;
      }).join('') : '<div class="empty"><p>No companies yet. A customer may belong to a company.</p></div>'}
    </div>
  `;
};

/* ---------- FOOD ITEMS ---------- */
VIEWS.foodItems = function(){
  const list = state.data.foodItems.slice().sort((a,b) =>
    (FOOD_TYPES.indexOf(a.type) - FOOD_TYPES.indexOf(b.type)) || (a.name||'').localeCompare(b.name||''));
  return `
    <button class="btn primary block" data-action="add-food">+ Add Food Item</button>
    ${FOOD_TYPES.map(type => {
      const items = list.filter(f => f.type === type);
      if (!items.length) return '';
      return `<div class="section-title">${type === 'MEAL' ? 'Meals' : type === 'EXTRA' ? 'Extras' : 'Other Items'}</div>
        <div class="card tight">${items.map(f => `
          <div class="list-item">
            <div class="li-main">
              <div class="li-title">${esc(f.name)}
                <span class="badge ${f.status === 'ACTIVE' ? 'ok' : 'off'}">${f.status === 'ACTIVE' ? 'Active' : 'Inactive'}</span></div>
              <div class="li-sub">${esc(f.type)}</div>
            </div>
            <div class="li-right">
              <div class="li-amount">${money(f.rate)}</div>
              <button class="btn sm ghost" data-action="edit-food" data-id="${f.id}">Edit</button>
            </div>
          </div>`).join('')}</div>`;
    }).join('')}
    ${list.length ? '' : '<div class="card empty"><p>No food items yet. Add “Regular Tiffin ₹80”, “Chapati ₹10”, etc.</p></div>'}
  `;
};

/* ---------- DAILY ENTRY ---------- */
VIEWS.dailyEntry = function(){
  const date = state.ui.entryDate;
  const q = state.ui.entrySearch.toLowerCase();
  const comp = state.ui.entryCompany;

  let customers = state.data.customers.filter(c => c.status === 'ACTIVE').slice();
  if (comp !== 'all') customers = customers.filter(c => c.companyId === comp);
  if (q) customers = customers.filter(c => (c.name||'').toLowerCase().includes(q) || (c.mobile||'').includes(q));
  customers.sort((a,b) => (a.name||'').localeCompare(b.name||''));

  const rows = customers.map(c => {
    const e = state.index.entryMap.get(c.id + '|' + date);
    const items = e ? (state.index.itemsByEntry.get(e.id) || []) : [];
    const extras = items.filter(it => {
      const f = foodItemById(it.foodItemId);
      return (f ? f.type : 'OTHER') !== 'MEAL';
    });
    const extraText = extras.length
      ? extras.map(it => (it.quantity > 1 ? it.quantity + ' ' : '') + it.foodItemNameSnapshot).join(', ')
      : '—';
    const taken = e && e.status === 'DELIVERED';
    const total = e ? (Number(e.totalAmount) || 0) : 0;
    return `<div class="list-item" data-action="entry-open" data-id="${c.id}" data-date="${date}">
      <div class="avatar">${esc(firstName(c.name).charAt(0).toUpperCase())}</div>
      <div class="li-main">
        <div class="li-title">${esc(c.name)}</div>
        <div class="li-sub">${esc(extraText)}</div>
      </div>
      <div class="li-right">
        <div class="li-amount">${total ? money(total) : '—'}</div>
        <div class="li-sub">${taken ? '<span class="badge ok">✓ Tiffin</span>' : '<span class="badge off">✕</span>'}</div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="filters">
      <div class="full">
        <label class="hint" style="display:block;margin-bottom:4px">Date</label>
        <input type="date" id="entryDate" value="${date}">
      </div>
      <div class="full">
        <input id="entrySearch" type="search" placeholder="Search customer…" value="${esc(state.ui.entrySearch)}">
      </div>
      <div class="full">
        <select id="entryCompany">
          <option value="all">All Companies</option>
          ${state.data.companies.map(c => `<option value="${c.id}" ${comp === c.id ? 'selected' : ''}>${esc(c.companyName)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="section-title">${esc(dateLabel(date))} · ${rows ? customers.length : 0} customers</div>
    <div class="card tight">
      ${rows || '<div class="empty"><p>No active customers. Add a customer first.</p></div>'}
    </div>
  `;
};

/* ---------- MONTHLY REGISTER ---------- */
VIEWS.register = function(){
  const ym = state.ui.registerMonth;
  const { dim, rows, dayTotals, grand } = buildRegister(ym, state.ui.registerCompany, state.ui.registerSearch);
  const today = todayISO();
  const showZero = state.data.settings.registerEmpty === 'zero';

  const headDays = Array.from({length: dim}, (_, i) =>
    `<th>${String(i+1).padStart(2,'0')}</th>`).join('');

  const body = rows.map(r => {
    const cells = r.days.map(d => {
      const cls = d.amount ? 'reg-cell has' : 'reg-cell empty';
      const todayCls = d.date === today ? ' today' : '';
      const txt = d.amount ? num(d.amount) : (showZero ? '0' : '·');
      const act = d.amount ? `data-action="reg-cell" data-id="${r.customer.id}" data-date="${d.date}"` : '';
      return `<td class="${cls}${todayCls}" ${act}>${txt}</td>`;
    }).join('');
    return `<tr>
      <td class="sticky-left">${esc(r.customer.name)}</td>
      ${cells}
      <td class="sticky-right">${num(r.subtotal)}</td>
    </tr>`;
  }).join('');

  const footDays = dayTotals.map(t => `<td class="num">${t ? num(t) : '·'}</td>`).join('');

  return `
    <div class="filters">
      <input type="month" id="regMonth" value="${ym}">
      <select id="regCompany">
        <option value="all">All Companies</option>
        ${state.data.companies.map(c => `<option value="${c.id}" ${state.ui.registerCompany === c.id ? 'selected':''}>${esc(c.companyName)}</option>`).join('')}
      </select>
      <div class="full"><input id="regSearch" type="search" placeholder="Search customer…" value="${esc(state.ui.registerSearch)}"></div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="btn sm ghost" data-action="export-register-excel">Export Excel/CSV</button>
      <button class="btn sm ghost" data-action="export-register-pdf">Export PDF</button>
      <button class="btn sm ghost" data-action="nav" data-view="dailyEntry">Go to Daily Entry</button>
    </div>

    <div class="section-title">${esc(monthLabel(ym))} · ${rows.length} customers · Total ${money(grand)}</div>

    ${rows.length ? `
    <div class="table-wrap">
      <table class="reg-table">
        <thead><tr><th class="sticky-left">Customer</th>${headDays}<th class="sticky-right">Subtotal</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><th class="sticky-left">TOTAL</th>${footDays}<th class="sticky-right">${num(grand)}</th></tr></tfoot>
      </table>
    </div>
    <p class="hint">Scroll sideways for all days. Tap any amount to view, edit or delete that day's entry.</p>`
    : '<div class="card empty"><p>No customers for this filter.</p></div>'}
  `;
};

/* ---------- PAYMENTS ---------- */
VIEWS.payments = function(){
  const ym = state.ui.payMonth;
  const list = state.data.payments
    .filter(p => (p.paymentDate||'').startsWith(ym))
    .sort((a,b) => (b.paymentDate||'').localeCompare(a.paymentDate||''));
  const total = list.reduce((s,p) => s + (Number(p.amount)||0), 0);

  return `
    <div class="filters">
      <input type="month" id="payMonth" value="${ym}">
      <button class="btn primary" data-action="add-payment">+ Record Payment</button>
    </div>
    <div class="stats" style="grid-template-columns:1fr 1fr">
      <div class="stat"><div class="k">Payments</div><div class="v">${list.length}</div></div>
      <div class="stat good"><div class="k">Received</div><div class="v small">${money(total)}</div></div>
    </div>
    <div class="section-title">${esc(monthLabel(ym))}</div>
    <div class="card tight">
      ${list.length ? list.map(p => `
        <div class="list-item">
          <div class="li-main">
            <div class="li-title">${esc(customerName(p.customerId))}
              <span class="badge info">${esc(p.paymentMode||'Cash')}</span></div>
            <div class="li-sub">${esc(dateLabel(p.paymentDate))}${p.reference ? ' • ' + esc(p.reference) : ''}${p.notes ? ' • ' + esc(p.notes) : ''}</div>
          </div>
          <div class="li-right">
            <div class="li-amount">${money(p.amount)}</div>
            <button class="btn sm danger ghost" data-action="delete-payment" data-id="${p.id}">Delete</button>
          </div>
        </div>`).join('')
      : '<div class="empty"><p>No payments in this month.</p></div>'}
    </div>
  `;
};

/* ---------- BILLS ---------- */
VIEWS.bills = function(){
  const list = state.data.bills.slice().sort((a,b) =>
    (b.period||'').localeCompare(a.period||'') || (a.customerName||a.companyName||'').localeCompare(b.customerName||b.companyName||''));
  return `
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn primary" style="flex:1" data-action="gen-customer-bill">Generate Customer Bill</button>
      <button class="btn ghost" style="flex:1" data-action="gen-company-bill">Generate Company Bill</button>
    </div>
    <div class="section-title">${list.length} bill${list.length===1?'':'s'}</div>
    <div class="card tight">
      ${list.length ? list.map(b => {
        const paid = billPaid(b.id);
        return `<div class="list-item" data-action="view-bill" data-id="${b.id}">
          <div class="li-main">
            <div class="li-title">${esc(b.type === 'COMPANY' ? (b.companyName || 'Company') : (b.customerName || 'Customer'))}
              <span class="badge ${b.type === 'COMPANY' ? 'info' : 'ok'}">${b.type === 'COMPANY' ? 'Company' : 'Customer'}</span></div>
            <div class="li-sub">${esc(b.periodLabel || b.period)} · ${esc(b.billNo || '')} · Paid ${money(paid)}</div>
          </div>
          <div class="li-right">
            <div class="li-amount">${money(b.total)}</div>
            <div class="li-sub">${paid >= b.total ? 'Settled' : 'Due ' + money(b.total - paid)}</div>
          </div>
        </div>`;
      }).join('') : '<div class="empty"><p>No bills yet. Generate one from actual daily transactions.</p></div>'}
    </div>
  `;
};

function billPaid(billId){
  return state.data.payments
    .filter(p => p.billId === billId)
    .reduce((s,p) => s + (Number(p.amount)||0), 0);
}

/* ---------- REPORTS ---------- */
VIEWS.reports = function(){
  const r = state.ui.report;
  const options = [
    ['outstanding','Outstanding Report'],
    ['dailySales','Daily Sales'],
    ['monthlySales','Monthly Sales'],
    ['extraSales','Extra Item Sales'],
    ['companySales','Company-wise Sales'],
    ['paymentReport','Payment Report'],
    ['custStatement','Customer Monthly Statement'],
    ['consumption','Customer Consumption History'],
    ['custPayments','Customer Payment History']
  ];
  let filters = '';
  const needsMonth = ['dailySales','extraSales','companySales','custStatement'];
  const needsRange = ['paymentReport','consumption'];
  const needsCustomer = ['custStatement','consumption','custPayments'];

  if (needsMonth.includes(r))
    filters += `<input type="month" id="repMonth" value="${state.ui.reportMonth}">`;
  if (needsRange.includes(r)){
    filters += `<input type="date" id="repFrom" value="${state.ui.reportFrom}">
                <input type="date" id="repTo" value="${state.ui.reportTo}">`;
  }
  if (needsCustomer.includes(r)){
    filters += `<select id="repCustomer" class="${needsRange.includes(r) ? 'full' : ''}">
      <option value="">— Select Customer —</option>
      ${state.data.customers.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''))
        .map(c => `<option value="${c.id}" ${state.ui.reportCustomer === c.id ? 'selected':''}>${esc(c.name)}</option>`).join('')}
    </select>`;
  }

  return `
    <div class="filters">
      <select id="repType" class="full">
        ${options.map(([v,l]) => `<option value="${v}" ${r===v?'selected':''}>${l}</option>`).join('')}
      </select>
      ${filters}
    </div>
    <div id="reportOut">${renderReport()}</div>
  `;
};

function renderReport(){
  const r = state.ui.report;
  if (r === 'outstanding') return reportOutstanding();
  if (r === 'dailySales') return reportDailySales();
  if (r === 'monthlySales') return reportMonthlySales();
  if (r === 'extraSales') return reportExtraSales();
  if (r === 'companySales') return reportCompanySales();
  if (r === 'paymentReport') return reportPaymentReport();
  if (r === 'custStatement') return reportCustStatement();
  if (r === 'consumption') return reportConsumption();
  if (r === 'custPayments') return reportCustPayments();
  return '';
}

function reportOutstanding(){
  const rows = state.data.customers.map(c => {
    const sales = sumEntries(c.id);
    const paid = sumPayments(c.id);
    return { c, sales, paid, due: sales - paid };
  }).filter(r => r.sales > 0 || r.paid > 0)
    .sort((a,b) => b.due - a.due);

  if (!rows.length) return '<div class="card empty"><p>No data.</p></div>';
  const tSales = rows.reduce((s,r)=>s+r.sales,0);
  const tPaid = rows.reduce((s,r)=>s+r.paid,0);
  const tDue = tSales - tPaid;

  return `<div class="table-wrap"><table>
    <thead><tr><th>Customer</th><th>Mobile</th><th class="num">Sales</th><th class="num">Paid</th><th class="num">Due</th></tr></thead>
    <tbody>${rows.map(r => `<tr data-action="open-customer" data-id="${r.c.id}">
      <td>${esc(r.c.name)}</td><td>${esc(r.c.mobile||'')}</td>
      <td class="num">${num(r.sales)}</td><td class="num">${num(r.paid)}</td>
      <td class="num" style="color:${r.due>0?'var(--danger)':'inherit'}">${num(r.due)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>TOTAL</th><th></th><th class="num">${num(tSales)}</th><th class="num">${num(tPaid)}</th><th class="num">${num(tDue)}</th></tr></tfoot>
  </table></div>`;
}

function reportDailySales(){
  const ym = state.ui.reportMonth;
  const dim = daysInMonth(ym);
  const rows = [];
  for (let d = 1; d <= dim; d++){
    const date = `${ym}-${String(d).padStart(2,'0')}`;
    const entries = state.data.dailyEntries.filter(e => e.date === date);
    const amt = entries.reduce((s,e) => s + (Number(e.totalAmount)||0), 0);
    const paid = paymentsInRange(date, date);
    if (amt || paid) rows.push({ date, count: entries.length, amt, paid });
  }
  if (!rows.length) return '<div class="card empty"><p>No sales in this month.</p></div>';
  const total = rows.reduce((s,r) => s + r.amt, 0);
  return `<div class="section-title">${esc(monthLabel(ym))}</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Date</th><th class="num">Tiffins</th><th class="num">Sales</th><th class="num">Received</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(dateLabel(r.date))}</td><td class="num">${r.count}</td>
      <td class="num">${num(r.amt)}</td><td class="num">${num(r.paid)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>TOTAL</th><th class="num">${rows.reduce((s,r)=>s+r.count,0)}</th>
      <th class="num">${num(total)}</th><th class="num">${num(rows.reduce((s,r)=>s+r.paid,0))}</th></tr></tfoot>
  </table></div>`;
}

function reportMonthlySales(){
  const map = new Map();
  state.data.dailyEntries.forEach(e => {
    const k = e.date.slice(0,7);
    map.set(k, (map.get(k)||0) + (Number(e.totalAmount)||0));
  });
  const keys = Array.from(map.keys()).sort().reverse().slice(0, 18);
  if (!keys.length) return '<div class="card empty"><p>No sales yet.</p></div>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Month</th><th class="num">Sales</th><th class="num">Received</th><th class="num">Difference</th></tr></thead>
    <tbody>${keys.map(k => {
      const sales = map.get(k);
      const paid = paymentsInRange(monthStart(k), monthEnd(k));
      return `<tr><td>${esc(monthLabel(k))}</td><td class="num">${num(sales)}</td>
        <td class="num">${num(paid)}</td><td class="num">${num(sales - paid)}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function reportExtraSales(){
  const ym = state.ui.reportMonth;
  const entries = state.data.dailyEntries.filter(e => e.date.startsWith(ym));
  const map = new Map();
  entries.forEach(e => {
    (state.index.itemsByEntry.get(e.id) || []).forEach(it => {
      const f = foodItemById(it.foodItemId);
      const type = f ? f.type : 'OTHER';
      if (type === 'MEAL') return;
      const key = it.foodItemNameSnapshot + ' @ ' + it.rate;
      const cur = map.get(key) || { qty: 0, amount: 0 };
      cur.qty += Number(it.quantity)||0;
      cur.amount += Number(it.amount)||0;
      map.set(key, cur);
    });
  });
  const rows = Array.from(map.entries()).sort((a,b) => b[1].amount - a[1].amount);
  if (!rows.length) return '<div class="card empty"><p>No extra items sold in this month.</p></div>';
  return `<div class="section-title">${esc(monthLabel(ym))} · Extra item sales</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows.map(([k,v]) => `<tr><td>${esc(k)}</td><td class="num">${v.qty}</td><td class="num">${num(v.amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>TOTAL</th><th class="num">${rows.reduce((s,r)=>s+r[1].qty,0)}</th>
      <th class="num">${num(rows.reduce((s,r)=>s+r[1].amount,0))}</th></tr></tfoot>
  </table></div>`;
}

function reportCompanySales(){
  const ym = state.ui.reportMonth;
  const groups = new Map();
  state.data.customers.forEach(c => {
    const key = c.companyId || '__none__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  const rows = Array.from(groups.entries()).map(([k, custs]) => {
    const sales = custs.reduce((s,c) => s + sumEntries(c.id, monthStart(ym), monthEnd(ym)), 0);
    const paid = custs.reduce((s,c) => s + sumPayments(c.id, monthStart(ym), monthEnd(ym)), 0);
    return { name: k === '__none__' ? 'No Company' : companyName(k), count: custs.length, sales, paid };
  }).filter(r => r.sales || r.paid).sort((a,b) => b.sales - a.sales);
  if (!rows.length) return '<div class="card empty"><p>No sales in this month.</p></div>';
  return `<div class="section-title">${esc(monthLabel(ym))}</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Company</th><th class="num">Customers</th><th class="num">Sales</th><th class="num">Received</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.count}</td>
      <td class="num">${num(r.sales)}</td><td class="num">${num(r.paid)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>TOTAL</th><th></th><th class="num">${num(rows.reduce((s,r)=>s+r.sales,0))}</th>
      <th class="num">${num(rows.reduce((s,r)=>s+r.paid,0))}</th></tr></tfoot>
  </table></div>`;
}

function reportPaymentReport(){
  const from = state.ui.reportFrom, to = state.ui.reportTo;
  const rows = state.data.payments
    .filter(p => (p.paymentDate||'') >= from && (p.paymentDate||'') <= to)
    .sort((a,b) => (a.paymentDate||'').localeCompare(b.paymentDate||''));
  if (!rows.length) return '<div class="card empty"><p>No payments in this range.</p></div>';
  return `<div class="section-title">${esc(dateLabel(from))} → ${esc(dateLabel(to))}</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Customer</th><th>Mode</th><th>Ref</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows.map(p => `<tr><td>${esc(dateLabel(p.paymentDate))}</td>
      <td>${esc(customerName(p.customerId))}</td><td>${esc(p.paymentMode||'')}</td>
      <td>${esc(p.reference||'')}</td><td class="num">${num(p.amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="4">TOTAL</th><th class="num">${num(rows.reduce((s,p)=>s+(Number(p.amount)||0),0))}</th></tr></tfoot>
  </table></div>`;
}

function reportCustStatement(){
  const c = customerById(state.ui.reportCustomer);
  if (!c) return '<div class="card empty"><p>Select a customer.</p></div>';
  const ym = state.ui.reportMonth;
  const entries = state.data.dailyEntries
    .filter(e => e.customerId === c.id && e.date.startsWith(ym))
    .sort((a,b) => a.date.localeCompare(b.date));
  const total = entries.reduce((s,e) => s + (Number(e.totalAmount)||0), 0);
  const paid = sumPayments(c.id, monthStart(ym), monthEnd(ym));
  return `<div class="card">
    <div class="li-title" style="font-size:16px">${esc(c.name)}</div>
    <div class="li-sub">${esc(monthLabel(ym))} · ${esc(c.mobile||'')}</div>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Items</th><th class="num">Amount</th></tr></thead>
    <tbody>${entries.map(e => `<tr><td>${esc(dayLabel(e.date))}</td>
      <td style="white-space:normal">${esc(entrySummary(e))}</td>
      <td class="num">${num(e.totalAmount)}</td></tr>`).join('') || '<tr><td colspan="3">No entries</td></tr>'}</tbody>
    <tfoot>
      <tr><th colspan="2">Monthly Total</th><th class="num">${num(total)}</th></tr>
      <tr><th colspan="2">Paid</th><th class="num">${num(paid)}</th></tr>
      <tr><th colspan="2">Outstanding</th><th class="num">${num(total - paid)}</th></tr>
    </tfoot>
  </table></div>`;
}

function reportConsumption(){
  const c = customerById(state.ui.reportCustomer);
  if (!c) return '<div class="card empty"><p>Select a customer.</p></div>';
  const from = state.ui.reportFrom, to = state.ui.reportTo;
  const entries = state.data.dailyEntries
    .filter(e => e.customerId === c.id && e.date >= from && e.date <= to)
    .sort((a,b) => a.date.localeCompare(b.date));
  if (!entries.length) return '<div class="card empty"><p>No consumption in this range.</p></div>';
  return `<div class="section-title">${esc(c.name)} · ${esc(dateLabel(from))} → ${esc(dateLabel(to))}</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${entries.map(e => {
      const items = state.index.itemsByEntry.get(e.id) || [];
      if (!items.length) return `<tr><td>${esc(dateLabel(e.date))}</td><td colspan="4">${esc(statusLabel(e.status))}</td></tr>`;
      return items.map((it, i) => `<tr>
        <td>${i === 0 ? esc(dateLabel(e.date)) : ''}</td>
        <td>${esc(it.foodItemNameSnapshot)}</td>
        <td class="num">${it.quantity}</td><td class="num">${num(it.rate)}</td>
        <td class="num">${num(it.amount)}</td></tr>`).join('');
    }).join('')}</tbody>
    <tfoot><tr><th colspan="4">TOTAL</th><th class="num">${num(entries.reduce((s,e)=>s+(Number(e.totalAmount)||0),0))}</th></tr></tfoot>
  </table></div>`;
}

function reportCustPayments(){
  const c = customerById(state.ui.reportCustomer);
  if (!c) return '<div class="card empty"><p>Select a customer.</p></div>';
  const rows = state.data.payments.filter(p => p.customerId === c.id)
    .sort((a,b) => (a.paymentDate||'').localeCompare(b.paymentDate||''));
  if (!rows.length) return '<div class="card empty"><p>No payments recorded for this customer.</p></div>';
  return `<div class="section-title">${esc(c.name)} — payment history</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Mode</th><th>Ref</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows.map(p => `<tr><td>${esc(dateLabel(p.paymentDate))}</td><td>${esc(p.paymentMode||'')}</td>
      <td>${esc(p.reference||'')}</td><td class="num">${num(p.amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="3">TOTAL</th><th class="num">${num(rows.reduce((s,p)=>s+(Number(p.amount)||0),0))}</th></tr></tfoot>
  </table></div>`;
}

/* ---------- BACKUP ---------- */
VIEWS.backup = function(){
  const D = state.data;
  const fsSupported = 'showDirectoryPicker' in window;
  return `
    <div class="card">
      <div class="section-title" style="margin-top:0">Current Data</div>
      <div class="kv"><span class="k">Customers</span><span class="v">${D.customers.length}</span></div>
      <div class="kv"><span class="k">Companies</span><span class="v">${D.companies.length}</span></div>
      <div class="kv"><span class="k">Food Items</span><span class="v">${D.foodItems.length}</span></div>
      <div class="kv"><span class="k">Daily Entries</span><span class="v">${D.dailyEntries.length}</span></div>
      <div class="kv"><span class="k">Entry Items</span><span class="v">${D.dailyEntryItems.length}</span></div>
      <div class="kv"><span class="k">Payments</span><span class="v">${D.payments.length}</span></div>
      <div class="kv"><span class="k">Bills</span><span class="v">${D.bills.length}</span></div>
    </div>

    <div class="section-title">Backup</div>
    <div class="card">
      <button class="btn primary block" data-action="export-backup">⬇ Export Backup (${CFG.BACKUP_FILE})</button>
      <div style="height:8px"></div>
      ${fsSupported
        ? `<button class="btn ghost block" data-action="save-folder">📁 Save to Folder (File System Access)</button>
           <p class="hint">${folderHandle() ? 'Folder connected: <b>' + esc(folderName()) + '</b>' : 'No folder connected yet.'}</p>`
        : `<p class="hint">Your browser does not support the File System Access API. Use “Export Backup” and save the file manually into your Barkat/Data folder.</p>`}
    </div>

    <div class="section-title">Restore</div>
    <div class="card">
      <button class="btn ghost block" data-action="import-backup">⬆ Import Backup File</button>
      ${fsSupported ? `<div style="height:8px"></div>
        <button class="btn ghost block" data-action="load-folder">📂 Load ${CFG.BACKUP_FILE} from connected folder</button>` : ''}
      <p class="hint">Restoring replaces the current database. You will be shown a summary and asked to confirm.</p>
    </div>

    <div class="section-title">Danger Zone</div>
    <div class="card">
      <button class="btn danger block" data-action="clear-all">Delete All Data</button>
      <p class="hint">This clears IndexedDB on this device. Export a backup first!</p>
    </div>
  `;
};

/* ---------- SETTINGS ---------- */
VIEWS.settings = function(){
  const s = state.data.settings;
  return `
    <form id="settingsForm" class="card">
      <div class="field"><label>Business Name</label>
        <input name="businessName" value="${esc(s.businessName)}"></div>
      <div class="row2">
        <div class="field"><label>Business Mobile</label>
          <input name="businessMobile" value="${esc(s.businessMobile)}"></div>
        <div class="field"><label>Currency</label>
          <input name="currency" value="${esc(s.currency)}"></div>
      </div>
      <div class="field"><label>Business Address</label>
        <textarea name="businessAddress">${esc(s.businessAddress)}</textarea></div>
      <div class="row2">
        <div class="field"><label>Default Tiffin Rate</label>
          <input name="defaultTiffinRate" type="number" min="0" step="1" value="${esc(s.defaultTiffinRate)}"></div>
        <div class="field"><label>Monthly Register Empty Cells</label>
          <select name="registerEmpty">
            <option value="blank" ${s.registerEmpty === 'blank' ? 'selected' : ''}>Show “·” (blank)</option>
            <option value="zero" ${s.registerEmpty === 'zero' ? 'selected' : ''}>Show “0”</option>
          </select></div>
      </div>
      <button class="btn primary block" type="submit">Save Settings</button>
    </form>

    <div class="section-title">Demo Data</div>
    <div class="card">
      <button class="btn ghost block" data-action="seed-demo">Load Demo Data</button>
      <div style="height:8px"></div>
      <button class="btn danger ghost block" data-action="clear-demo">Clear Demo Data</button>
      <p class="hint">Demo data is created only once (tracked in settings) and never recreated after refresh.</p>
    </div>

    <div class="section-title">About</div>
    <div class="card">
      <div class="kv"><span class="k">App</span><span class="v">Barkat Tiffin Service</span></div>
      <div class="kv"><span class="k">Storage</span><span class="v">IndexedDB (${CFG.DB_NAME})</span></div>
      <div class="kv"><span class="k">Backup file</span><span class="v">${CFG.BACKUP_FILE}</span></div>
      <div class="kv"><span class="k">Data location</span><span class="v">This device only</span></div>
    </div>
  `;
};

/* ==========================
   FORMS / MODALS
   ========================== */
function openCustomerForm(id){
  const c = id ? customerById(id) : null;
  const companies = state.data.companies.slice().sort((a,b)=>(a.companyName||'').localeCompare(b.companyName||''));
  openModal(c ? 'Edit Customer' : 'Add Customer', `
    <form id="customerForm">
      <input type="hidden" name="id" value="${c ? c.id : ''}">
      <div class="field"><label>Name *</label><input name="name" required value="${esc(c ? c.name : '')}"></div>
      <div class="field"><label>Mobile *</label><input name="mobile" required inputmode="tel" value="${esc(c ? c.mobile : '')}"></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${esc(c ? c.email : '')}"></div>
      <div class="field"><label>Address</label><textarea name="address">${esc(c ? c.address : '')}</textarea></div>
      <div class="field"><label>Company</label>
        <select name="companyId">
          <option value="">— None —</option>
          ${companies.map(co => `<option value="${co.id}" ${c && c.companyId === co.id ? 'selected' : ''}>${esc(co.companyName)}</option>`).join('')}
        </select></div>
      <div class="row2">
        <div class="field"><label>Customer Code</label><input name="customerCode" value="${esc(c ? c.customerCode : '')}"></div>
        <div class="field"><label>Status</label>
          <select name="status">
            <option value="ACTIVE" ${!c || c.status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option>
            <option value="INACTIVE" ${c && c.status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option>
          </select></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes">${esc(c ? c.notes : '')}</textarea></div>
    </form>
  `, `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="save-customer">Save Customer</button>`);
}

function openCompanyForm(id){
  const c = id ? companyById(id) : null;
  openModal(c ? 'Edit Company' : 'Add Company', `
    <form id="companyForm">
      <input type="hidden" name="id" value="${c ? c.id : ''}">
      <div class="field"><label>Company Name *</label><input name="companyName" required value="${esc(c ? c.companyName : '')}"></div>
      <div class="row2">
        <div class="field"><label>Contact Person</label><input name="contactPerson" value="${esc(c ? c.contactPerson : '')}"></div>
        <div class="field"><label>Mobile</label><input name="mobile" inputmode="tel" value="${esc(c ? c.mobile : '')}"></div>
      </div>
      <div class="field"><label>Email</label><input name="email" value="${esc(c ? c.email : '')}"></div>
      <div class="field"><label>Address</label><textarea name="address">${esc(c ? c.address : '')}</textarea></div>
      <div class="row2">
        <div class="field"><label>Company Code</label><input name="companyCode" value="${esc(c ? c.companyCode : '')}"></div>
        <div class="field"><label>Status</label>
          <select name="status">
            <option value="ACTIVE" ${!c || c.status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option>
            <option value="INACTIVE" ${c && c.status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option>
          </select></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes">${esc(c ? c.notes : '')}</textarea></div>
    </form>
  `, `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="save-company">Save Company</button>`);
}

function openFoodForm(id){
  const f = id ? foodItemById(id) : null;
  const defRate = state.data.settings.defaultTiffinRate || 80;
  openModal(f ? 'Edit Food Item' : 'Add Food Item', `
    <form id="foodForm">
      <input type="hidden" name="id" value="${f ? f.id : ''}">
      <div class="field"><label>Name *</label><input name="name" required value="${esc(f ? f.name : '')}" placeholder="e.g. Regular Tiffin"></div>
      <div class="row2">
        <div class="field"><label>Rate *</label><input name="rate" type="number" min="0" step="1" required value="${f ? f.rate : defRate}"></div>
        <div class="field"><label>Type</label>
          <select name="type">
            ${FOOD_TYPES.map(t => `<option value="${t}" ${f && f.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label>Status</label>
        <select name="status">
          <option value="ACTIVE" ${!f || f.status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option>
          <option value="INACTIVE" ${f && f.status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option>
        </select></div>
      <p class="hint">MEAL = main tiffin/dinner. EXTRA = chapati, tea, rice. OTHER = anything else.</p>
    </form>
  `, `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="save-food">Save Item</button>`);
}

/* ---------- DAILY ENTRY MODAL ---------- */
function foodOptionsHtml(selectedId, fallbackName){
  const foods = state.data.foodItems.filter(f => f.status !== 'INACTIVE' || f.id === selectedId);
  let html = foods.map(f =>
    `<option value="${f.id}" data-rate="${f.rate}" ${f.id === selectedId ? 'selected' : ''}>${esc(f.name)} — ${money(f.rate)}</option>`
  ).join('');
  if (selectedId && !foods.some(f => f.id === selectedId)){
    html = `<option value="${selectedId}" data-rate="" selected>${esc(fallbackName || 'Item')}</option>` + html;
  }
  if (!html) html = '<option value="">No food items — add one first</option>';
  return html;
}

function itemRowHtml(item){
  const fid = item ? item.foodItemId : '';
  const qty = item ? item.quantity : 1;
  const rate = item ? item.rate : '';
  const name = item ? item.foodItemNameSnapshot : '';
  const amount = (Number(qty)||0) * (Number(rate)||0);
  return `<div class="item-row">
    <select class="it-food">${foodOptionsHtml(fid, name)}</select>
    <input class="it-qty" type="number" min="0" step="1" value="${qty}" inputmode="numeric">
    <input class="it-rate" type="number" min="0" step="1" value="${rate}" inputmode="decimal">
    <span class="it-amt">${num(amount)}</span>
    <button class="rm" data-action="entry-remove-row" aria-label="Remove">✕</button>
  </div>`;
}

function openEntryEditor(customerId, date){
  const c = customerById(customerId);
  if (!c){ toast('Customer not found', 'err'); return; }
  if (!state.data.foodItems.length){
    toast('Add a food item first', 'err');
    nav('foodItems');
    return;
  }
  const entry = state.index.entryMap.get(customerId + '|' + date);
  const items = entry ? (state.index.itemsByEntry.get(entry.id) || []) : [];
  const status = entry ? entry.status : 'DELIVERED';
  const notes = entry ? (entry.notes || '') : '';
  state.ui.editing = { customerId, date };

  const rowsHtml = items.length ? items.map(itemRowHtml).join('') : itemRowHtml(null);

  openModal(`${c.name}`, `
    <div class="hint" style="margin-bottom:10px">${esc(dateLabel(date))}${entry ? ' · editing existing entry' : ' · new entry'}</div>
    <div class="field"><label>Status</label>
      <select id="entryStatus">
        ${ENTRY_STATUS.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
      </select></div>
    <div class="item-head"><span>Food Item</span><span>Qty</span><span>Rate</span><span style="text-align:right">Amount</span><span></span></div>
    <div id="entryItems">${rowsHtml}</div>
    <button class="btn sm ghost" data-action="entry-add-row">+ Add Item</button>
    <div class="entry-total"><span>Daily Total</span><span class="val" id="entryTotal">₹0</span></div>
    <div class="field" style="margin-top:10px"><label>Notes</label>
      <input id="entryNotes" value="${esc(notes)}" placeholder="Optional"></div>
  `, `
    ${entry ? '<button class="btn danger ghost" data-action="entry-delete">Delete</button>' : ''}
    <button class="btn ghost" data-action="close-modal">Cancel</button>
    <button class="btn primary" data-action="entry-save">Save</button>
  `);

  recalcEntryModal();
}

function recalcEntryModal(){
  let total = 0;
  $$('#entryItems .item-row').forEach(row => {
    const qty = Number(row.querySelector('.it-qty').value) || 0;
    const rate = Number(row.querySelector('.it-rate').value) || 0;
    const amt = qty * rate;
    row.querySelector('.it-amt').textContent = num(amt);
    total += amt;
  });
  const status = $('#entryStatus') ? $('#entryStatus').value : 'DELIVERED';
  const shown = status === 'DELIVERED' ? total : 0;
  const el = $('#entryTotal');
  if (el) el.textContent = money(shown);
}

async function saveEntryFromModal(){
  const ed = state.ui.editing;
  if (!ed) return;
  const { customerId, date } = ed;
  const status = $('#entryStatus').value;
  const notes = ($('#entryNotes') ? $('#entryNotes').value : '').trim();

  const items = [];
  if (status === 'DELIVERED'){
    $$('#entryItems .item-row').forEach(row => {
      const foodId = row.querySelector('.it-food').value;
      const qty = Number(row.querySelector('.it-qty').value) || 0;
      const rate = Number(row.querySelector('.it-rate').value) || 0;
      if (!foodId || qty <= 0) return;
      const f = foodItemById(foodId);
      items.push({
        foodItemId: foodId,
        foodItemNameSnapshot: f ? f.name : (row.querySelector('.it-food').selectedOptions[0]?.textContent || 'Item'),
        quantity: qty,
        rate: rate,
        amount: qty * rate
      });
    });
  }

  const totalAmount = items.reduce((s,i) => s + i.amount, 0);
  const now = new Date().toISOString();
  const existing = state.index.entryMap.get(customerId + '|' + date);
  const entryId = existing ? existing.id : uid();

  const entryObj = {
    id: entryId,
    customerId,
    date,
    status,
    totalAmount,
    notes,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
  await dbPut('dailyEntries', entryObj);

  // replace items (preserve nothing — snapshot is stored per item)
  const old = await dbIdx('dailyEntryItems', 'by_entry', entryId);
  for (const o of old) await dbDelete('dailyEntryItems', o.id);
  for (const it of items){
    await dbPut('dailyEntryItems', {
      id: uid(),
      dailyEntryId: entryId,
      foodItemId: it.foodItemId,
      foodItemNameSnapshot: it.foodItemNameSnapshot,
      quantity: it.quantity,
      rate: it.rate,
      amount: it.amount
    });
  }

  closeModal();
  toast(existing ? 'Entry updated' : 'Entry saved', 'ok');
  await refresh();
}

async function deleteEntry(customerId, date){
  const entry = state.index.entryMap.get(customerId + '|' + date);
  if (!entry) return;
  const ok = await askConfirm(`Delete the entry for ${customerName(customerId)} on ${dateLabel(date)}?`, 'Delete');
  if (!ok) return;
  const items = await dbIdx('dailyEntryItems', 'by_entry', entry.id);
  for (const it of items) await dbDelete('dailyEntryItems', it.id);
  await dbDelete('dailyEntries', entry.id);
  closeModal();
  toast('Entry deleted', 'ok');
  await refresh();
}

/* ---------- REGISTER CELL DETAIL ---------- */
function openRegisterCell(customerId, date){
  const c = customerById(customerId);
  const entry = state.index.entryMap.get(customerId + '|' + date);
  if (!entry) return;
  const items = state.index.itemsByEntry.get(entry.id) || [];
  const rows = items.length ? items.map(it => `
    <div class="kv"><span class="k">${esc(it.foodItemNameSnapshot)}<br><small>${it.quantity} × ${money(it.rate)}</small></span>
      <span class="v">${money(it.amount)}</span></div>`).join('')
    : `<div class="kv"><span class="k">${esc(statusLabel(entry.status))}</span><span class="v">${money(0)}</span></div>`;

  openModal(`${c ? c.name : 'Customer'}`, `
    <div class="hint" style="margin-bottom:10px">${esc(dateLabel(date))}</div>
    <div class="card" style="box-shadow:none;border:1px solid var(--line)">
      ${rows}
      <div class="entry-total"><span>Total</span><span class="val">${money(entry.totalAmount)}</span></div>
    </div>
    ${entry.notes ? `<p class="hint">Notes: ${esc(entry.notes)}</p>` : ''}
  `, `
    <button class="btn danger ghost" data-action="reg-delete" data-id="${customerId}" data-date="${date}">Delete</button>
    <button class="btn ghost" data-action="close-modal">Close</button>
    <button class="btn primary" data-action="reg-edit" data-id="${customerId}" data-date="${date}">Edit</button>
  `);
}

/* ---------- PAYMENT ---------- */
function openPaymentForm(customerId){
  const customers = state.data.customers.filter(c => c.status === 'ACTIVE' || c.id === customerId)
    .sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if (!customers.length){ toast('Add a customer first', 'err'); return; }
  const unpaidBills = state.data.bills
    .filter(b => b.type === 'CUSTOMER')
    .sort((a,b) => (b.period||'').localeCompare(a.period||''));

  openModal('Record Payment', `
    <form id="paymentForm">
      <div class="field"><label>Customer *</label>
        <select name="customerId" required>
          ${customers.map(c => `<option value="${c.id}" ${c.id === customerId ? 'selected' : ''}>${esc(c.name)} — due ${money(customerOutstanding(c.id))}</option>`).join('')}
        </select></div>
      <div class="row2">
        <div class="field"><label>Amount *</label>
          <input name="amount" type="number" min="1" step="1" required inputmode="decimal"></div>
        <div class="field"><label>Date *</label>
          <input name="paymentDate" type="date" required value="${todayISO()}"></div>
      </div>
      <div class="field"><label>Mode</label>
        <select name="paymentMode">
          ${PAYMENT_MODES.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select></div>
      <div class="field"><label>Link to Bill (optional)</label>
        <select name="billId">
          <option value="">— None —</option>
          ${unpaidBills.map(b => `<option value="${b.id}">${esc(b.customerName)} · ${esc(b.periodLabel||b.period)} · ${money(b.total - billPaid(b.id))} due</option>`).join('')}
        </select></div>
      <div class="field"><label>Reference</label><input name="reference" placeholder="UPI ref / cheque no."></div>
      <div class="field"><label>Notes</label><input name="notes"></div>
    </form>
  `, `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="save-payment">Save Payment</button>`);
}

/* ---------- BILLS ---------- */
function openBillGenerator(type){
  const customers = state.data.customers.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const companies = state.data.companies.slice().sort((a,b)=>(a.companyName||'').localeCompare(b.companyName||''));
  if (type === 'CUSTOMER' && !customers.length){ toast('No customers yet', 'err'); return; }
  if (type === 'COMPANY' && !companies.length){ toast('No companies yet', 'err'); return; }

  openModal(type === 'CUSTOMER' ? 'Generate Customer Bill' : 'Generate Company Bill', `
    <form id="billForm">
      <input type="hidden" name="type" value="${type}">
      ${type === 'CUSTOMER' ? `
        <div class="field"><label>Customer *</label>
          <select name="customerId" required>
            ${customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select></div>` : `
        <div class="field"><label>Company *</label>
          <select name="companyId" required>
            ${companies.map(c => `<option value="${c.id}">${esc(c.companyName)}</option>`).join('')}
          </select></div>`}
      <div class="field"><label>Month *</label>
        <input name="period" type="month" required value="${state.ui.billMonth}"></div>
      <p class="hint">The bill is a snapshot of the actual daily transactions for that month. Old bills never change when rates change later.</p>
    </form>
  `, `<button class="btn ghost" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="create-bill">Generate Bill</button>`);
}

async function createBill(){
  const form = $('#billForm');
  const type = form.type.value;
  const period = form.period.value;
  if (!period){ toast('Select a month', 'err'); return; }
  const periodLabel = monthLabel(period);
  const now = new Date().toISOString();

  let bill;

  if (type === 'CUSTOMER'){
    const c = customerById(form.customerId.value);
    if (!c) return;
    const entries = state.data.dailyEntries
      .filter(e => e.customerId === c.id && e.date.startsWith(period))
      .sort((a,b) => a.date.localeCompare(b.date));
    if (!entries.length){ toast('No transactions in that month', 'err'); return; }

    const lines = entries.map(e => {
      const items = (state.index.itemsByEntry.get(e.id) || []).map(it => ({
        name: it.foodItemNameSnapshot, qty: it.quantity, rate: it.rate, amount: it.amount
      }));
      return {
        date: e.date,
        description: entrySummary(e),
        items,
        amount: Number(e.totalAmount) || 0
      };
    });
    const total = lines.reduce((s,l) => s + l.amount, 0);
    bill = {
      id: uid(),
      billNo: 'B-' + period.replace('-','') + '-' + (state.data.bills.length + 1),
      type: 'CUSTOMER',
      customerId: c.id,
      customerName: c.name,
      customerMobile: c.mobile || '',
      companyId: c.companyId || '',
      companyName: companyName(c.companyId),
      period, periodLabel,
      lines,
      total,
      createdAt: now
    };
  } else {
    const co = companyById(form.companyId.value);
    if (!co) return;
    const custs = state.data.customers.filter(x => x.companyId === co.id);
    const lines = [];
    custs.forEach(c => {
      const amt = sumEntries(c.id, monthStart(period), monthEnd(period));
      if (amt > 0) lines.push({ date: '', description: c.name, items: [], amount: amt, customerId: c.id });
    });
    if (!lines.length){ toast('No transactions in that month', 'err'); return; }
    const total = lines.reduce((s,l) => s + l.amount, 0);
    bill = {
      id: uid(),
      billNo: 'CB-' + period.replace('-','') + '-' + (state.data.bills.length + 1),
      type: 'COMPANY',
      companyId: co.id,
      companyName: co.companyName,
      customerName: co.companyName,
      period, periodLabel,
      lines,
      total,
      createdAt: now
    };
  }

  await dbPut('bills', bill);
  closeModal();
  toast('Bill generated', 'ok');
  await refresh();
  viewBill(bill.id);
}

function billHtml(bill){
  const s = state.data.settings;
  const paid = billPaid(bill.id);
  const outstanding = bill.total - paid;
  const lineRows = bill.lines.map(l => `
    <tr>
      <td>${l.date ? esc(dayLabel(l.date)) : ''}</td>
      <td style="white-space:normal">${esc(l.description)}</td>
      <td class="num">${num(l.amount)}</td>
    </tr>`).join('');

  return `<div class="bill-doc">
    <div class="hd">
      <h2>${esc(s.businessName || 'Barkat Tiffin Service')}</h2>
      <small>${esc(s.businessMobile || '')}${s.businessAddress ? ' · ' + esc(s.businessAddress) : ''}</small>
    </div>
    <div class="kv"><span class="k">Bill No</span><span class="v">${esc(bill.billNo || '')}</span></div>
    <div class="kv"><span class="k">${bill.type === 'COMPANY' ? 'Company' : 'Customer'}</span><span class="v">${esc(bill.type === 'COMPANY' ? bill.companyName : bill.customerName)}</span></div>
    ${bill.customerMobile ? `<div class="kv"><span class="k">Mobile</span><span class="v">${esc(bill.customerMobile)}</span></div>` : ''}
    <div class="kv"><span class="k">Period</span><span class="v">${esc(bill.periodLabel || bill.period)}</span></div>
    <div style="height:10px"></div>
    <table>
      <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
      <tbody>${lineRows}</tbody>
      <tfoot>
        <tr><th colspan="2">Monthly Total</th><th class="num">${num(bill.total)}</th></tr>
        <tr><th colspan="2">Paid</th><th class="num">${num(paid)}</th></tr>
        <tr><th colspan="2">Outstanding</th><th class="num">${num(outstanding)}</th></tr>
      </tfoot>
    </table>
    <p class="hint" style="margin-top:10px">Generated on ${esc(dateLabel(bill.createdAt.slice(0,10)))}. Rates are locked to the transaction date.</p>
  </div>`;
}

function viewBill(id){
  const bill = state.data.bills.find(b => b.id === id);
  if (!bill) return;
  openModal(bill.billNo || 'Bill', billHtml(bill), `
    <button class="btn danger ghost" data-action="delete-bill" data-id="${bill.id}">Delete</button>
    <button class="btn ghost" data-action="print-bill" data-id="${bill.id}">Print</button>
    <button class="btn primary" data-action="pdf-bill" data-id="${bill.id}">PDF</button>
  `);
}

/* ==========================
   BACKUP / RESTORE
   ========================== */
let _dirHandle = null;

function folderHandle(){ return _dirHandle; }
function folderName(){ return _dirHandle ? _dirHandle.name : ''; }

async function getStoredDirHandle(){
  try {
    const rec = await dbGet('settings', '__dirHandle');
    return rec ? rec.value : null;
  } catch(e){ return null; }
}
async function storeDirHandle(handle){
  try { await dbPut('settings', { key: '__dirHandle', value: handle }); } catch(e){}
}

function buildBackupObject(){
  const D = state.data;
  const settingsArr = [];
  Object.keys(D.settings).forEach(k => settingsArr.push({ key: k, value: D.settings[k] }));
  return {
    version: CFG.BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'Barkat Tiffin Service',
    customers: D.customers,
    companies: D.companies,
    foodItems: D.foodItems,
    dailyEntries: D.dailyEntries,
    dailyEntryItems: D.dailyEntryItems,
    payments: D.payments,
    bills: D.bills,
    settings: settingsArr
  };
}

function downloadBlob(content, filename, type){
  const blob = new Blob([content], { type: type || 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportBackup(){
  const data = buildBackupObject();
  downloadBlob(JSON.stringify(data, null, 2), CFG.BACKUP_FILE, 'application/json');
  toast('Backup exported: ' + CFG.BACKUP_FILE, 'ok');
}

async function saveToFolder(){
  try {
    let handle = _dirHandle || await getStoredDirHandle();
    if (!handle){
      if (!('showDirectoryPicker' in window)){ toast('Not supported here', 'err'); return; }
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      _dirHandle = handle;
      await storeDirHandle(handle);
    }
    const perm = await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'granted');
    if (perm === 'denied'){ toast('Permission denied', 'err'); return; }
    const fileHandle = await handle.getFileHandle(CFG.BACKUP_FILE, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(buildBackupObject(), null, 2));
    await writable.close();
    toast('Saved to folder: ' + handle.name, 'ok');
    render();
  } catch(e){
    if (e && e.name === 'AbortError') return;
    toast('Could not save to folder: ' + (e.message || e), 'err');
  }
}

async function loadFromFolder(){
  try {
    let handle = _dirHandle || await getStoredDirHandle();
    if (!handle){
      if (!('showDirectoryPicker' in window)){ toast('Not supported here', 'err'); return; }
      handle = await window.showDirectoryPicker({ mode: 'read' });
      _dirHandle = handle;
      await storeDirHandle(handle);
    }
    const fileHandle = await handle.getFileHandle(CFG.BACKUP_FILE);
    const file = await fileHandle.getFile();
    const text = await file.text();
    await handleImportText(text);
  } catch(e){
    if (e && e.name === 'AbortError') return;
    toast('Could not read ' + CFG.BACKUP_FILE + ' from folder', 'err');
  }
}

function importBackupFile(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      await handleImportText(text);
    } catch(e){
      toast('Invalid file', 'err');
    }
  };
  input.click();
}

function validateBackup(obj){
  if (!obj || typeof obj !== 'object') return 'Not a valid JSON object.';
  if (typeof obj.version !== 'number') return 'Missing "version" field.';
  if (obj.version > CFG.BACKUP_VERSION) return 'Backup version is newer than this app supports.';
  const arrs = ['customers','companies','foodItems','dailyEntries','dailyEntryItems','payments','bills'];
  for (const a of arrs){
    if (obj[a] !== undefined && !Array.isArray(obj[a])) return `"${a}" must be an array.`;
  }
  if (!obj.customers && !obj.foodItems && !obj.dailyEntries) return 'Backup contains no data.';
  return null;
}

async function handleImportText(text){
  let obj;
  try { obj = JSON.parse(text); }
  catch(e){ toast('File is not valid JSON', 'err'); return; }

  const err = validateBackup(obj);
  if (err){ toast(err, 'err'); return; }

  const summary = `Customers: ${(obj.customers||[]).length}
Companies: ${(obj.companies||[]).length}
Food Items: ${(obj.foodItems||[]).length}
Daily Entries: ${(obj.dailyEntries||[]).length}
Payments: ${(obj.payments||[]).length}
Bills: ${(obj.bills||[]).length}

Restore this backup? This will REPLACE all data currently on this device.`;

  const ok = await askConfirm(summary, 'Restore');
  if (!ok) return;

  const D = state.data;
  const keepSettings = Object.assign({}, D.settings);

  await Promise.all(CFG.STORES.map(n => dbClear(n)));

  const putAll = async (storeName, arr) => {
    for (const item of (arr || [])){
      await dbPut(storeName, item);
    }
  };
  await putAll('customers', obj.customers);
  await putAll('companies', obj.companies);
  await putAll('foodItems', obj.foodItems);
  await putAll('dailyEntries', obj.dailyEntries);
  await putAll('dailyEntryItems', obj.dailyEntryItems);
  await putAll('payments', obj.payments);
  await putAll('bills', obj.bills);

  // settings
  let newSettings = keepSettings;
  if (Array.isArray(obj.settings) && obj.settings.length){
    newSettings = Object.assign({}, DEFAULT_SETTINGS);
    obj.settings.forEach(s => { if (s && s.key) newSettings[s.key] = s.value; });
  }
  await dbPut('settings', { key: 'app', value: newSettings });
  if (_dirHandle) await storeDirHandle(_dirHandle);

  await refresh();
  toast('Backup restored', 'ok');
}

async function clearAllData(){
  const ok = await askConfirm('Delete ALL data on this device? This cannot be undone.', 'Delete All');
  if (!ok) return;
  const handle = await getStoredDirHandle();
  await Promise.all(CFG.STORES.map(n => dbClear(n)));
  await dbPut('settings', { key: 'app', value: Object.assign({}, DEFAULT_SETTINGS, { seeded: true }) });
  if (handle) await storeDirHandle(handle);
  await refresh();
  toast('All data cleared', 'ok');
}

/* ==========================
   DEMO DATA
   ========================== */
async function seedDemoData(){
  const existing = state.data.customers.length || state.data.foodItems.length;
  if (existing){
    const ok = await askConfirm('Demo data will be ADDED to your existing data. Continue?', 'Add Demo Data');
    if (!ok) return;
  }
  const now = new Date().toISOString();

  const companyId = uid();
  await dbPut('companies', {
    id: companyId, companyCode: 'ABC', companyName: 'ABC Pvt Ltd',
    contactPerson: 'Mr. Sharma', mobile: '9800000000', email: '', address: '',
    status: 'ACTIVE', notes: '', createdAt: now, updatedAt: now
  });

  const custs = [
    { name: 'Rahul Patil', mobile: '9876543210', companyId },
    { name: 'Amit Shah',   mobile: '9876543211', companyId },
    { name: 'Neha Khan',   mobile: '9876543212', companyId },
    { name: 'Sameer Shaikh', mobile: '9876543213', companyId: '' }
  ];
  for (const c of custs){
    await dbPut('customers', {
      id: uid(), customerCode: '', name: c.name, mobile: c.mobile, email: '',
      address: '', companyId: c.companyId, status: 'ACTIVE', notes: '',
      createdAt: now, updatedAt: now
    });
  }

  const foods = [
    { name: 'Regular Tiffin', type: 'MEAL',  rate: 80 },
    { name: 'Dinner',         type: 'MEAL',  rate: 80 },
    { name: 'Chapati',        type: 'EXTRA', rate: 10 },
    { name: 'Tea',            type: 'EXTRA', rate: 15 },
    { name: 'Rice',           type: 'EXTRA', rate: 20 },
    { name: 'Dal',            type: 'EXTRA', rate: 30 }
  ];
  for (const f of foods){
    await dbPut('foodItems', {
      id: uid(), name: f.name, type: f.type, rate: f.rate,
      status: 'ACTIVE', createdAt: now, updatedAt: now
    });
  }

  await saveSettings({ seeded: true });
  await refresh();
  toast('Demo data loaded', 'ok');
}

async function clearDemoData(){
  const ok = await askConfirm('Remove demo customers, the demo company and demo food items? History records will remain.', 'Remove Demo');
  if (!ok) return;
  const demoCompany = state.data.companies.find(c => c.companyName === 'ABC Pvt Ltd');
  const demoCustomers = state.data.customers.filter(c => ['Rahul Patil','Amit Shah','Neha Khan','Sameer Shaikh'].includes(c.name));
  const demoFoods = state.data.foodItems.filter(f => ['Regular Tiffin','Dinner','Chapati','Tea','Rice','Dal'].includes(f.name));

  for (const c of demoCustomers) await dbDelete('customers', c.id);
  if (demoCompany) await dbDelete('companies', demoCompany.id);
  for (const f of demoFoods) await dbDelete('foodItems', f.id);

  await refresh();
  toast('Demo data removed', 'ok');
}

/* ==========================
   EXPORT (Excel / PDF)
   ========================== */
function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function ensureSheetJS(){
  if (window.XLSX) return true;
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    return !!window.XLSX;
  } catch(e){ return false; }
}

async function ensureJsPDF(){
  if (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable) return true;
  try {
    if (!window.jspdf){
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    }
    if (!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable)){
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
    }
    return !!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable);
  } catch(e){ return false; }
}

function toCSV(rows){
  return rows.map(r => r.map(cell => {
    const s = String(cell == null ? '' : cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

async function exportRegisterExcel(){
  const ym = state.ui.registerMonth;
  const { dim, rows, dayTotals, grand } = buildRegister(ym, state.ui.registerCompany, state.ui.registerSearch);
  if (!rows.length){ toast('Nothing to export', 'err'); return; }

  const header = ['Customer', ...Array.from({length: dim}, (_,i) => String(i+1).padStart(2,'0')), 'Subtotal'];
  const aoa = [header];
  rows.forEach(r => {
    aoa.push([r.customer.name, ...r.days.map(d => d.amount || ''), r.subtotal]);
  });
  aoa.push(['TOTAL', ...dayTotals, grand]);

  const ok = await ensureSheetJS();
  const fname = 'barkat-monthly-register-' + ym;

  if (ok){
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Register');
    XLSX.writeFile(wb, fname + '.xlsx');
    toast('Excel exported', 'ok');
  } else {
    downloadBlob(toCSV(aoa), fname + '.csv', 'text/csv');
    toast('CSV exported (offline mode)', 'ok');
  }
}

async function exportRegisterPDF(){
  const ym = state.ui.registerMonth;
  const { dim, rows, dayTotals, grand } = buildRegister(ym, state.ui.registerCompany, state.ui.registerSearch);
  if (!rows.length){ toast('Nothing to export', 'err'); return; }

  const ok = await ensureJsPDF();
  if (!ok){ toast('PDF needs internet (CDN). Use Excel/CSV offline.', 'err'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  doc.setFontSize(14);
  doc.text(state.data.settings.businessName || 'Barkat Tiffin Service', 40, 36);
  doc.setFontSize(10);
  doc.text('Monthly Register — ' + monthLabel(ym), 40, 52);

  const head = [['Customer', ...Array.from({length: dim}, (_,i) => String(i+1).padStart(2,'0')), 'Subtotal']];
  const body = rows.map(r => [r.customer.name, ...r.days.map(d => d.amount ? String(d.amount) : ''), String(r.subtotal)]);
  body.push(['TOTAL', ...dayTotals.map(t => t ? String(t) : ''), String(grand)]);

  doc.autoTable({
    head, body, startY: 64,
    styles: { fontSize: 6.5, cellPadding: 1.6 },
    headStyles: { fillColor: [15,118,110], textColor: 255 },
    columnStyles: { 0: { cellWidth: 80 } }
  });
  doc.save('barkat-monthly-register-' + ym + '.pdf');
  toast('PDF exported', 'ok');
}

async function exportBillPDF(billId){
  const bill = state.data.bills.find(b => b.id === billId);
  if (!bill) return;
  const ok = await ensureJsPDF();
  if (!ok){ toast('PDF needs internet (CDN). Use Print instead.', 'err'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const paid = billPaid(bill.id);

  doc.setFontSize(15);
  doc.text(state.data.settings.businessName || 'Barkat Tiffin Service', 40, 42);
  doc.setFontSize(9);
  const sub = [state.data.settings.businessMobile, state.data.settings.businessAddress].filter(Boolean).join(' · ');
  if (sub) doc.text(sub, 40, 56);

  doc.setFontSize(10);
  doc.text('Bill No: ' + (bill.billNo || ''), 40, 78);
  doc.text((bill.type === 'COMPANY' ? 'Company: ' : 'Customer: ') + (bill.type === 'COMPANY' ? bill.companyName : bill.customerName), 40, 92);
  doc.text('Period: ' + (bill.periodLabel || bill.period), 40, 106);

  doc.autoTable({
    head: [['Date', 'Description', 'Amount']],
    body: bill.lines.map(l => [l.date ? dayLabel(l.date) : '', l.description, String(l.amount)]),
    startY: 122,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [15,118,110], textColor: 255 },
    columnStyles: { 2: { halign: 'right' } }
  });

  const endY = doc.lastAutoTable.finalY + 16;
  doc.setFontSize(10);
  doc.text('Monthly Total: ' + money(bill.total), 40, endY);
  doc.text('Paid: ' + money(paid), 40, endY + 14);
  doc.text('Outstanding: ' + money(bill.total - paid), 40, endY + 28);

  doc.save('bill-' + (bill.billNo || bill.id) + '.pdf');
  toast('PDF exported', 'ok');
}

/* ==========================
   EVENT HANDLERS
   ========================== */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action){
    /* navigation */
    case 'nav':
      nav(el.dataset.view, el.dataset.id ? { id: el.dataset.id } : {});
      return;
    case 'toggle-drawer': openDrawer(); return;
    case 'close-drawer':  closeDrawer(); return;
    case 'close-modal':   closeModal(); return;
    case 'confirm-yes':   closeConfirm(true); return;
    case 'confirm-no':    closeConfirm(false); return;

    /* customers */
    case 'add-customer':  openCustomerForm(null); return;
    case 'edit-customer': openCustomerForm(el.dataset.id); return;
    case 'open-customer': nav('customerDetail', { id: el.dataset.id }); return;
    case 'save-customer': await saveCustomerForm(); return;
    case 'toggle-customer': await toggleCustomer(el.dataset.id); return;

    /* companies */
    case 'add-company':  openCompanyForm(null); return;
    case 'edit-company': openCompanyForm(el.dataset.id); return;
    case 'save-company': await saveCompanyForm(); return;

    /* food items */
    case 'add-food':  openFoodForm(null); return;
    case 'edit-food': openFoodForm(el.dataset.id); return;
    case 'save-food': await saveFoodForm(); return;

    /* customer detail tabs */
    case 'cust-tab':
      state.ui.custTab = el.dataset.tab;
      render();
      return;

    /* daily entry */
    case 'entry-open': openEntryEditor(el.dataset.id, el.dataset.date); return;
    case 'open-entry-day': openEntryEditor(el.dataset.id, el.dataset.date); return;
    case 'entry-add-row': {
      const cont = $('#entryItems');
      if (!cont) return;
      cont.insertAdjacentHTML('beforeend', itemRowHtml(null));
      recalcEntryModal();
      return;
    }
    case 'entry-remove-row': {
      const row = el.closest('.item-row');
      const cont = $('#entryItems');
      if (row && cont){
        row.remove();
        if (!cont.querySelector('.item-row')) cont.insertAdjacentHTML('beforeend', itemRowHtml(null));
        recalcEntryModal();
      }
      return;
    }
    case 'entry-save':   await saveEntryFromModal(); return;
    case 'entry-delete': {
      const ed = state.ui.editing;
      if (ed) await deleteEntry(ed.customerId, ed.date);
      return;
    }

    /* register */
    case 'reg-cell': openRegisterCell(el.dataset.id, el.dataset.date); return;
    case 'reg-edit': {
      const id = el.dataset.id, d = el.dataset.date;
      closeModal();
      setTimeout(() => openEntryEditor(id, d), 60);
      return;
    }
    case 'reg-delete': {
      const id = el.dataset.id, d = el.dataset.date;
      await deleteEntry(id, d);
      return;
    }
    case 'export-register-excel': await exportRegisterExcel(); return;
    case 'export-register-pdf':   await exportRegisterPDF(); return;

    /* payments */
    case 'add-payment': openPaymentForm(el.dataset.id || null); return;
    case 'save-payment': await savePaymentForm(); return;
    case 'delete-payment': {
      const id = el.dataset.id;
      const ok = await askConfirm('Delete this payment? This cannot be undone.', 'Delete');
      if (!ok) return;
      await dbDelete('payments', id);
      toast('Payment deleted', 'ok');
      await refresh();
      return;
    }

    /* bills */
    case 'gen-customer-bill': openBillGenerator('CUSTOMER'); return;
    case 'gen-company-bill':  openBillGenerator('COMPANY'); return;
    case 'create-bill':       await createBill(); return;
    case 'view-bill':         viewBill(el.dataset.id); return;
    case 'delete-bill': {
      const ok = await askConfirm('Delete this bill record? Payments linked to it stay.', 'Delete');
      if (!ok) return;
      await dbDelete('bills', el.dataset.id);
      closeModal();
      toast('Bill deleted', 'ok');
      await refresh();
      return;
    }
    case 'print-bill': window.print(); return;
    case 'pdf-bill':   await exportBillPDF(el.dataset.id); return;

    /* backup */
    case 'export-backup': exportBackup(); return;
    case 'save-folder':   await saveToFolder(); return;
    case 'load-folder':   await loadFromFolder(); return;
    case 'import-backup': importBackupFile(); return;
    case 'clear-all':     await clearAllData(); return;
    case 'seed-demo':     await seedDemoData(); return;
    case 'clear-demo':    await clearDemoData(); return;

    default: return;
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'custSearch'){ state.ui.custSearch = t.value; state.ui.focus = t.id; render(); return; }
  if (t.id === 'entrySearch'){ state.ui.entrySearch = t.value; state.ui.focus = t.id; render(); return; }
  if (t.id === 'regSearch'){ state.ui.regSearch = t.value; state.ui.focus = t.id; render(); return; }
  if (t.classList.contains('it-qty') || t.classList.contains('it-rate')){ recalcEntryModal(); return; }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;

  if (t.id === 'entryDate'){ state.ui.entryDate = t.value; render(); return; }
  if (t.id === 'entryCompany'){ state.ui.entryCompany = t.value; render(); return; }
  if (t.id === 'regMonth'){ state.ui.registerMonth = t.value || currentMonth(); render(); return; }
  if (t.id === 'regCompany'){ state.ui.registerCompany = t.value; render(); return; }
  if (t.id === 'custMonth'){ state.ui.custMonth = t.value || currentMonth(); render(); return; }
  if (t.id === 'payMonth'){ state.ui.payMonth = t.value || currentMonth(); render(); return; }

  if (t.id === 'repType'){ state.ui.report = t.value; render(); return; }
  if (t.id === 'repMonth'){ state.ui.reportMonth = t.value || currentMonth(); renderReportInto(); return; }
  if (t.id === 'repFrom'){ state.ui.reportFrom = t.value; renderReportInto(); return; }
  if (t.id === 'repTo'){ state.ui.reportTo = t.value; renderReportInto(); return; }
  if (t.id === 'repCustomer'){ state.ui.reportCustomer = t.value; renderReportInto(); return; }

  if (t.id === 'entryStatus'){ recalcEntryModal(); return; }

  if (t.classList.contains('it-food')){
    const row = t.closest('.item-row');
    if (row){
      const opt = t.selectedOptions[0];
      const rate = opt ? opt.dataset.rate : '';
      if (rate !== undefined && rate !== '') row.querySelector('.it-rate').value = rate;
      recalcEntryModal();
    }
    return;
  }
});

function renderReportInto(){
  const out = $('#reportOut');
  if (out) out.innerHTML = renderReport();
}

document.addEventListener('submit', async (ev) => {
  if (ev.target.id === 'settingsForm'){
    ev.preventDefault();
    const f = ev.target;
    await saveSettings({
      businessName: f.businessName.value.trim() || 'Barkat Tiffin Service',
      businessMobile: f.businessMobile.value.trim(),
      businessAddress: f.businessAddress.value.trim(),
      currency: f.currency.value.trim() || '₹',
      defaultTiffinRate: Number(f.defaultTiffinRate.value) || 0,
      registerEmpty: f.registerEmpty.value
    });
    toast('Settings saved', 'ok');
    render();
  }
});

/* ---------- FORM SAVERS ---------- */
async function saveCustomerForm(){
  const f = $('#customerForm');
  if (!f) return;
  if (!f.reportValidity()) return;
  const id = f.id.value || uid();
  const existing = f.id.value ? customerById(f.id.value) : null;
  const now = new Date().toISOString();
  const obj = {
    id,
    customerCode: f.customerCode.value.trim(),
    name: f.name.value.trim(),
    mobile: f.mobile.value.trim(),
    email: f.email.value.trim(),
    address: f.address.value.trim(),
    companyId: f.companyId.value || '',
    status: f.status.value,
    notes: f.notes.value.trim(),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
  await dbPut('customers', obj);
  closeModal();
  toast(existing ? 'Customer updated' : 'Customer added', 'ok');
  await refresh();
}

async function toggleCustomer(id){
  const c = customerById(id);
  if (!c) return;
  c.status = c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  c.updatedAt = new Date().toISOString();
  await dbPut('customers', c);
  toast('Customer ' + (c.status === 'ACTIVE' ? 'activated' : 'deactivated'), 'ok');
  await refresh();
}

async function saveCompanyForm(){
  const f = $('#companyForm');
  if (!f) return;
  if (!f.reportValidity()) return;
  const existing = f.id.value ? companyById(f.id.value) : null;
  const now = new Date().toISOString();
  const obj = {
    id: f.id.value || uid(),
    companyCode: f.companyCode.value.trim(),
    companyName: f.companyName.value.trim(),
    contactPerson: f.contactPerson.value.trim(),
    mobile: f.mobile.value.trim(),
    email: f.email.value.trim(),
    address: f.address.value.trim(),
    status: f.status.value,
    notes: f.notes.value.trim(),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
  await dbPut('companies', obj);
  closeModal();
  toast(existing ? 'Company updated' : 'Company added', 'ok');
  await refresh();
}

async function saveFoodForm(){
  const f = $('#foodForm');
  if (!f) return;
  if (!f.reportValidity()) return;
  const existing = f.id.value ? foodItemById(f.id.value) : null;
  const now = new Date().toISOString();
  const obj = {
    id: f.id.value || uid(),
    name: f.name.value.trim(),
    type: f.type.value,
    rate: Number(f.rate.value) || 0,
    status: f.status.value,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
  await dbPut('foodItems', obj);
  closeModal();
  toast(existing ? 'Food item updated' : 'Food item added', 'ok');
  await refresh();
}

async function savePaymentForm(){
  const f = $('#paymentForm');
  if (!f) return;
  if (!f.reportValidity()) return;
  const customer = customerById(f.customerId.value);
  if (!customer){ toast('Select a customer', 'err'); return; }
  const amount = Number(f.amount.value) || 0;
  if (amount <= 0){ toast('Enter a valid amount', 'err'); return; }

  const obj = {
    id: uid(),
    customerId: customer.id,
    companyId: customer.companyId || '',
    billId: f.billId.value || '',
    paymentDate: f.paymentDate.value || todayISO(),
    amount,
    paymentMode: f.paymentMode.value,
    reference: f.reference.value.trim(),
    notes: f.notes.value.trim(),
    createdAt: new Date().toISOString()
  };
  await dbPut('payments', obj);
  closeModal();
  toast('Payment recorded', 'ok');
  await refresh();
}

/* ==========================
   PWA HELPERS
   ========================== */
function injectManifest(){
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="34" fill="#0f766e"/><text x="96" y="130" font-size="110" font-family="sans-serif" text-anchor="middle" fill="#ffffff">B</text></svg>`;
    const iconUrl = 'data:image/svg+xml,' + encodeURIComponent(svg);
    const manifest = {
      name: state.data.settings.businessName || 'Barkat Tiffin Service',
      short_name: 'Barkat',
      start_url: '.',
      scope: '.',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#ffffff',
      theme_color: '#0f766e',
      icons: [
        { src: iconUrl, sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: iconUrl, sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }
      ]
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = URL.createObjectURL(blob);
    document.head.appendChild(link);
  } catch(e){ /* non fatal */ }
}

function registerServiceWorker(){
  if (!('serviceWorker' in navigator)) return;
  if (!location.protocol.startsWith('http')) return; // file:// cannot use SW
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* sw.js is optional — the app still works, just without full offline caching */
    });
  });
}

/* ==========================
   INITIALIZATION
   ========================== */
async function init(){
  try {
    await openDB();
    await loadAll();
    _dirHandle = await getStoredDirHandle();
    injectManifest();
    render();
    registerServiceWorker();
  } catch(e){
    $('#view').innerHTML = `<div class="card empty">
      <div class="big">⚠️</div>
      <h3>Could not start</h3>
      <p>${esc(e.message || String(e))}</p>
      <p class="hint">IndexedDB may be blocked (private browsing?). Try a normal browser window.</p>
    </div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);