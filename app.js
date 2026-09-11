(() => {
  'use strict';

  const cfg = window.PROPERTY_MANAGER_CONFIG || {};
  const hasConfig = /^https:\/\/[^\s/]+\.supabase\.co$/.test(String(cfg.supabaseUrl || '').trim()) &&
    String(cfg.supabaseKey || '').trim().length > 20 &&
    !/YOUR-|PLACEHOLDER|CHANGE-ME/i.test(String(cfg.supabaseKey || ''));
  const supa = hasConfig && window.supabase ? window.supabase.createClient(cfg.supabaseUrl.trim(), cfg.supabaseKey.trim(), {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'property-manager-session'
    }
  }) : null;

  const state = {
    user: null,
    workspace: null,
    activeView: location.hash.slice(1) || 'dashboard',
    authMode: 'login',
    working: false,
    dataLoaded: false,
    filters: { tenantSearch: '', paymentYear: new Date().getFullYear(), paymentTenant: '', paymentStatus: 'all' }
  };

  const memory = {
    houses: [],
    tenants: [],
    payments: [],
    settings: { dueDay: 5, workspaceName: 'Property Manager' },
    revision: 0
  };

  const index = {
    paymentsByTenantMonth: new Map(),
    tenantById: new Map(),
    houseById: new Map()
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\'':'&#39;','"':'&quot;'}[c]));
  const money = n => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(Number(n || 0));
  const uid = (p='id') => `${p}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const nowIso = () => new Date().toISOString();
  const yearNow = () => new Date().getFullYear();
  const monthNow = () => new Date().getMonth() + 1;
  const formatDate = s => s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-KE',{day:'2-digit',month:'short',year:'numeric'}) : '—';

  const toast = (message, ok=true) => {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.style.background = ok ? '#26343c' : '#8a4c45';
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  };

  function setStatus(text, type='') {
    const t = $('#saveText'), d = $('#saveDot');
    if (t) t.textContent = text;
    if (d) d.className = `dot ${type}`;
  }

  function setLastSaved(value) {
    const el = $('#lastSaved');
    if (el) el.textContent = value || '—';
  }

  function rebuildIndexes() {
    index.paymentsByTenantMonth = new Map();
    index.tenantById = new Map(memory.tenants.map(t => [t.id, t]));
    index.houseById = new Map(memory.houses.map(h => [h.id, h]));
    for (const p of memory.payments) {
      const key = `${p.tenant_id || p.tenantId}|${p.rent_month || p.rentMonth}`;
      if (!index.paymentsByTenantMonth.has(key)) index.paymentsByTenantMonth.set(key, []);
      index.paymentsByTenantMonth.get(key).push(p);
    }
  }

  function localKey() {
    return state.user ? `pm-cache:${state.user.id}` : 'pm-cache:none';
  }

  function loadLocalSnapshot() {
    try {
      const raw = localStorage.getItem(localKey());
      if (!raw) return false;
      const p = JSON.parse(raw);
      memory.houses = Array.isArray(p.houses) ? p.houses : [];
      memory.tenants = Array.isArray(p.tenants) ? p.tenants : [];
      memory.payments = Array.isArray(p.payments) ? p.payments : [];
      memory.settings = { dueDay: 5, workspaceName: 'Property Manager', ...(p.settings || {}) };
      memory.revision = Number(p.revision || 0);
      rebuildIndexes();
      return true;
    } catch { return false; }
  }

  function saveLocalSnapshot() {
    if (!state.user) return;
    try {
      localStorage.setItem(localKey(), JSON.stringify({
        houses: memory.houses,
        tenants: memory.tenants,
        payments: memory.payments,
        settings: memory.settings,
        revision: memory.revision,
        cachedAt: nowIso()
      }));
    } catch {}
  }

  const DB_NAME = 'PropertyManagerOfflineQueue';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('outbox')) {
          const os = db.createObjectStore('outbox', { keyPath: 'id' });
          os.createIndex('workspace', 'workspaceId', { unique: false });
          os.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Offline database unavailable'));
    });
    return dbPromise;
  }

  async function idbPut(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put(item);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Queue write failed'));
    });
  }

  async function idbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Queue delete failed'));
    });
  }

  async function idbList(workspaceId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const idx = tx.objectStore('outbox').index('workspace');
      const req = idx.getAll(workspaceId);
      req.onsuccess = () => resolve((req.result || []).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt))));
      req.onerror = () => reject(req.error || new Error('Queue read failed'));
    });
  }

  let syncRunning = false;
  let syncAgain = false;
  let onlineHandlerBound = false;

  async function queueOperation(op) {
    if (!state.workspace) return;
    const item = {
      id: uid('op'),
      userId: state.user?.id || null,
      workspaceId: state.workspace.id,
      entity: op.entity,
      action: op.action,
      rowId: op.rowId,
      record: op.record || null,
      createdAt: nowIso()
    };
    await idbPut(item);
    setStatus(navigator.onLine ? 'Saving…' : 'Saved offline', navigator.onLine ? 'saving' : 'offline');
    saveLocalSnapshot();
    scheduleSync(0);
  }

  function scheduleSync(delay=250) {
    clearTimeout(scheduleSync.t);
    scheduleSync.t = setTimeout(() => flushOutbox(), delay);
  }

  function apiTable(entity) {
    const map = { houses:'property_manager_houses', tenants:'property_manager_tenants', payments:'property_manager_payments' };
    return map[entity];
  }

  async function applyQueuedOperation(op) {
    const table = apiTable(op.entity);
    if (!table) throw new Error('Unsupported offline operation');
    if (op.action === 'delete') {
      const { error } = await supa.from(table).delete().eq('id', op.rowId).eq('workspace_id', op.workspaceId);
      if (error) throw error;
      return;
    }
    const record = { ...(op.record || {}), workspace_id: op.workspaceId, updated_at: nowIso() };
    const { error } = await supa.from(table).upsert(record, { onConflict: 'id' });
    if (error) throw error;
  }

  async function flushOutbox() {
    if (!supa || !state.user || !state.workspace || !navigator.onLine) return;
    if (syncRunning) { syncAgain = true; return; }
    syncRunning = true;
    try {
      const items = await idbList(state.workspace.id);
      if (!items.length) {
        setStatus('Synced');
        return;
      }
      setStatus(`Syncing ${items.length}…`, 'saving');
      for (const op of items) {
        try {
          await withTimeout(applyQueuedOperation(op), 7000, 'Cloud save timed out');
          await idbDelete(op.id);
        } catch (e) {
          setStatus(navigator.onLine ? 'Sync pending' : 'Saved offline', navigator.onLine ? 'saving' : 'offline');
          console.warn('Sync pending', e);
          break;
        }
      }
      const remaining = await idbList(state.workspace.id);
      if (!remaining.length) {
        setStatus('Saved');
        setLastSaved(new Date().toLocaleString('en-KE'));
      }
    } finally {
      syncRunning = false;
      if (syncAgain) { syncAgain = false; scheduleSync(100); }
    }
  }

  async function clearWorkspaceQueue() {
    if (!state.workspace) return;
    const items = await idbList(state.workspace.id);
    for (const item of items) await idbDelete(item.id);
  }

  async function withTimeout(promise, ms, message='Request timed out') {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
  }

  async function ensureWorkspace(user) {
    const { data, error } = await withTimeout(
      supa.from('property_manager_workspaces').select('id,owner_id,name,due_day,created_at,updated_at').limit(1).maybeSingle(),
      7000,
      'Could not load your property workspace.'
    );
    if (error) throw error;
    if (data) {
      state.workspace = data;
      memory.settings.workspaceName = data.name || 'Property Manager';
      memory.settings.dueDay = Number(data.due_day || 5);
      return data;
    }
    const { data: created, error: createErr } = await withTimeout(
      supa.from('property_manager_workspaces').insert({ owner_id: user.id, name:'My Property', due_day:5 }).select('id,owner_id,name,due_day,created_at,updated_at').single(),
      7000,
      'Could not create your property workspace.'
    );
    if (createErr) throw createErr;
    state.workspace = created;
    memory.settings.workspaceName = created.name || 'My Property';
    memory.settings.dueDay = Number(created.due_day || 5);
    return created;
  }

  async function loadRemote(showBusy=true) {
    if (!supa || !state.user || !state.workspace || !navigator.onLine) return false;
    if (showBusy) setStatus('Loading…','saving');
    try {
      const [housesR, tenantsR, paymentsR] = await Promise.all([
        withTimeout(supa.from('property_manager_houses').select('*').eq('workspace_id', state.workspace.id).order('number'), 7000, 'Houses request timed out'),
        withTimeout(supa.from('property_manager_tenants').select('*').eq('workspace_id', state.workspace.id).order('name'), 7000, 'Tenants request timed out'),
        withTimeout(supa.from('property_manager_payments').select('*').eq('workspace_id', state.workspace.id).order('payment_date', { ascending:false }), 7000, 'Payments request timed out')
      ]);
      for (const r of [housesR,tenantsR,paymentsR]) if (r.error) throw r.error;
      memory.houses = housesR.data || [];
      memory.tenants = tenantsR.data || [];
      memory.payments = paymentsR.data || [];
      rebuildIndexes();
      saveLocalSnapshot();
      state.dataLoaded = true;
      setStatus('Synced');
      setLastSaved(new Date().toLocaleString('en-KE'));
      return true;
    } catch (e) {
      if (showBusy) setStatus('Offline','offline');
      throw e;
    }
  }

  async function firstLoadAfterLogin() {
    state.dataLoaded = false;
    const hadLocal = loadLocalSnapshot();
    if (hadLocal) { renderCurrentView(); setStatus('Using saved data'); }
    if (navigator.onLine) {
      try { await flushOutbox(); await loadRemote(true); }
      catch (e) { if (!hadLocal) throw e; setStatus('Offline','offline'); }
    } else if (!hadLocal) {
      throw new Error('No saved records are available offline yet. Connect to the internet for the first sign-in and data load.');
    }
  }

  function activeTenants() { return memory.tenants.filter(t => t.status !== 'moved_out'); }
  function activeHouses() { return memory.houses; }
  function vacantHouses() { return memory.houses.filter(h => !activeTenants().some(t => t.house_id === h.id)); }
  function houseByTenant(t) { return t ? index.houseById.get(t.house_id) : null; }
  function tenantById(id) { return index.tenantById.get(id); }
  function paymentsFor(tenantId, rentMonth) { return index.paymentsByTenantMonth.get(`${tenantId}|${rentMonth}`) || []; }
  function paidFor(tenantId, rentMonth) { return paymentsFor(tenantId, rentMonth).reduce((s,p)=>s+Number(p.amount||0),0); }

  function dueInfo(t, ym) {
    const [y,m] = ym.split('-').map(Number);
    const target = y*12 + (m-1);
    const startDate = new Date(`${t.move_in_date || `${y}-01-01`}T00:00:00`);
    const start = startDate.getFullYear()*12 + startDate.getMonth();
    if (target < start) return { state:'not_started', due:0, paid:paidFor(t.id,ym), balance:0 };
    if (t.status==='moved_out' && t.move_out_date) {
      const out = new Date(`${t.move_out_date}T00:00:00`);
      const outM = out.getFullYear()*12 + out.getMonth();
      if (target > outM) return { state:'not_applicable', due:0, paid:paidFor(t.id,ym), balance:0 };
    }
    const now = new Date();
    const curM = now.getFullYear();
    const curMonthIndex = curM*12 + now.getMonth();
    const dueDay = Number(memory.settings.dueDay || 5);
    const paid = paidFor(t.id, ym);
    const rent = Number(t.rent || 0);
    if (target > curMonthIndex) return { state:'upcoming', due:rent, paid, balance:0 };
    if (target === curMonthIndex && now.getDate() <= dueDay) return { state:'upcoming', due:rent, paid, balance:Math.max(0,0) };
    const balance = Math.max(0, rent - paid);
    const status = balance<=0 ? 'paid' : (paid>0 ? 'partial' : 'unpaid');
    return { state:status, due:rent, paid, balance };
  }

  function currentYm() { return `${yearNow()}-${String(monthNow()).padStart(2,'0')}`; }
  function monthLabel(ym) { return new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-KE',{month:'long',year:'numeric'}); }

  function tenantMonths(t, year) {
    const out=[];
    for(let m=1;m<=12;m++) out.push({ ym:`${year}-${String(m).padStart(2,'0')}`, ...dueInfo(t,`${year}-${String(m).padStart(2,'0')}`) });
    return out;
  }

  function dashboardMetrics() {
    const current = currentYm();
    let outstanding = 0, dueNow = 0, paidCurrent = 0;
    for (const t of activeTenants()) {
      const x = dueInfo(t,current);
      if (x.state === 'unpaid' || x.state === 'partial') outstanding += x.balance;
      if (x.state === 'unpaid' || x.state === 'partial') dueNow += x.balance;
      paidCurrent += Math.min(x.paid, x.due);
    }
    return { houses:memory.houses.length, occupied:memory.houses.length-vacantHouses().length, vacant:vacantHouses().length, tenants:activeTenants().length, outstanding, paidCurrent, dueNow };
  }

  function renderDashboard() {
    const m = dashboardMetrics();
    const query = state.filters.tenantSearch.trim().toLowerCase();
    const results = query ? memory.tenants.filter(t => [t.name,t.phone,index.houseById.get(t.house_id)?.number,t.statement_ref].some(v=>String(v||'').toLowerCase().includes(query))).slice(0,8) : [];
    const attention = activeTenants().map(t=>{const x=dueInfo(t,currentYm());return {...t,x};}).filter(x=>x.x.state==='unpaid'||x.x.state==='partial').sort((a,b)=>b.x.balance-a.x.balance).slice(0,8);
    $('#dashboard').innerHTML = `
      <div class="card">
        <div class="head"><div><h3>Quick search</h3><div class="muted">Search tenants by name, house number, phone, or statement reference.</div></div></div>
        <input class="search" id="dashboardSearch" value="${esc(state.filters.tenantSearch)}" placeholder="Search tenant, house number, phone…" autocomplete="off">
        <div class="search-results">${results.map(t=>`<div class="result"><div><strong>${esc(t.name)}</strong><div class="muted">${esc(index.houseById.get(t.house_id)?.number||'No house')} · ${esc(t.phone||'')} · ${esc(t.statement_ref||'')}</div></div><button class="btn small" data-action="tenant-ledger" data-id="${esc(t.id)}">View records</button></div>`).join('') || (query ? '<div class="muted" style="padding-top:10px">No matching tenant.</div>' : '')}</div>
      </div>
      <div class="stats">
        <div class="stat"><small>Active tenants</small><strong>${m.tenants}</strong><span>${m.occupied} occupied houses</span></div>
        <div class="stat"><small>Houses</small><strong>${m.houses}</strong><span>${m.vacant} vacant</span></div>
        <div class="stat"><small>Rent paid this month</small><strong>${money(m.paidCurrent)}</strong><span>Payments applied to current month</span></div>
        <div class="stat"><small>Outstanding</small><strong>${money(m.outstanding)}</strong><span>Only amounts already due</span></div>
        <div class="stat"><small>Rent due now</small><strong>${money(m.dueNow)}</strong><span>Based on due date ${memory.settings.dueDay}</span></div>
      </div>
      <div class="grid">
        <div class="card"><div class="head"><h3>Attention</h3><span class="badge">${attention.length} current balances</span></div>
          ${attention.map(t=>`<div class="result"><div><strong>${esc(t.name)}</strong><div class="muted">${esc(index.houseById.get(t.house_id)?.number||'')} · ${money(t.x.balance)} outstanding</div></div><button class="btn small" data-action="tenant-ledger" data-id="${esc(t.id)}">View</button></div>`).join('') || '<div class="muted">No current rent outstanding.</div>'}
        </div>
        <div class="card"><div class="head"><h3>Property snapshot</h3></div>
          <div class="summary"><div class="stat"><small>Occupied</small><strong>${m.occupied}</strong></div><div class="stat"><small>Vacant</small><strong>${m.vacant}</strong></div><div class="stat"><small>Moved out</small><strong>${memory.tenants.filter(t=>t.status==='moved_out').length}</strong></div><div class="stat"><small>Payments</small><strong>${memory.payments.length}</strong></div></div>
        </div>
      </div>`;
    const search = $('#dashboardSearch');
    search?.addEventListener('input', e=>{state.filters.tenantSearch=e.target.value; renderDashboard(); const s=$('#dashboardSearch'); if(s){s.focus();s.setSelectionRange(s.value.length,s.value.length);}});
  }

  function tenantForm(t={}) {
    const selected = t.house_id || '';
    const options = memory.houses.filter(h => !activeTenants().some(x=>x.house_id===h.id && x.id!==t.id)).map(h=>`<option value="${esc(h.id)}" ${selected===h.id?'selected':''}>${esc(h.number)}${h.type?` — ${esc(h.type)}`:''}</option>`).join('');
    return `<form data-form="tenant"><input type="hidden" name="id" value="${esc(t.id||'')}"><div class="form-grid">
      <div class="field"><label>Name</label><input name="name" required value="${esc(t.name||'')}"></div>
      <div class="field"><label>Phone</label><input name="phone" value="${esc(t.phone||'')}"></div>
      <div class="field"><label>House</label><select name="house_id" required><option value="">Select house</option>${options}</select></div>
      <div class="field"><label>Monthly rent</label><input name="rent" type="number" min="0" required value="${esc(t.rent??'')}"></div>
      <div class="field"><label>Move-in date</label><input name="move_in_date" type="date" required value="${esc(t.move_in_date||today())}"></div>
      <div class="field"><label>Status</label><select name="status"><option value="active" ${t.status!=='moved_out'?'selected':''}>Active</option><option value="moved_out" ${t.status==='moved_out'?'selected':''}>Moved out</option></select></div>
      <div class="field"><label>Move-out date</label><input name="move_out_date" type="date" value="${esc(t.move_out_date||'')}"></div>
      <div class="field"><label>Statement reference</label><input name="statement_ref" value="${esc(t.statement_ref||`TEN-${String(memory.tenants.length+1).padStart(3,'0')}`)}"></div>
    </div><div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save tenant</button></div></form>`;
  }

  function houseForm(h={}) { return `<form data-form="house"><input type="hidden" name="id" value="${esc(h.id||'')}"><div class="form-grid"><div class="field"><label>House number</label><input name="number" required value="${esc(h.number||'')}"></div><div class="field"><label>Type</label><input name="type" value="${esc(h.type||'')}"></div><div class="field"><label>Monthly rent</label><input name="rent" type="number" min="0" value="${esc(h.rent??'')}"></div></div><div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save house</button></div></form>`; }
  function paymentForm(p={}) { return `<form data-form="payment"><input type="hidden" name="id" value="${esc(p.id||'')}"><div class="form-grid"><div class="field"><label>Tenant</label><select name="tenant_id" required><option value="">Select tenant</option>${activeTenants().map(t=>`<option value="${esc(t.id)}" ${p.tenant_id===t.id?'selected':''}>${esc(t.name)} — ${esc(index.houseById.get(t.house_id)?.number||'')}</option>`).join('')}</select></div><div class="field"><label>Amount</label><input name="amount" type="number" min="1" required value="${esc(p.amount??'')}"></div><div class="field"><label>Payment date</label><input name="payment_date" type="date" required value="${esc(p.payment_date||today())}"></div><div class="field"><label>Rent month covered</label><input name="rent_month" type="month" required value="${esc(p.rent_month||currentYm())}"></div><div class="field"><label>Method</label><select name="method"><option ${p.method==='M-Pesa'?'selected':''}>M-Pesa</option><option ${p.method==='Cash'?'selected':''}>Cash</option><option ${p.method==='Bank'?'selected':''}>Bank</option><option ${p.method==='Other'?'selected':''}>Other</option></select></div><div class="field"><label>Reference</label><input name="reference" value="${esc(p.reference||'')}"></div></div><div class="notice">Future rent months can be paid in advance. The dashboard will not count future months as outstanding.</div><div class="form-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Save payment</button></div></form>`; }

  function modal(title, body) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = body; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); }

  function renderTenants() {
    const q = (state.filters.tenantSearch||'').toLowerCase();
    const rows = memory.tenants.filter(t=>[t.name,t.phone,t.statement_ref,index.houseById.get(t.house_id)?.number].some(v=>String(v||'').toLowerCase().includes(q)));
    $('#tenants').innerHTML=`<div class="card"><div class="head"><div><h3>Tenants</h3><div class="muted">Active and moved-out records are retained separately.</div></div><button class="btn primary" data-action="new-tenant">Add tenant</button></div><input class="search" id="tenantPageSearch" value="${esc(state.filters.tenantSearch)}" placeholder="Search tenants…"></div><div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Tenant</th><th>House</th><th>Rent</th><th>Status</th><th>Balance</th><th>Actions</th></tr></thead><tbody>${rows.map(t=>{const bal=tenantMonths(t,yearNow()).reduce((s,x)=>s+x.balance,0);return `<tr><td><strong>${esc(t.name)}</strong><div class="muted">${esc(t.phone||'')} · ${esc(t.statement_ref||'')}</div></td><td>${esc(index.houseById.get(t.house_id)?.number||'—')}</td><td>${money(t.rent)}</td><td><span class="status ${t.status==='moved_out'?'neutral':'paid'}">${t.status==='moved_out'?'Moved out':'Active'}</span></td><td>${money(bal)}</td><td><div class="mini-actions"><button class="btn small" data-action="tenant-ledger" data-id="${esc(t.id)}">Records</button><button class="btn small" data-action="edit-tenant" data-id="${esc(t.id)}">Edit</button>${t.status!=='moved_out'?`<button class="btn small" data-action="moveout" data-id="${esc(t.id)}">Move out</button>`:''}<button class="btn small danger" data-action="delete-tenant" data-id="${esc(t.id)}">Delete</button></div></td></tr>`;}).join('')||'<tr><td colspan="6" class="muted">No tenants found.</td></tr>'}</tbody></table></div></div>`;
    $('#tenantPageSearch').addEventListener('input', e=>{state.filters.tenantSearch=e.target.value;renderTenants();});
  }

  function renderHouses() {
    $('#houses').innerHTML=`<div class="card"><div class="head"><div><h3>Houses</h3><div class="muted">Occupancy updates automatically from active tenant assignments.</div></div><button class="btn primary" data-action="new-house">Add house</button></div><div class="table-wrap"><table class="table"><thead><tr><th>House</th><th>Type</th><th>Rent</th><th>Status</th><th>Tenant</th><th>Actions</th></tr></thead><tbody>${memory.houses.map(h=>{const t=activeTenants().find(x=>x.house_id===h.id);return `<tr><td><strong>${esc(h.number)}</strong></td><td>${esc(h.type||'—')}</td><td>${money(h.rent)}</td><td><span class="status ${t?'paid':'neutral'}">${t?'Occupied':'Vacant'}</span></td><td>${esc(t?.name||'—')}</td><td><div class="mini-actions"><button class="btn small" data-action="house-history" data-id="${esc(h.id)}">History</button><button class="btn small" data-action="edit-house" data-id="${esc(h.id)}">Edit</button><button class="btn small danger" data-action="delete-house" data-id="${esc(h.id)}">Delete</button></div></td></tr>`;}).join('')||'<tr><td colspan="6" class="muted">No houses yet.</td></tr>'}</tbody></table></div></div>`;
  }

  function renderPayments() {
    const y = Number(state.filters.paymentYear); const tenantId=state.filters.paymentTenant; const q=state.filters.paymentStatus;
    let rows = memory.payments.filter(p=>String(p.payment_date||'').startsWith(String(y)) || String(p.rent_month||'').startsWith(String(y)));
    if(tenantId) rows=rows.filter(p=>p.tenant_id===tenantId);
    if(q!=='all') rows=rows.filter(p=>{const t=tenantById(p.tenant_id);const x= t ? dueInfo(t,p.rent_month) : {state:'unpaid'};return q===x.state;});
    $('#payments').innerHTML=`<div class="card"><div class="head"><div><h3>Payments</h3><div class="muted">Recorded payments sync individually; offline changes remain queued until connected.</div></div><button class="btn primary" data-action="new-payment">Record payment</button></div><div class="filters"><select id="paymentYear" class="btn"><option value="${y}">${y}</option><option value="${y-1}">${y-1}</option><option value="${y+1}">${y+1}</option></select><select id="paymentTenant" class="btn"><option value="">All tenants</option>${activeTenants().map(t=>`<option value="${esc(t.id)}" ${tenantId===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select><select id="paymentStatus" class="btn"><option value="all" ${q==='all'?'selected':''}>All status</option><option value="paid" ${q==='paid'?'selected':''}>Paid</option><option value="partial" ${q==='partial'?'selected':''}>Partial</option><option value="unpaid" ${q==='unpaid'?'selected':''}>Unpaid</option></select></div><div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Tenant</th><th>Payment date</th><th>Rent month</th><th>Amount</th><th>Method</th><th>Reference</th><th>Actions</th></tr></thead><tbody>${rows.map(p=>{const t=tenantById(p.tenant_id);return `<tr><td>${esc(p.receipt_no||'—')}</td><td>${esc(t?.name||'Unknown')}</td><td>${formatDate(p.payment_date)}</td><td>${monthLabel(p.rent_month)}</td><td>${money(p.amount)}</td><td>${esc(p.method||'')}</td><td>${esc(p.reference||'—')}</td><td><div class="mini-actions"><button class="btn small" data-action="receipt" data-id="${esc(p.id)}">Receipt</button><button class="btn small" data-action="edit-payment" data-id="${esc(p.id)}">Edit</button><button class="btn small danger" data-action="delete-payment" data-id="${esc(p.id)}">Delete</button></div></td></tr>`;}).join('')||'<tr><td colspan="8" class="muted">No payments found.</td></tr>'}</tbody></table></div></div>`;
    $('#paymentYear').addEventListener('change',e=>{state.filters.paymentYear=Number(e.target.value);renderPayments();});
    $('#paymentTenant').addEventListener('change',e=>{state.filters.paymentTenant=e.target.value;renderPayments();});
    $('#paymentStatus').addEventListener('change',e=>{state.filters.paymentStatus=e.target.value;renderPayments();});
  }

  function renderArrears() {
    const rows=[]; const ym=currentYm();
    for(const t of activeTenants()){const x=dueInfo(t,ym);if(x.state==='unpaid'||x.state==='partial')rows.push({t,x});}
    rows.sort((a,b)=>b.x.balance-a.x.balance);
    $('#arrears').innerHTML=`<div class="card"><div class="head"><div><h3>Arrears</h3><div class="muted">Only rent that is already due is included. Future months are never counted here.</div></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Tenant</th><th>House</th><th>Month</th><th>Due</th><th>Paid</th><th>Outstanding</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.t.name)}</td><td>${esc(index.houseById.get(r.t.house_id)?.number||'')}</td><td>${monthLabel(ym)}</td><td>${money(r.x.due)}</td><td>${money(r.x.paid)}</td><td><strong>${money(r.x.balance)}</strong></td></tr>`).join('')||'<tr><td colspan="6" class="muted">No current arrears.</td></tr>'}</tbody></table></div></div>`;
  }

  function renderSettings() {
    $('#settings').innerHTML=`<div class="settings-grid"><div class="card"><div class="head"><h3>Property settings</h3></div><div class="field"><label>Property name</label><input id="settingName" value="${esc(memory.settings.workspaceName||'Property Manager')}"></div><div class="field"><label>Rent due day</label><select id="settingDueDay">${Array.from({length:28},(_,i)=>`<option value="${i+1}" ${Number(memory.settings.dueDay)===i+1?'selected':''}>${i+1}</option>`).join('')}</select></div><button class="btn primary" data-action="save-settings">Save settings</button><div class="small-note" style="margin-top:10px">A current month's rent becomes due only after the selected day has passed. Future months remain upcoming.</div></div><div class="card"><div class="head"><h3>Data tools</h3></div><button class="btn" data-action="backup">Download backup</button><label class="btn" style="display:inline-block;margin-top:8px">Restore backup<input id="restoreBackup" type="file" accept="application/json" style="display:none"></label><div class="small-note" style="margin-top:10px">Restoring replaces the current records in memory and queues the changes for cloud synchronization.</div></div></div>`;
    $('#restoreBackup')?.addEventListener('change', async e=>{const file=e.target.files?.[0];if(!file)return;try{const p=JSON.parse(await file.text());memory.houses=Array.isArray(p.houses)?p.houses:[];memory.tenants=Array.isArray(p.tenants)?p.tenants:[];memory.payments=Array.isArray(p.payments)?p.payments:[];memory.settings={...memory.settings,...(p.settings||{})};rebuildIndexes();saveLocalSnapshot();await queueFullState();renderCurrentView();toast('Backup restored');}catch(e){toast('Invalid backup file.',false);console.error(e);}});
  }

  function renderCurrentView() {
    const allowed=['dashboard','tenants','houses','payments','arrears','settings'];
    const v=allowed.includes(state.activeView)?state.activeView:'dashboard';
    $$('.view').forEach(x=>x.classList.remove('active'));
    $(`#${v}`)?.classList.add('active');
    $$('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.nav===v));
    $('#title').textContent = ({dashboard:'Dashboard',tenants:'Tenants',houses:'Houses',payments:'Payments',arrears:'Arrears',settings:'Settings'})[v];
    $('#brandName').textContent = memory.settings.workspaceName || 'Property Manager';
    if(v==='dashboard')renderDashboard(); else if(v==='tenants')renderTenants(); else if(v==='houses')renderHouses(); else if(v==='payments')renderPayments(); else if(v==='arrears')renderArrears(); else renderSettings();
  }

  function setView(v, replace=false){const allowed=['dashboard','tenants','houses','payments','arrears','settings'];v=allowed.includes(v)?v:'dashboard';state.activeView=v;if(replace)history.replaceState(null,'',`#${v}`);else if(location.hash!==`#${v}`)location.hash=v;renderCurrentView();}

  async function saveRecord(entity, record, originalId=null) {
    rebuildIndexes();
    const rowId = record.id;
    await queueOperation({entity, action:'upsert', rowId, record});
    toast('Saved');
    return originalId || rowId;
  }

  async function deleteRecord(entity, rowId) {
    await queueOperation({entity, action:'delete', rowId});
    toast('Deleted');
  }

  async function queueFullState() {
    // Convert backup restore into deterministic row operations.
    for (const h of memory.houses) await queueOperation({entity:'houses',action:'upsert',rowId:h.id,record:h});
    for (const t of memory.tenants) await queueOperation({entity:'tenants',action:'upsert',rowId:t.id,record:t});
    for (const p of memory.payments) await queueOperation({entity:'payments',action:'upsert',rowId:p.id,record:p});
    scheduleSync(0);
  }

  function nextReceiptNumber(existingId='') {
    const year=yearNow();
    const nums=memory.payments.map(p=>String(p.receipt_no||'')).filter(r=>r.startsWith(`REC-${year}-`)).map(r=>Number(r.split('-').pop())).filter(Number.isFinite);
    const next=(nums.length?Math.max(...nums):0)+1;
    return `REC-${year}-${String(next).padStart(4,'0')}`;
  }

  function receipt(paymentId) {
    const p=memory.payments.find(x=>x.id===paymentId); const t=tenantById(p?.tenant_id); const h=houseByTenant(t); if(!p||!t)return;
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.receipt_no||'Receipt')}</title><style>body{font-family:Arial;margin:40px;color:#263238}.box{max-width:680px;margin:auto;border:1px solid #ddd;padding:30px}h1{margin:0 0 6px}table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:10px;border-bottom:1px solid #eee}td:first-child{color:#666}.right{text-align:right}.total{font-size:20px;font-weight:700}</style></head><body><div class="box"><h1>Rent Payment Receipt</h1><div>${esc(memory.settings.workspaceName||'Property Manager')}</div><table><tr><td>Receipt</td><td class="right">${esc(p.receipt_no||'')}</td></tr><tr><td>Tenant</td><td class="right">${esc(t.name)}</td></tr><tr><td>House</td><td class="right">${esc(h?.number||'')}</td></tr><tr><td>Payment date</td><td class="right">${formatDate(p.payment_date)}</td></tr><tr><td>Rent month covered</td><td class="right">${monthLabel(p.rent_month)}</td></tr><tr><td>Method</td><td class="right">${esc(p.method||'')}</td></tr><tr><td>Reference</td><td class="right">${esc(p.reference||'—')}</td></tr><tr><td class="total">Amount</td><td class="right total">${money(p.amount)}</td></tr></table><p style="margin-top:28px;color:#666;font-size:12px">Generated from Property Manager.</p></div><script>window.print()<\/script></body></html>`;
    const w=window.open('','_blank','noopener,noreferrer'); if(!w){toast('Allow pop-ups to print the receipt.',false);return;}w.document.write(html);w.document.close();
  }

  function tenantLedger(tenantId) {
    const t=tenantById(tenantId);if(!t)return; const year=yearNow(); const rows=tenantMonths(t,year); const payments=memory.payments.filter(p=>p.tenant_id===tenantId && String(p.payment_date||'').startsWith(String(year))).sort((a,b)=>String(a.payment_date).localeCompare(String(b.payment_date)));
    const due=rows.reduce((s,x)=>s+x.due,0), paid=rows.reduce((s,x)=>s+Math.min(x.paid,x.due),0), outstanding=rows.reduce((s,x)=>s+x.balance,0);
    const body=`<div class="summary"><div class="stat"><small>Rent due</small><strong>${money(due)}</strong></div><div class="stat"><small>Paid</small><strong>${money(paid)}</strong></div><div class="stat"><small>Outstanding</small><strong>${money(outstanding)}</strong></div><div class="stat"><small>Status</small><strong>${t.status==='moved_out'?'Moved out':'Active'}</strong></div></div><div class="card" style="margin-top:14px"><div class="head"><div><h3>${esc(t.name)}</h3><div class="muted">${esc(index.houseById.get(t.house_id)?.number||'')} · ${esc(t.statement_ref||'')}</div></div><div class="mini-actions"><button class="btn small" data-action="download-ledger" data-id="${esc(t.id)}">Download CSV</button><button class="btn small" data-action="print-ledger" data-id="${esc(t.id)}">Print / PDF</button></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Month</th><th>Due</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${monthLabel(x.ym)}</td><td>${money(x.due)}</td><td>${money(x.paid)}</td><td>${money(x.balance)}</td><td><span class="status ${x.state}">${x.state==='upcoming'?'Not due yet':x.state==='not_started'?'Before move-in':x.state==='not_applicable'?'Not applicable':x.state}</span></td></tr>`).join('')}</tbody></table></div></div><div class="card"><div class="head"><h3>Payment transactions — ${year}</h3></div><div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Date</th><th>Month covered</th><th>Amount</th><th>Method</th><th>Reference</th></tr></thead><tbody>${payments.map(p=>`<tr><td>${esc(p.receipt_no||'')}</td><td>${formatDate(p.payment_date)}</td><td>${monthLabel(p.rent_month)}</td><td>${money(p.amount)}</td><td>${esc(p.method||'')}</td><td>${esc(p.reference||'—')}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No payment transactions this year.</td></tr>'}</tbody></table></div></div>`;
    modal(`${t.name} — Annual records`,body);
  }

  function ledgerRows(t, year) { return tenantMonths(t,year).map(x=>({tenant:t.name,statementRef:t.statement_ref||'',house:index.houseById.get(t.house_id)?.number||'',month:monthLabel(x.ym),due:x.due,paid:x.paid,balance:x.balance,status:x.state})); }
  function csvEscape(v){return `"${String(v??'').replace(/"/g,'""')}"`;}
  function downloadLedger(tenantId){const t=tenantById(tenantId);if(!t)return;const year=yearNow();const rows=ledgerRows(t,year);const header=['Tenant','Statement Reference','House','Month','Due','Paid','Balance','Status'];const csv=[header, ...rows.map(r=>[r.tenant,r.statementRef,r.house,r.month,r.due,r.paid,r.balance,r.status])].map(r=>r.map(csvEscape).join(',')).join('\n');const payments=memory.payments.filter(p=>p.tenant_id===tenantId && String(p.payment_date||'').startsWith(String(year))).sort((a,b)=>String(a.payment_date).localeCompare(String(b.payment_date)));const txHeader=['Receipt','Payment Date','Rent Month Covered','Amount','Method','Reference'];const tx=[txHeader,...payments.map(p=>[p.receipt_no,p.payment_date,p.rent_month,p.amount,p.method,p.reference])].map(r=>r.map(csvEscape).join(',')).join('\n');const blob=new Blob([csv+'\n\n'+tx],{type:'text/csv;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`tenant-${String(t.name).replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-${year}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
  function printLedger(tenantId){const t=tenantById(tenantId);if(!t)return;const year=yearNow();const rows=tenantMonths(t,year);const w=window.open('','_blank','noopener,noreferrer');if(!w){toast('Allow pop-ups to print.',false);return;}w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.name)} — ${year}</title><style>body{font-family:Arial;margin:35px;color:#263238}h1{margin-bottom:4px}p{color:#666}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}th{font-size:11px;text-transform:uppercase;color:#666}.right{text-align:right}</style></head><body><h1>${esc(t.name)} — ${year} payment record</h1><p>House: ${esc(index.houseById.get(t.house_id)?.number||'—')} · Statement: ${esc(t.statement_ref||'')}</p><table><thead><tr><th>Month</th><th>Due</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${monthLabel(x.ym)}</td><td>${money(x.due)}</td><td>${money(x.paid)}</td><td>${money(x.balance)}</td><td>${esc(x.state==='upcoming'?'Not due yet':x.state)}</td></tr>`).join('')}</tbody></table><script>window.print()<\/script></body></html>`);w.document.close();}

  function authErrorMessage(e){const m=String(e?.message||e||'');if(/invalid login credentials/i.test(m))return'Email or password is incorrect.';if(/email not confirmed/i.test(m))return'Your email has not been confirmed yet. Confirm it before signing in.';if(/failed to fetch|network|fetch/i.test(m))return'Cannot reach Supabase. Check your internet connection.';return m;}
  function showAuthError(m){const el=$('#authError');if(el){el.textContent=m;el.classList.remove('hidden');}}

  async function handleAuthSubmit(form){
    if(!supa){showAuthError('Supabase is not configured. Add the project URL and publishable/anon key to config.js.');return;}
    const email=$('#authEmail').value.trim(),pw=$('#authPassword').value,pw2=$('#authPassword2').value;
    if(state.authMode==='signup'&&pw!==pw2){showAuthError('Passwords do not match.');return;}
    $('#authSubmit').disabled=true;$('#authSubmit').textContent=state.authMode==='login'?'Signing in…':'Creating…';$('#authError').classList.add('hidden');
    try{
      if(state.authMode==='login'){
        const {data,error}=await withTimeout(supa.auth.signInWithPassword({email,password:pw}),10000,'Sign-in timed out. Check your internet connection.');
        if(error)throw error;
        state.user=data.user;
        await ensureWorkspace(state.user);
        await firstLoadAfterLogin();
      }else{
        const {data,error}=await withTimeout(supa.auth.signUp({email,password:pw}),10000,'Sign-up timed out.');
        if(error)throw error;
        if(data.session){state.user=data.user;await ensureWorkspace(state.user);await firstLoadAfterLogin();}
        else showAuthError('Account created. Check your email to confirm the account, then sign in.');
        return;
      }
      enterApp();
    }catch(e){console.error(e);state.user=null;showAuthError(authErrorMessage(e));}
    finally{$('#authSubmit').disabled=false;$('#authSubmit').textContent=state.authMode==='login'?'Sign in':'Create account';}
  }

  function enterApp(){
    $('#loginScreen').classList.add('hidden');$('#appShell').classList.remove('hidden');
    setView(state.activeView,true);renderCurrentView();
    if(!onlineHandlerBound){
      window.addEventListener('online',()=>{setStatus('Back online','saving');scheduleSync(0);});
      window.addEventListener('offline',()=>{setStatus('Offline','offline');});
      document.addEventListener('visibilitychange',()=>{if(!document.hidden) scheduleSync(0);});
      onlineHandlerBound=true;
    }
    scheduleSync(0);
  }

  async function logout(){
    try{await flushOutbox();}catch{}
    try{if(supa)await supa.auth.signOut({scope:'local'});}catch{}
    state.user=null;state.workspace=null;state.dataLoaded=false;memory.houses=[];memory.tenants=[];memory.payments=[];memory.revision=0;rebuildIndexes();
    clearTimeout(scheduleSync.t);saveLocalSnapshot();
    $('#appShell').classList.add('hidden');$('#loginScreen').classList.remove('hidden');setView('dashboard',true);$('#authPassword').value='';$('#authPassword2').value='';
  }

  document.addEventListener('click',async e=>{
    const tab=e.target.closest('[data-auth-tab]');if(tab){state.authMode=tab.dataset.authTab;$$('[data-auth-tab]').forEach(b=>b.classList.toggle('active',b===tab));$('#confirmPasswordField').classList.toggle('hidden',state.authMode!=='signup');$('#authSubmit').textContent=state.authMode==='login'?'Sign in':'Create account';$('#authError').classList.add('hidden');return;}
    const nav=e.target.closest('[data-nav]');if(nav){setView(nav.dataset.nav);return;}
    const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action,id=b.dataset.id;
    try{
      if(a==='sync'){if(!navigator.onLine){toast('You are offline. Local changes remain safe.',false);return;}await flushOutbox();await loadRemote(false);toast('Synced');}
      else if(a==='logout'){await logout();}
      else if(a==='close-modal'){closeModal();}
      else if(a==='new-house'){modal('Add house',houseForm());}
      else if(a==='edit-house'){modal('Edit house',houseForm(memory.houses.find(x=>x.id===id)||{}));}
      else if(a==='delete-house'){if(activeTenants().some(t=>t.house_id===id)){toast('Occupied houses cannot be deleted.',false);return;}if(confirm('Delete this house?')){memory.houses=memory.houses.filter(x=>x.id!==id);rebuildIndexes();await deleteRecord('houses',id);renderCurrentView();}}
      else if(a==='new-tenant'){if(!vacantHouses().length){toast('Add a vacant house first.',false);return;}modal('Add tenant',tenantForm());}
      else if(a==='edit-tenant'){modal('Edit tenant',tenantForm(memory.tenants.find(x=>x.id===id)||{}));}
      else if(a==='moveout'){const t=tenantById(id);modal('Move out tenant',tenantForm({...t,status:'moved_out',move_out_date:today()}));}
      else if(a==='delete-tenant'){if(confirm('Delete this tenant and all payment history?')){memory.payments.filter(p=>p.tenant_id===id).forEach(p=>deleteRecord('payments',p.id));memory.payments=memory.payments.filter(p=>p.tenant_id!==id);memory.tenants=memory.tenants.filter(t=>t.id!==id);rebuildIndexes();await deleteRecord('tenants',id);renderCurrentView();}}
      else if(a==='new-payment'){if(!activeTenants().length){toast('Add an active tenant first.',false);return;}modal('Record payment',paymentForm());}
      else if(a==='edit-payment'){modal('Edit payment',paymentForm(memory.payments.find(x=>x.id===id)||{}));}
      else if(a==='delete-payment'){if(confirm('Delete this payment?')){memory.payments=memory.payments.filter(x=>x.id!==id);rebuildIndexes();await deleteRecord('payments',id);renderCurrentView();}}
      else if(a==='receipt')receipt(id);
      else if(a==='tenant-ledger')tenantLedger(id);
      else if(a==='download-ledger')downloadLedger(id);
      else if(a==='print-ledger')printLedger(id);
      else if(a==='house-history'){const h=memory.houses.find(x=>x.id===id);const hist=memory.tenants.filter(t=>t.house_id===id).sort((a,b)=>String(a.move_in_date||'').localeCompare(String(b.move_in_date||'')));modal(`${esc(h?.number||'House')} — History`,`<div class="table-wrap"><table class="table"><thead><tr><th>Tenant</th><th>Move in</th><th>Move out</th><th>Status</th></tr></thead><tbody>${hist.map(t=>`<tr><td>${esc(t.name)}</td><td>${formatDate(t.move_in_date)}</td><td>${formatDate(t.move_out_date)}</td><td>${t.status==='moved_out'?'Moved out':'Active'}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No tenancy history.</td></tr>'}</tbody></table></div>`);}
      else if(a==='save-settings'){const name=$('#settingName').value.trim()||'Property Manager',dueDay=Number($('#settingDueDay').value||5);memory.settings.workspaceName=name;memory.settings.dueDay=dueDay;state.workspace.name=name;state.workspace.due_day=dueDay;renderCurrentView();await queueWorkspaceUpdate({name,due_day:dueDay});toast('Settings saved');}
      else if(a==='backup'){const payload={houses:memory.houses,tenants:memory.tenants,payments:memory.payments,settings:memory.settings};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`property-manager-backup-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
    }catch(err){console.error(err);toast(err.message||'Something went wrong.',false);}
  });

  async function queueWorkspaceUpdate(data){
    if(!state.workspace)return; const item={id:uid('op'),userId:state.user.id,workspaceId:state.workspace.id,entity:'workspace',action:'update',rowId:state.workspace.id,record:{...data},createdAt:nowIso()};await idbPut(item);saveLocalSnapshot();scheduleSync(0);
  }

  // Extend the queue applier for workspace updates.
  const originalApplyQueuedOperation = applyQueuedOperation;
  // Function declarations are hoisted; replace via closure wrapper not possible. Instead, patch the function reference by shadowing through helper.
  // The generic flush below will recognize workspace records.
  async function applyQueuedOperationPatched(op){
    if(op.entity==='workspace'){
      const {error}=await supa.from('property_manager_workspaces').update({...op.record,updated_at:nowIso()}).eq('id',op.workspaceId).eq('owner_id',state.user.id);if(error)throw error;return;
    }
    return originalApplyQueuedOperation(op);
  }
  // Patch lexical binding through a local function used by a new flush implementation.
  const oldFlushOutbox = flushOutbox;
  flushOutbox = async function patchedFlushOutbox(){
    if(!supa||!state.user||!state.workspace||!navigator.onLine)return;if(syncRunning){syncAgain=true;return;}syncRunning=true;try{const items=await idbList(state.workspace.id);if(!items.length){setStatus('Synced');return;}setStatus(`Syncing ${items.length}…`,'saving');for(const op of items){try{await withTimeout(applyQueuedOperationPatched(op),7000,'Cloud save timed out');await idbDelete(op.id);}catch(e){console.warn('Sync pending',e);setStatus(navigator.onLine?'Sync pending':'Saved offline',navigator.onLine?'saving':'offline');break;}}const remaining=await idbList(state.workspace.id);if(!remaining.length){setStatus('Saved');setLastSaved(new Date().toLocaleString('en-KE'));}}finally{syncRunning=false;if(syncAgain){syncAgain=false;scheduleSync(100);}}};

  document.addEventListener('submit',async e=>{
    const f=e.target;if(!f.dataset.form)return;e.preventDefault();const fd=new FormData(f);
    try{
      if(f.dataset.form==='house'){
        const id=String(fd.get('id')||''),number=String(fd.get('number')||'').trim();if(!number)throw new Error('House number is required.');if(memory.houses.some(h=>String(h.number).toLowerCase()===number.toLowerCase()&&h.id!==id))throw new Error('That house number already exists.');
        const old=memory.houses.find(h=>h.id===id);const h={id:id||uid('house'),number,type:String(fd.get('type')||'').trim(),rent:Number(fd.get('rent')||0)};const i=memory.houses.findIndex(x=>x.id===h.id);if(i>=0)memory.houses[i]=h;else memory.houses.push(h);rebuildIndexes();closeModal();renderCurrentView();await saveRecord('houses',h,old?.id);return;
      }
      if(f.dataset.form==='tenant'){
        const id=String(fd.get('id')||''),houseId=String(fd.get('house_id')||'');if(!houseId)throw new Error('Select a house.');const status=String(fd.get('status')||'active');if(status!=='moved_out'&&activeTenants().some(t=>t.house_id===houseId&&t.id!==id))throw new Error('That house is already occupied.');const old=memory.tenants.find(t=>t.id===id);if(old&&old.house_id!==houseId&&old.status!=='moved_out'){/* old house becomes vacant automatically */}
        const t={id:id||uid('tenant'),workspace_id:state.workspace.id,name:String(fd.get('name')||'').trim(),phone:String(fd.get('phone')||'').trim(),house_id:houseId,rent:Number(fd.get('rent')||0),move_in_date:String(fd.get('move_in_date')||today()),status,move_out_date:String(fd.get('move_out_date')||''),statement_ref:String(fd.get('statement_ref')||`TEN-${String(memory.tenants.length+1).padStart(3,'0')}`).trim()};if(!t.name)throw new Error('Tenant name is required.');if(status==='moved_out'&&!t.move_out_date)throw new Error('Enter a move-out date.');
        const i=memory.tenants.findIndex(x=>x.id===t.id);if(i>=0)memory.tenants[i]=t;else memory.tenants.push(t);rebuildIndexes();closeModal();renderCurrentView();await saveRecord('tenants',t,old?.id);return;
      }
      if(f.dataset.form==='payment'){
        const id=String(fd.get('id')||''),tenantId=String(fd.get('tenant_id')||'');if(!tenantId)throw new Error('Select a tenant.');const amount=Number(fd.get('amount')||0);if(amount<=0)throw new Error('Enter a valid payment amount.');const existing=memory.payments.find(p=>p.id===id);const p={id:id||uid('payment'),workspace_id:state.workspace.id,tenant_id:tenantId,amount,payment_date:String(fd.get('payment_date')||today()),rent_month:String(fd.get('rent_month')||currentYm()),method:String(fd.get('method')||''),reference:String(fd.get('reference')||'').trim(),receipt_no:existing?.receipt_no||nextReceiptNumber()};const i=memory.payments.findIndex(x=>x.id===p.id);if(i>=0)memory.payments[i]=p;else memory.payments.push(p);rebuildIndexes();closeModal();renderCurrentView();await saveRecord('payments',p,existing?.id);return;
      }
    }catch(err){console.error(err);toast(err.message||'Could not save.',false);}
  });

  $('#authForm').addEventListener('submit',e=>{e.preventDefault();handleAuthSubmit(e.target);});
  $('#resendConfirmation').addEventListener('click',async()=>{if(!supa)return;const email=$('#authEmail').value.trim();if(!email){showAuthError('Enter your email address first.');return;}try{const {error}=await withTimeout(supa.auth.resend({type:'signup',email}),10000,'Request timed out.');if(error)throw error;showAuthError('Confirmation email sent. Check your inbox.');}catch(e){showAuthError(authErrorMessage(e));}});
  window.addEventListener('hashchange',()=>{const v=location.hash.slice(1)||'dashboard';state.activeView=v;renderCurrentView();});
  window.addEventListener('beforeunload',()=>saveLocalSnapshot());

  if(!supa){showAuthError('Supabase is not configured. Open config.js and add your project URL and publishable/anon key.');$('#resendConfirmation').disabled=true;}
  else { setStatus('Ready'); }
})();
