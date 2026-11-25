// Grupo de amigos: cada uno comparte sus tareas marcadas como "compartidas"
// y ve qué ha cumplido el resto. Datos en Firebase Firestore (plan gratuito).
import CONFIG from './firebase-config.js';

const A = window.App;
const CDN = 'https://www.gstatic.com/firebasejs/10.12.2/';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let fb = null;                 // { db, fs }
let me = null;                 // uid de Firebase (anónimo)
let status = 'idle';           // idle | noconfig | loading | ready | error
let errMsg = '';
let members = [], cheers = [], unsub = [];
let view = 'hoy';
let pushTimer = null;
let busy = false;

/* ---------- estilos propios ---------- */
document.head.insertAdjacentHTML('beforeend', `<style>
.av{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-weight:800;color:#fff;flex:none;font-size:16px}
.mem{background:var(--surface);border-radius:var(--r);padding:12px 14px;margin-bottom:10px}
.mem .hd{display:flex;align-items:center;gap:10px}
.mem .hd b{font-size:16px}
.mem .hd small{display:block;color:var(--muted);font-size:12px}
.mt{display:flex;align-items:center;gap:10px;padding:7px 0 0 4px;font-size:15px}
.mt .e{width:24px;text-align:center}
.mt .n{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt .o{color:var(--muted);font-size:13px}
.mini{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;flex:none}
.mini.y{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.mini svg{width:12px;height:12px}
.cheer{border-radius:999px;padding:7px 12px;background:var(--surface2);font-weight:700;font-size:14px}
.cheer.done{opacity:.45}
.rk{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
.rk:last-child{border:0}
.rk .pos{width:26px;text-align:center;font-size:20px;font-weight:800}
.code{font:800 22px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em}
</style>`);

/* ---------- utilidades ---------- */
const g = () => A.state().group || null;
const rerender = () => { if (A.tab() === 'grupo') A.render(); };
const genCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const colorOf = id => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 48%)`; };
const doneOn = (m, k, id) => !!m.log?.[k]?.[id]?.done;
const optOn = (m, k, id) => m.log?.[k]?.[id]?.option || '';
function ago(ts) {
  const d = ts?.toDate?.(); if (!d) return '';
  const s = (Date.now() - d) / 1000;
  if (s < 90) return 'activo ahora';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}
const seenKey = 'obligacions.cheers.seen';
function markSeen(id) {
  try { const s = JSON.parse(localStorage.getItem(seenKey) || '[]'); if (s.includes(id)) return false;
    s.push(id); localStorage.setItem(seenKey, JSON.stringify(s.slice(-200))); return true; } catch { return false; }
}

/* ---------- conexión ---------- */
async function boot() {
  if (!CONFIG) { status = 'noconfig'; rerender(); return; }
  status = 'loading'; errMsg = ''; rerender();
  try {
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(CDN + 'firebase-app.js'), import(CDN + 'firebase-auth.js'), import(CDN + 'firebase-firestore.js')]);
    const app = initializeApp(CONFIG);
    const au = auth.getAuth(app);
    let db;
    try { db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() }); }   // funciona sin conexión
    catch { db = fs.getFirestore(app); }
    fb = { db, fs };
    let user = await new Promise(res => { const off = auth.onAuthStateChanged(au, u => { off(); res(u); }); });
    if (!user) user = (await auth.signInAnonymously(au)).user;
    me = user.uid;
    status = 'ready';
    if (g()?.code) connect();
  } catch (e) {
    status = 'error';
    errMsg = navigator.onLine === false ? 'Sin conexión. El grupo necesita internet la primera vez.' : (e.message || String(e));
  }
  rerender();
}

function stop() { unsub.forEach(f => f()); unsub = []; members = []; cheers = []; }

async function connect() {
  const code = g()?.code; if (!code || !fb) return;
  stop();
  const { fs, db } = fb;
  try { await pushNow(); }                     // primero existir como miembro (lo exigen las reglas)
  catch (e) { errMsg = e.message; rerender(); return; }
  unsub.push(fs.onSnapshot(fs.collection(db, 'groups', code, 'members'), s => {
    members = s.docs.map(d => ({ uid: d.id, ...d.data() })); rerender();
  }, e => { errMsg = e.message; rerender(); }));
  const weekAgo = A.keyOf(A.addDays(new Date(), -8));
  unsub.push(fs.onSnapshot(fs.query(fs.collection(db, 'groups', code, 'cheers'), fs.where('day', '>=', weekAgo)), s => {
    cheers = s.docs.map(d => d.data());
    for (const ch of s.docChanges()) {
      const c = ch.doc.data();
      if (ch.type === 'added' && c.to === me && c.day === A.todayKey() && markSeen(ch.doc.id)) A.toast(`👏 ${c.fromName} te anima`);
    }
    rerender();
  }, () => {}));
}

/* Lo que se sube: solo tareas compartidas, sin notas, últimos ~2 meses */
function payload() {
  const S = A.state();
  const tasks = S.tasks.filter(t => t.shared !== false);
  const ids = new Set(tasks.map(t => t.id));
  const from = A.keyOf(A.addDays(new Date(), -62));
  // "hecho" según el tipo de tarea (marcar, cantidad o dejar de)
  const log = {}, tk = A.todayKey();
  for (let d = A.parse(from); A.keyOf(d) <= tk; d = A.addDays(d, 1)) {
    const k = A.keyOf(d);
    for (const t of tasks) {
      if (!A.applies(t, k) || !A.isDone(k, t.id)) continue;
      (log[k] ??= {})[t.id] = { done: true, option: S.log[k]?.[t.id]?.option || null };
    }
  }
  void ids;
  return {
    name: g().name,
    tasks: tasks.map(t => ({ id: t.id, name: t.name, emoji: t.emoji || '', type: t.type, days: t.days || [],
      date: t.date || null, start: t.start, end: t.end || null, target: t.target || null })),
    log, updatedAt: fb.fs.serverTimestamp(),
  };
}
function pushNow() {
  if (!fb || !me || !g()?.code) return Promise.resolve();
  const { fs, db } = fb; return fs.setDoc(fs.doc(db, 'groups', g().code, 'members', me), payload()); }

/* ---------- acciones ---------- */
function setGroup(v) { const S = A.state(); if (v) S.group = v; else delete S.group; A.save(); }

async function createGroup(name) {
  const { fs, db } = fb;
  for (let i = 0; i < 5; i++) {
    const code = genCode();
    try { await fs.setDoc(fs.doc(db, 'groups', code), { createdAt: fs.serverTimestamp(), createdBy: me }); }
    catch { continue; }                           // código ya usado: probar otro
    setGroup({ code, name }); await connect(); return;
  }
  throw new Error('No se pudo crear el grupo');
}
async function joinGroup(name, raw) {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) throw new Error('El código tiene 6 caracteres');
  const { fs, db } = fb;
  const snap = await fs.getDoc(fs.doc(db, 'groups', code));
  if (!snap.exists()) throw new Error('No hay ningún grupo con ese código');
  setGroup({ code, name }); await connect();
}
async function leaveGroup() {
  const { fs, db } = fb;
  try { await fs.deleteDoc(fs.doc(db, 'groups', g().code, 'members', me)); } catch {}
  stop(); setGroup(null); rerender();
}
async function cheer(to) {
  const { fs, db } = fb, day = A.todayKey();
  try {
    await fs.setDoc(fs.doc(db, 'groups', g().code, 'cheers', `${day}_${me}_${to}`),
      { from: me, fromName: g().name, to, day, at: fs.serverTimestamp() });
    A.toast('👏 ¡Ánimo enviado!');
  } catch { A.toast('Ya le has animado hoy'); }
}
async function share() {
  const code = g().code;
  const url = location.origin + location.pathname + '?grupo=' + code;
  const text = `Únete a mi grupo en Obligacions para motivarnos 💪\nCódigo: ${code}`;
  try { if (navigator.share) { await navigator.share({ title: 'Obligacions', text, url }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); A.toast('Enlace copiado'); } catch { A.toast('Código: ' + code); }
}

/* ---------- vistas ---------- */
function vSetup() {
  if (status === 'noconfig') return `<h1>Grupo</h1><p class="sub">Comparte tu progreso con amigos</p>
    <div class="card"><p style="margin:0">👥 El grupo todavía no está activado en esta copia de la app.</p>
    <p style="color:var(--muted);font-size:14px;margin:8px 0 0">Falta conectarla a Firebase (gratis). Mientras tanto, todo lo demás funciona.</p></div>`;
  if (status === 'loading' || status === 'idle') return `<h1>Grupo</h1><div class="empty card">Conectando…</div>`;
  if (status === 'error') return `<h1>Grupo</h1><div class="card"><p style="margin:0 0 12px">No se pudo conectar.</p>
    <p style="color:var(--muted);font-size:13px;margin:0 0 12px">${A.esc(errMsg)}</p><button class="pill primary" data-g="retry">Reintentar</button></div>`;
  const inv = A.inviteCode || '';
  const name = A.state().profileName || '';
  return `<h1>Grupo</h1><p class="sub">Motivaos viendo lo que cumple cada uno</p>
    <div class="card">
      <label class="f" style="margin-top:0">Tu nombre (lo verán tus amigos)</label>
      <input class="inp" id="gname" maxlength="20" placeholder="Ej. Adri" value="${A.esc(name)}">
      ${inv ? '' : `<button class="pill primary" data-g="create" style="width:100%;padding:14px;margin-top:14px">Crear un grupo nuevo</button>
      <div style="text-align:center;color:var(--muted);font-size:13px;margin:14px 0 0">o únete al de un amigo</div>`}
      <label class="f">Código del grupo</label>
      <input class="inp code" id="gcode" maxlength="6" placeholder="K7PX2M" value="${A.esc(inv)}" autocapitalize="characters" autocomplete="off" style="text-transform:uppercase;text-align:center">
      <button class="pill ${inv ? 'primary' : ''}" data-g="join" style="width:100%;padding:14px;margin-top:12px">Unirme</button>
    </div>
    <p style="color:var(--muted);font-size:13px;margin:12px 4px">Solo se comparten las tareas marcadas como «Compartida» y qué opción elegiste. Tus notas y tareas privadas no salen de tu móvil.</p>`;
}

function memberToday(m) {
  const k = A.todayKey();
  const dn = (kk, id) => doneOn(m, kk, id);
  // primero las fijas de hoy, luego los objetivos semanales
  const ts = (m.tasks || []).filter(t => A.applies(t, k)).sort((a, b) => A.isFlex(a) - A.isFlex(b));
  const st = A.dayStats(k, m.tasks || [], dn);
  const isMe = m.uid === me;
  const got = cheers.filter(c => c.to === m.uid && c.day === k);
  const sent = cheers.some(c => c.from === me && c.to === m.uid && c.day === k);
  const rows = ts.map(t => {
    const y = doneOn(m, k, t.id), o = optOn(m, k, t.id);
    let extra = o ? ` <span class="o">· ${A.esc(o)}</span>` : '';
    if (A.isFlex(t)) { const c = A.weekCount(t, k, dn), tg = A.targetOf(t);
      extra += ` <span class="o" style="${c >= tg ? 'color:var(--accent);font-weight:700' : ''}">· ${c}/${tg} semana${c >= tg ? ' ✓' : ''}</span>`; }
    return `<div class="mt"><span class="e">${t.emoji || '•'}</span><span class="n">${A.esc(t.name)}${extra}</span>
      <span class="mini ${y ? 'y' : ''}">${y ? A.CHECK : ''}</span></div>`;
  }).join('');
  return `<div class="mem"><div class="hd">
      <span class="av" style="background:${colorOf(m.uid)}">${A.esc((m.name || '?')[0].toUpperCase())}</span>
      <div style="flex:1;min-width:0"><b>${A.esc(m.name || 'Sin nombre')}${isMe ? ' <span style="color:var(--muted);font-weight:500">(tú)</span>' : ''}</b>
        <small>${st.total ? `${st.done} de ${st.total} hoy` : ts.length ? 'Día libre de fijas' : 'Nada para hoy'}${got.length ? ` · 👏 ${got.length}` : ''}${!isMe && ago(m.updatedAt) ? ' · ' + ago(m.updatedAt) : ''}</small></div>
      ${isMe ? '' : `<button class="cheer ${sent ? 'done' : ''}" data-g="cheer" data-to="${m.uid}">👏${sent ? '' : ' Animar'}</button>`}
    </div>${rows}</div>`;
}

// Cada uno se mide contra SU plan: si tu amigo va 3 veces por semana y tú cada día,
// los dos podéis llegar al 100%.
function weekStats(m) {
  const ws = A.startOfWeek(new Date()), tk = A.todayKey();
  const dn = (k, id) => doneOn(m, k, id);
  const sc = A.weekScore(m.tasks || [], dn, ws);
  let perfect = 0;
  for (let i = 0; i < 7; i++) {
    const k = A.keyOf(A.addDays(ws, i)); if (k > tk) break;
    const s = A.dayStats(k, m.tasks || [], dn);
    if (s.total && s.done === s.total) perfect++;
  }
  return { ...sc, pct: sc.pct ?? 0, perfect };
}

function vWeek() {
  const rows = members.map(m => ({ m, s: weekStats(m) }))
    .sort((a, b) => b.s.pct - a.s.pct || b.s.done - a.s.done);
  const medal = i => ['🥇', '🥈', '🥉'][i] || `<span style="font-size:15px;color:var(--muted)">${i + 1}</span>`;
  return `<div class="card" style="padding:4px 14px">${rows.map(({ m, s }, i) => `
    <div class="rk"><span class="pos">${medal(i)}</span>
      <span class="av" style="background:${colorOf(m.uid)};width:32px;height:32px;font-size:14px">${A.esc((m.name || '?')[0].toUpperCase())}</span>
      <div style="flex:1;min-width:0">
        <div class="row"><b style="flex:1">${A.esc(m.name || '')}${m.uid === me ? ' (tú)' : ''}</b><b>${Math.round(s.pct * 100)}%</b></div>
        <div class="bar"><i style="width:${s.pct * 100}%;background:${colorOf(m.uid)}"></i></div>
        <div class="chips">${s.per.map(p => `<span class="chip">${p.t.emoji || '•'} ${p.d}/${p.n}${p.flex ? ' sem.' : ''}${p.flex && p.d >= p.n ? ' ✓' : ''}</span>`).join('')}
          ${s.perfect ? `<span class="chip">⭐ ${s.perfect} ${s.perfect === 1 ? 'día perfecto' : 'días perfectos'}</span>` : ''}</div>
      </div></div>`).join('') || '<div class="empty">Aún no hay nadie.</div>'}</div>
    <p style="color:var(--muted);font-size:13px;margin:10px 4px">Cada uno se mide con su propio plan (cada día, días fijos o X veces por semana). Hoy solo suma lo ya hecho, y los objetivos semanales se reparten a lo largo de la semana, así nadie pierde puntos antes de tiempo.</p>`;
}

function vGroup() {
  const sorted = [...members].sort((a, b) => (b.uid === me) - (a.uid === me) || (a.name || '').localeCompare(b.name || ''));
  const myCheers = cheers.filter(c => c.to === me && c.day === A.todayKey());
  return `<div class="row"><div><h1>Grupo</h1><p class="sub">${members.length} ${members.length === 1 ? 'persona' : 'personas'} · código <b>${g().code}</b></p></div>
      <span class="spacer"></span><button class="pill primary" data-g="share">Invitar</button></div>
    ${myCheers.length ? `<div class="card" style="margin-bottom:12px">👏 Hoy te han animado: <b>${myCheers.map(c => A.esc(c.fromName)).join(', ')}</b></div>` : ''}
    <div class="seg" style="margin-bottom:14px"><button data-g="view" data-v="hoy" class="${view === 'hoy' ? 'on' : ''}">Hoy</button>
      <button data-g="view" data-v="semana" class="${view === 'semana' ? 'on' : ''}">Ranking semana</button></div>
    ${errMsg ? `<div class="card" style="color:var(--miss);font-size:13px;margin-bottom:10px">${A.esc(errMsg)}</div>` : ''}
    ${!members.length ? '<div class="empty card">Conectando con el grupo…</div>' : view === 'hoy' ? sorted.map(memberToday).join('') : vWeek()}
    ${members.length === 1 ? `<div class="card" style="text-align:center;color:var(--muted);font-size:14px">Estás solo de momento. Pulsa «Invitar» y pásales el enlace a tus amigos.</div>` : ''}
    <div style="text-align:center;margin-top:24px"><button class="pill" data-g="leave" style="color:var(--miss)">Salir del grupo</button></div>`;
}

/* ---------- API para index.html ---------- */
window.Group = {
  enabled: !!CONFIG,
  render(el) { el.innerHTML = status === 'ready' && g()?.code ? vGroup() : vSetup(); },
  schedulePush() {
    if (status !== 'ready' || !g()?.code) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushNow().catch(e => { errMsg = e.message; }), 1200);
  },
};

document.getElementById('app').addEventListener('click', async e => {
  const b = e.target.closest('[data-g]'); if (!b || busy) return;
  const act = b.dataset.g;
  const nameOf = () => {
    const n = document.getElementById('gname')?.value.trim();
    if (!n) { A.toast('Escribe tu nombre'); document.getElementById('gname')?.focus(); return null; }
    A.state().profileName = n; return n;
  };
  try {
    busy = true;
    if (act === 'retry') await boot();
    else if (act === 'create') { const n = nameOf(); if (n) { b.textContent = 'Creando…'; await createGroup(n); delete A.inviteCode; } }
    else if (act === 'join') { const n = nameOf(); if (n) { b.textContent = 'Uniéndome…'; await joinGroup(n, document.getElementById('gcode').value); delete A.inviteCode; A.toast('¡Dentro del grupo!'); } }
    else if (act === 'view') view = b.dataset.v;
    else if (act === 'cheer') await cheer(b.dataset.to);
    else if (act === 'share') await share();
    else if (act === 'leave') { if (confirm('¿Salir del grupo? Tus amigos dejarán de verte.')) await leaveGroup(); }
  } catch (err) { A.toast(err.message || 'Error'); }
  finally { busy = false; rerender(); }
});

// Sin Firebase configurado, la función Grupo queda oculta
if (!CONFIG) {
  document.querySelector('nav.tabs [data-tab="grupo"]')?.remove();
  if (A.tab() === 'grupo') A.goTab('hoy');
}
boot();
// Al volver a la app, refrescar "hace X min" y subir lo pendiente
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { window.Group.schedulePush(); rerender(); } });
rerender();
