// public/totems-tab.js
// Totem management tab logic.
//
// Responsibilities:
//   - CRUD operations against /api/totems
//   - Renders totem list with edit/delete actions
//   - Inline create/edit form
//   - Emits 'totems:updated' custom event so qrcode-page.js can refresh the dropdown

const API = '/api/totems'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const totemList      = document.getElementById('totem-list')
const totemEmpty     = document.getElementById('totem-empty')
const formName       = document.getElementById('tf-name')
const formIp         = document.getElementById('tf-ip')
const formPort       = document.getElementById('tf-port')
const btnSaveTotem   = document.getElementById('btn-save-totem')
const btnCancelEdit  = document.getElementById('btn-cancel-edit')
const totemFormTitle = document.getElementById('totem-form-title')

// ── State ─────────────────────────────────────────────────────────────────────
let editingTotemId = null

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (res.status === 204) return null
  return res.json()
}

// ── Load & Render ──────────────────────────────────────────────────────────────

export async function loadTotems() {
  totemList.innerHTML = ''
  const totems = await apiFetch(API).catch(() => [])

  if (!totems || totems.length === 0) {
    totemEmpty.style.display = 'flex'
    dispatchTotemsUpdated([])
    return []
  }

  totemEmpty.style.display = 'none'

  for (const t of totems) {
    totemList.appendChild(buildTotemCard(t))
  }

  dispatchTotemsUpdated(totems)
  return totems
}

function buildTotemCard(totem) {
  const card = document.createElement('div')
  card.className   = 'totem-card'
  card.dataset.id  = totem._id

  card.innerHTML = `
    <div class="totem-card-header">
      <span class="totem-card-name">${escHtml(totem.name)}</span>
      <span class="totem-card-addr">${escHtml(totem.ip)}:${totem.udpPort}</span>
    </div>
    <div class="totem-card-actions">
      <button class="btn-icon btn-edit" title="Editar" aria-label="Editar totem ${escHtml(totem.name)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Editar
      </button>
      <button class="btn-icon btn-delete" title="Excluir" aria-label="Excluir totem ${escHtml(totem.name)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        Excluir
      </button>
    </div>
  `

  card.querySelector('.btn-edit').addEventListener('click', () => startEdit(totem))
  card.querySelector('.btn-delete').addEventListener('click', () => deleteTotem(totem._id, totem.name))

  return card
}

// ── Form Logic ────────────────────────────────────────────────────────────────

function startEdit(totem) {
  editingTotemId        = totem._id
  formName.value        = totem.name
  formIp.value          = totem.ip
  formPort.value        = totem.udpPort
  totemFormTitle.textContent = 'Editar Totem'
  btnCancelEdit.style.display = 'block'
  formName.focus()
}

function resetForm() {
  editingTotemId             = null
  formName.value             = ''
  formIp.value               = ''
  formPort.value             = ''
  totemFormTitle.textContent = 'Novo Totem'
  btnCancelEdit.style.display = 'none'
}

btnCancelEdit?.addEventListener('click', resetForm)

btnSaveTotem?.addEventListener('click', async () => {
  const name    = formName.value.trim()
  const ip      = formIp.value.trim()
  const udpPort = parseInt(formPort.value, 10)

  if (!name || !ip || !udpPort) {
    showTotemError('Preencha nome, IP e porta.')
    return
  }

  btnSaveTotem.disabled     = true
  btnSaveTotem.textContent  = 'Salvando...'

  try {
    if (editingTotemId) {
      await apiFetch(`${API}/${editingTotemId}`, {
        method: 'PUT',
        body:   JSON.stringify({ name, ip, udpPort }),
      })
    } else {
      await apiFetch(API, {
        method: 'POST',
        body:   JSON.stringify({ name, ip, udpPort }),
      })
    }

    resetForm()
    await loadTotems()
  } catch {
    showTotemError('Erro ao salvar totem.')
  } finally {
    btnSaveTotem.disabled    = false
    btnSaveTotem.textContent = 'Salvar Totem'
  }
})

// ── Delete ─────────────────────────────────────────────────────────────────────

async function deleteTotem(id, name) {
  const result = await Swal.fire({
    title:              `Excluir "${escHtml(name)}"?`,
    text:               'Esta ação não pode ser desfeita.',
    icon:               'warning',
    showCancelButton:   true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor:  '#64748b',
    confirmButtonText:  'Sim, excluir',
    cancelButtonText:   'Cancelar',
    reverseButtons:     true,
    focusCancel:        true,
  })

  if (!result.isConfirmed) return

  try {
    const res = await fetch(`${API}/${id}`, { method: 'DELETE' })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Erro ${res.status}`)
    }

    if (editingTotemId === id) resetForm()
    await loadTotems()

    Swal.fire({
      title:             'Excluído!',
      text:              `O totem "${name}" foi removido.`,
      icon:              'success',
      timer:             1800,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao excluir: ${err.message}`)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function showTotemError(msg) {
  const el = document.getElementById('totem-error')
  if (!el) return
  el.textContent    = msg
  el.style.display  = 'block'
  setTimeout(() => { el.style.display = 'none' }, 3500)
}

function dispatchTotemsUpdated(totems) {
  window.dispatchEvent(new CustomEvent('totems:updated', { detail: { totems } }))
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadTotems()
