// public/dashboard-views.js
// The dashboard sections besides "Totens": Evento (every totem together),
// Apelidos (anonymous player names), Usuários and Atividade (admin only).
// Navigation is hash based (#evento) so reload and the back button keep the
// section. Helpers come from dashboard.js.

import { apiFetch, toast, confirmAction, escHtml, icon, renderHistory, rankingList, fmtDuration } from '/dashboard.js'

const $ = (id) => document.getElementById(id)

const TITLES = { totens: 'Totens', evento: 'Evento', apelidos: 'Apelidos', usuarios: 'Usuários', atividade: 'Atividade' }
const ADMIN_VIEWS = new Set(['usuarios', 'atividade'])

let me = null          // { id, username, name, role } or null (auth off → dev operator)

const isAdmin = () => me?.role === 'admin'

// ── Who is logged in ──────────────────────────────────────────────────────────

async function loadMe() {
  const res = await fetch('/api/auth/me').then(r => r.json()).catch(() => null)
  me = res?.user ?? null
  $('btn-logout').hidden = !res?.authEnabled
  if (me) {
    $('me-name').textContent = me.name || me.username
    $('live').title = `${me.name} (${me.username}) · ${me.role === 'admin' ? 'administrador' : 'operador'}`
  }
  for (const el of document.querySelectorAll('[data-admin]')) el.hidden = !isAdmin()
}

$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  location.href = '/login'
})

// ── Navigation ────────────────────────────────────────────────────────────────

const loaders = {
  evento: loadEvent,
  apelidos: loadNicknames,
  usuarios: loadUsers,
  atividade: () => loadAudit(),
}

function show(view) {
  if (!TITLES[view] || (ADMIN_VIEWS.has(view) && !isAdmin())) view = 'totens'
  for (const el of document.querySelectorAll('.view[data-view]')) el.hidden = el.dataset.view !== view
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== view
  for (const a of document.querySelectorAll('.nav__item[data-view]')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  }
  $('view-title').textContent = TITLES[view]
  document.title = `Street Arcade — ${TITLES[view]}`
  loaders[view]?.()
}

window.addEventListener('hashchange', () => show(location.hash.slice(1)))

// ── Evento ────────────────────────────────────────────────────────────────────

const eventBody = $('event-body')

async function loadEvent() {
  const range = document.querySelector('input[name="event-range"]:checked')?.value ?? '24h'
  $('event-csv').href = `/api/sessions.csv?range=${range}`
  eventBody.setAttribute('aria-busy', 'true')
  if (!eventBody.childElementCount) eventBody.innerHTML = '<p class="q-empty">Carregando…</p>'
  try {
    const [s, ranking] = await Promise.all([
      apiFetch(`/api/stats?range=${range}&tz=${new Date().getTimezoneOffset()}`),
      apiFetch(`/api/ranking?range=${range}&limit=10`).catch(() => []),
    ])
    const maxPlays = Math.max(1, ...s.byTotem.map(t => t.plays))
    const byTotem = s.byTotem.length
      ? `<ul class="rank">${s.byTotem.map(t => `
          <li class="rank__row rank__row--totem">
            <span class="rank__name" title="${escHtml(t.name)}">${escHtml(t.name)}</span>
            <span class="rank__bar"><span style="width:${(t.plays / maxPlays) * 100}%"></span></span>
            <span class="rank__n">${t.plays}</span>
            <span class="rank__sub">${t.avgWaitMs != null ? `espera ${fmtDuration(t.avgWaitMs)}` : ''}</span>
          </li>`).join('')}</ul>`
      : '<p class="q-empty">Nenhum totem cadastrado.</p>'

    const card = document.createElement('div')
    card.className = 'db-card event-card'
    eventBody.replaceChildren(card)
    renderHistory(s, card, `
      <div class="stats-cols">
        <section class="stats-sec"><h3 class="stats-sec__title">Partidas por totem</h3>${byTotem}</section>
        <section class="stats-sec"><h3 class="stats-sec__title">Melhores pontuações</h3>${rankingList(ranking, { showTotem: true })}</section>
      </div>`)
  } catch (err) {
    eventBody.innerHTML = `<div class="db-callout db-callout--danger">${icon('alert')}<span>Não deu para carregar o evento: ${escHtml(err.message)}</span></div>`
  } finally {
    eventBody.removeAttribute('aria-busy')
  }
}

for (const r of document.querySelectorAll('input[name="event-range"]')) r.addEventListener('change', loadEvent)

// ── Apelidos ──────────────────────────────────────────────────────────────────

const nickAnimals = $('nick-animals')
const nickAdjectives = $('nick-adjectives')
const nickError = $('nick-error')

const lines = (text) => text.split('\n').map(s => s.trim()).filter(Boolean)

function countLabel() {
  $('nick-animals-n').textContent = `(${lines(nickAnimals.value).length})`
  $('nick-adjectives-n').textContent = `(${lines(nickAdjectives.value).length})`
}

function renderExamples(examples) {
  const ul = $('nick-examples')
  ul.replaceChildren(...(examples ?? []).map(name => {
    const li = document.createElement('li')
    li.className = 'nick-chip'
    li.textContent = name
    return li
  }))
}

function fillNicknames(data) {
  nickAnimals.value = data.animals.join('\n')
  nickAdjectives.value = data.adjectives.join('\n')
  countLabel()
  if (data.examples) renderExamples(data.examples)
  const when = data.updatedAt ? new Date(data.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : null
  $('nick-meta').textContent = data.isDefault
    ? 'Usando as listas padrão.'
    : `Alterado${data.updatedBy ? ` por ${data.updatedBy}` : ''}${when ? ` em ${when}` : ''}.`
}

async function loadNicknames() {
  nickError.hidden = true
  const admin = isAdmin()
  nickAnimals.readOnly = nickAdjectives.readOnly = !admin
  $('nick-save').hidden = $('nick-reset').hidden = !admin
  $('nick-readonly').hidden = admin
  try {
    fillNicknames(await apiFetch('/api/settings/nicknames'))
  } catch (err) {
    showNickError(`Não deu para carregar as listas: ${err.message}`)
  }
}

function showNickError(msg) {
  nickError.querySelector('span').textContent = msg
  nickError.hidden = false
}

async function saveNicknames(body) {
  nickError.hidden = true
  $('nick-save').disabled = true
  try {
    await apiFetch('/api/settings/nicknames', { method: 'PUT', body: JSON.stringify(body) })
    fillNicknames(await apiFetch('/api/settings/nicknames'))
    toast(body.reset ? 'Listas padrão restauradas' : 'Listas salvas', { message: 'Valem para quem entrar na fila a partir de agora.' })
  } catch (err) {
    showNickError(err.message)
  } finally {
    $('nick-save').disabled = false
  }
}

$('nick-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const animals = lines(nickAnimals.value)
  const adjectives = lines(nickAdjectives.value)
  if (!animals.length || !adjectives.length) return showNickError('As duas listas precisam ter pelo menos um item.')
  if (animals.length > 200 || adjectives.length > 200) return showNickError('Cada lista aceita até 200 itens.')
  saveNicknames({ animals, adjectives })
})

$('nick-reset').addEventListener('click', async () => {
  const ok = await confirmAction({
    title: 'Voltar às listas padrão?',
    message: 'Os bichos e adjetivos que você incluiu ou tirou se perdem. Quem já está jogando mantém o apelido.',
    confirmLabel: 'Voltar ao padrão',
  })
  if (ok) saveNicknames({ reset: true })
})

$('nick-shuffle').addEventListener('click', async () => {
  const data = await apiFetch('/api/settings/nicknames').catch(() => null)
  if (data) renderExamples(data.examples)
})

nickAnimals.addEventListener('input', countLabel)
nickAdjectives.addEventListener('input', countLabel)

// ── Usuários ──────────────────────────────────────────────────────────────────

const usersBody = $('users-body')
const userDialog = $('userDialog')
const userError = $('user-error')
let users = []
let editingUser = null

const ROLE_LABEL = { admin: 'Administrador', operator: 'Operador' }

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

async function loadUsers() {
  try {
    users = await apiFetch('/api/users')
  } catch (err) {
    usersBody.innerHTML = `<tr><td colspan="5">${escHtml(err.message)}</td></tr>`
    return
  }
  const rows = [
    `<tr class="is-builtin">
      <td>Administrador</td><td class="db-mono">admin</td><td>${ROLE_LABEL.admin}</td>
      <td><span class="db-hint">senha do servidor</span></td><td></td>
    </tr>`,
    ...users.map(u => `
      <tr${u.disabled ? ' class="is-off"' : ''}>
        <td>${escHtml(u.name)}${u.disabled ? ' <span class="db-badge">Desativado</span>' : ''}${u.id === me?.id ? ' <span class="db-badge db-badge--brand">Você</span>' : ''}</td>
        <td class="db-mono">${escHtml(u.username)}</td>
        <td>${ROLE_LABEL[u.role] ?? escHtml(u.role)}</td>
        <td>${fmtWhen(u.lastLoginAt)}</td>
        <td class="table__actions">
          <button class="db-icon-btn" type="button" data-edit-user="${escHtml(u.id)}" data-tip="Editar" aria-label="Editar ${escHtml(u.name)}"><svg><use href="#i-edit"/></svg></button>
          ${u.id === me?.id ? '' : `<button class="db-icon-btn db-icon-btn--danger" type="button" data-delete-user="${escHtml(u.id)}" data-tip="Excluir" aria-label="Excluir ${escHtml(u.name)}"><svg><use href="#i-trash"/></svg></button>`}
        </td>
      </tr>`),
  ]
  usersBody.innerHTML = rows.join('')
  if (!users.length) {
    usersBody.insertAdjacentHTML('beforeend', '<tr><td colspan="5" class="table__empty">Nenhum usuário além do admin. Crie um para cada pessoa da equipe.</td></tr>')
  }
}

usersBody.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit-user]')
  const del = e.target.closest('[data-delete-user]')
  if (edit) openUserDialog(users.find(u => u.id === edit.dataset.editUser))
  if (del) {
    const u = users.find(x => x.id === del.dataset.deleteUser)
    if (!u) return
    const ok = await confirmAction({
      title: `Excluir "${u.name}"?`,
      message: 'A pessoa sai do painel na hora. O que ela fez continua no registro de atividade.',
      confirmLabel: 'Excluir usuário',
    })
    if (!ok) return
    try {
      await apiFetch(`/api/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' })
      toast('Usuário excluído', { message: u.name })
      loadUsers()
    } catch (err) {
      toast('Não deu para excluir', { tone: 'danger', message: err.message })
    }
  }
})

function openUserDialog(user = null) {
  editingUser = user
  userError.hidden = true
  $('user-form-title').textContent = user ? 'Editar usuário' : 'Novo usuário'
  $('uf-name').value = user?.name ?? ''
  $('uf-username').value = user?.username ?? ''
  $('uf-username').disabled = Boolean(user)
  $('uf-role').value = user?.role ?? 'operator'
  $('uf-role').disabled = user?.id === me?.id
  $('uf-password').value = ''
  $('uf-password-opt').textContent = user ? '(deixe vazio para manter)' : ''
  $('uf-active-row').hidden = !user || user.id === me?.id
  $('uf-active').checked = !user?.disabled
  userDialog.showModal()
  $('uf-name').focus()
}

$('btn-new-user').addEventListener('click', () => openUserDialog())

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  userError.hidden = true
  const fail = (msg, field) => {
    userError.querySelector('span').textContent = msg
    userError.hidden = false
    field?.focus()
  }
  const name = $('uf-name').value.trim()
  const username = $('uf-username').value.trim().toLowerCase()
  const password = $('uf-password').value
  if (!name) return fail('Digite o nome da pessoa.', $('uf-name'))
  if (!editingUser && !/^[a-z0-9._-]{3,32}$/.test(username)) {
    return fail('Usuário: 3 a 32 caracteres, só letras minúsculas, números, ponto, hífen e sublinhado.', $('uf-username'))
  }
  if ((!editingUser || password) && password.length < 10) return fail('A senha precisa ter pelo menos 10 caracteres.', $('uf-password'))

  const body = { name, role: $('uf-role').value }
  if (password) body.password = password
  if (editingUser && editingUser.id !== me?.id) body.disabled = !$('uf-active').checked
  if (!editingUser) body.username = username
  if (editingUser?.id === me?.id) delete body.role

  $('btn-save-user').disabled = true
  try {
    if (editingUser) await apiFetch(`/api/users/${encodeURIComponent(editingUser.id)}`, { method: 'PUT', body: JSON.stringify(body) })
    else await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) })
    userDialog.close('saved')
    toast(editingUser ? 'Usuário atualizado' : 'Usuário criado', { message: editingUser ? name : `Entra com "${username}" e a senha que você definiu.` })
    loadUsers()
  } catch (err) {
    fail(err.message)
  } finally {
    $('btn-save-user').disabled = false
  }
})

// ── Atividade ─────────────────────────────────────────────────────────────────

const auditList = $('audit-list')
const auditMore = $('audit-more')
const AUDIT_PAGE = 50
let auditOldest = null

/** Plain-language description of an audit row. */
function describeAction(row) {
  const d = row.details ?? {}
  const named = d.name ? ` "${d.name}"` : ''
  switch (row.action) {
    case 'auth.login':         return 'Entrou no painel'
    case 'auth.logout':        return 'Saiu do painel'
    case 'auth.login_failed':  return `Tentativa de entrada com senha errada (${d.username ?? 'admin'})`
    case 'totem.pause':        return d.paused ? 'Pausou um totem' : 'Retomou um totem'
    case 'user.create':        return `Criou o usuário${d.username ? ` ${d.username}` : named}`
    case 'user.update':        return `Editou um usuário${d.disabled === true ? ' (desativou)' : d.disabled === false ? ' (reativou)' : ''}`
    case 'user.delete':        return 'Excluiu um usuário'
    case 'settings.nicknames': return d.reset ? 'Restaurou os apelidos padrão' : 'Alterou as listas de apelidos'
  }
  const route = `${row.method} ${row.url}`
  const known = {
    'POST /api/totems': `Criou o totem${named}`,
    'PUT /api/totems/:id': `Editou o totem${named}`,
    'DELETE /api/totems/:id': 'Excluiu um totem',
    'POST /api/totems/:id/game-key': 'Gerou nova chave do jogo',
    'POST /api/totems/:id/queue/clear': 'Limpou uma fila',
    'DELETE /api/totems/:id/queue/:playerId': 'Tirou um jogador da fila',
    'POST /api/totems/:id/end-session': d.playerId ? 'Encerrou a partida de um jogador' : 'Encerrou todas as partidas de um totem',
    'POST /api/sessions/:id/end': 'Encerrou uma partida',
    'POST /api/sessions/:id/players/:playerId/kick': 'Expulsou um jogador',
    'DELETE /api/sessions/:id': 'Apagou uma sessão',
  }
  return known[route] ?? route
}

function auditRow(row) {
  const li = document.createElement('li')
  li.className = 'audit__row'
  if (row.action === 'auth.login_failed') li.dataset.tone = 'warn'
  const when = new Date(row.at)
  const time = document.createElement('time')
  time.className = 'audit__when'
  time.dateTime = row.at
  time.textContent = when.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const who = document.createElement('span')
  who.className = 'audit__who'
  who.textContent = row.name || row.username || 'Desconhecido'
  const what = document.createElement('span')
  what.className = 'audit__what'
  what.textContent = describeAction(row)
  li.append(time, who, what)
  const totemId = row.target?.id
  if (totemId && String(row.url ?? '').startsWith('/api/totems')) {
    const t = document.createElement('span')
    t.className = 'audit__target db-mono'
    t.textContent = String(totemId).slice(0, 8)
    t.title = String(totemId)
    li.appendChild(t)
  }
  return li
}

async function loadAudit({ append = false } = {}) {
  const q = new URLSearchParams({ limit: String(AUDIT_PAGE) })
  const user = $('audit-user').value
  const action = $('audit-action').value
  if (user) q.set('username', user)
  if (action) q.set('action', action)
  if (append && auditOldest) q.set('before', auditOldest)
  auditMore.disabled = true
  try {
    const rows = await apiFetch(`/api/audit?${q}`)
    if (!append) auditList.replaceChildren()
    for (const r of rows) auditList.appendChild(auditRow(r))
    auditOldest = rows.at(-1)?.at ?? auditOldest
    auditMore.hidden = rows.length < AUDIT_PAGE
    if (!auditList.childElementCount) {
      auditList.innerHTML = '<li class="audit__empty">Nada registrado com esses filtros.</li>'
    }
    if (!append) fillAuditUsers()
  } catch (err) {
    auditList.innerHTML = `<li class="audit__empty">${escHtml(err.message)}</li>`
  } finally {
    auditMore.disabled = false
  }
}

async function fillAuditUsers() {
  const sel = $('audit-user')
  if (sel.options.length > 1) return
  const list = await apiFetch('/api/users').catch(() => [])
  for (const u of [{ username: 'admin', name: 'Administrador' }, ...list]) {
    const o = document.createElement('option')
    o.value = u.username
    o.textContent = `${u.name} (${u.username})`
    sel.appendChild(o)
  }
}

$('audit-user').addEventListener('change', () => loadAudit())
$('audit-action').addEventListener('change', () => loadAudit())
auditMore.addEventListener('click', () => loadAudit({ append: true }))

// ── Init ──────────────────────────────────────────────────────────────────────
await loadMe()
show(location.hash.slice(1) || 'totens')
