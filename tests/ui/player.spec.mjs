// tests/ui/player.spec.mjs — the phone: scan → play / queue → called (mobile).
import { test, expect } from '@playwright/test'
import { AUTH, createTotem, deleteTotem } from './helpers.mjs'

let totem
test.beforeAll(async ({ request }) => {
  totem = await createTotem(request, { name: 'UI Player', ip: '127.0.0.1', udpPort: 19993, maxPlayers: 1 })
})
test.afterAll(async ({ request }) => deleteTotem(request, totem._id))
// One slot (maxPlayers 1): every test starts with it free.
test.beforeEach(async ({ request }) => {
  await request.post(`/api/totems/${totem._id}/end-session`, { headers: AUTH, data: {} })
  await request.post(`/api/totems/${totem._id}/queue/clear`, { headers: AUTH })
})

test('escanear com vaga livre abre o controle conectado', async ({ page }) => {
  await page.goto(`/play/totem?id=${totem._id}`)
  await expect(page).toHaveURL(/\/play\/[0-9a-f-]{36}$/)
  await expect(page.locator('#conn')).toHaveText('Conectado')
  for (const b of ['A', 'B', 'X', 'Y']) await expect(page.getByRole('button', { name: new RegExp(`^${b} `) })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Cima/ })).toBeVisible()
})

test('com o totem cheio entra na fila e é chamado quando a vaga libera', async ({ browser, request }) => {
  const first = await browser.newContext({ ...test.info().project.use })
  const second = await browser.newContext({ ...test.info().project.use })
  const p1 = await first.newPage()
  const p2 = await second.newPage()

  await p1.goto(`/play/totem?id=${totem._id}`)
  await expect(p1.locator('#conn')).toHaveText('Conectado')

  await p2.goto(`/play/totem?id=${totem._id}`)
  await expect(p2.getByRole('heading', { name: 'Você está na fila' })).toBeVisible()
  await expect(p2.locator('#queue-pos')).toHaveText('1')
  await expect(p2.locator('#queue-me')).toContainText(/Hoje você é \S+ \S+/)
  await expect(p2.getByRole('button', { name: 'Me avise quando for a minha vez' })).toBeVisible()

  // Operator ends player 1 → player 2 is called and the controller opens
  const sid = p1.url().split('/play/')[1]
  expect((await request.post(`/api/sessions/${sid}/end`, { headers: AUTH })).ok()).toBe(true)
  await expect(p1.getByRole('heading', { name: 'Fim de jogo' })).toBeVisible()
  await expect(p1.getByRole('link', { name: 'Jogar novamente' })).toBeVisible()
  await expect(p2.getByRole('heading', { name: 'É a sua vez!' })).toBeVisible({ timeout: 10_000 })
  await expect(p2).toHaveURL(/\/play\/[0-9a-f-]{36}$/, { timeout: 10_000 })
  await expect(p2.locator('#conn')).toHaveText('Conectado')

  await first.close()
  await second.close()
})

test('QR inválido mostra o erro com o mascote e o botão de tentar de novo', async ({ page }) => {
  await page.goto('/play/totem?id=00000000-0000-0000-0000-000000000000')
  await expect(page.getByRole('heading', { name: 'Não deu para entrar' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible()
})

test('totem pausado: quem escaneia vê o aviso de pausa', async ({ page, request }) => {
  await request.post(`/api/totems/${totem._id}/pause`, { headers: AUTH, data: { paused: true } })
  try {
    await page.goto(`/play/totem?id=${totem._id}`)
    await expect(page.getByRole('heading', { name: 'Totem em pausa' })).toBeVisible()
  } finally {
    await request.post(`/api/totems/${totem._id}/pause`, { headers: AUTH, data: { paused: false } })
  }
})
