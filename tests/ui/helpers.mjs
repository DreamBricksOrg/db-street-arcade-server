// tests/ui/helpers.mjs — shared setup for the UI specs.
import { OPERATOR_PASSWORD } from '../../playwright.config.mjs'

export const AUTH = { Authorization: `Bearer ${OPERATOR_PASSWORD}` }

export const uniq = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`

/** Creates a totem through the operator API; returns its document. */
export async function createTotem(request, fields) {
  const res = await request.post('/api/totems', { headers: AUTH, data: { maxPlayers: 2, ...fields } })
  if (res.status() !== 201) throw new Error(`create totem → ${res.status()} ${await res.text()}`)
  return res.json()
}

export async function deleteTotem(request, id) {
  await request.delete(`/api/totems/${id}`, { headers: AUTH }).catch(() => {})
}

/** Logs the page's browser context in (sets the sa_op cookie). */
export async function login(page) {
  const res = await page.request.post('/api/auth/login', { data: { password: OPERATOR_PASSWORD } })
  if (!res.ok()) throw new Error(`login → ${res.status()}`)
}
