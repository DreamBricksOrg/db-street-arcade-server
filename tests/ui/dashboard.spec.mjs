// tests/ui/dashboard.spec.mjs — operator login and dashboard (desktop).
import { test, expect } from '@playwright/test'
import { OPERATOR_PASSWORD } from '../../playwright.config.mjs'
import { AUTH, createTotem, deleteTotem, login, uniq } from './helpers.mjs'

const created = []
test.afterAll(async ({ request }) => {
  for (const id of created) await deleteTotem(request, id)
})

test('login: painel fechado, senha errada avisa, senha certa entra, sair volta ao login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)

  const senha = page.getByRole('textbox', { name: 'Senha' })
  await senha.fill('errada')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('alert')).toContainText('Senha incorreta')

  await senha.fill(OPERATOR_PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('heading', { name: 'Totens', level: 1 })).toBeVisible()

  await page.getByRole('button', { name: 'Sair do painel' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get('/api/totems')).status()).toBe(401)
})

test('cadastrar, editar (chave do jogo) e excluir um totem pelo painel', async ({ page }) => {
  await login(page)
  await page.goto('/')
  const name = uniq('UI Cabine')

  await page.getByRole('button', { name: 'Adicionar totem' }).first().click()
  const form = page.getByRole('dialog', { name: 'Novo totem' })
  await form.getByLabel('Nome do totem').fill(name)
  await form.getByLabel('Jogo para incorporar').selectOption('snake')
  await form.getByLabel(/Endereço do totem físico/).fill('127.0.0.1:19995')
  await form.getByRole('button', { name: 'Salvar totem' }).click()
  await expect(page.locator('.db-toast')).toContainText('Totem criado')

  const card = page.locator('article.totem', { hasText: name })
  await expect(card).toBeVisible()
  created.push(await card.getAttribute('data-id'))
  await expect(card.locator('[data-status]')).toContainText('Livre')

  // Physical totems show their game key in the edit dialog
  await card.getByRole('button', { name: `Editar ${name}` }).click()
  const edit = page.getByRole('dialog', { name: 'Editar totem' })
  const key = edit.locator('#tf-key')
  await expect(key).toHaveText(/^[\w-]{24}$/)
  const oldKey = await key.textContent()

  // New key: confirm, then the dialog reopens with a different key
  await edit.getByRole('button', { name: 'Gerar nova chave' }).click()
  await page.getByRole('dialog', { name: 'Gerar uma nova chave?' }).getByRole('button', { name: 'Gerar nova chave' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Nova chave gerada')
  await expect(key).toHaveText(/^[\w-]{24}$/)
  expect(await key.textContent()).not.toBe(oldKey)
  await edit.getByRole('button', { name: 'Cancelar' }).click()

  // Clear queue goes through the confirm dialog
  await card.getByRole('button', { name: `Limpar fila de ${name}` }).click()
  await page.getByRole('dialog', { name: `Limpar a fila de "${name}"?` }).getByRole('button', { name: 'Limpar fila' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Fila limpa')

  // Delete goes through the confirm dialog
  await card.getByRole('button', { name: `Excluir ${name}` }).click()
  await page.getByRole('dialog', { name: `Excluir "${name}"?` }).getByRole('button', { name: 'Excluir totem' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Totem excluído')
  await expect(card).toHaveCount(0)
  created.pop()
})

test('ao vivo: quem entra no totem aparece no card e nos números sem recarregar', async ({ page, request }) => {
  const totem = await createTotem(request, { name: uniq('UI Live'), ip: '127.0.0.1', udpPort: 19994 })
  created.push(totem._id)
  await login(page)
  await page.goto('/')
  const card = page.locator(`article.totem[data-id="${totem._id}"]`)
  await expect(card.locator('[data-status]')).toContainText('Livre')
  const before = Number(await page.locator('#st-playing').textContent())

  const join = await request.post(`/api/totems/${totem._id}/queue/join`, { data: { playerId: uniq('ui_p') } })
  expect(join.ok()).toBe(true)

  await expect(card.locator('[data-status]')).toContainText('1/2 no totem', { timeout: 5000 })
  await expect(page.locator('#st-playing')).toHaveText(String(before + 1))
})

test('histórico abre com os indicadores e troca de período', async ({ page, request }) => {
  const totem = await createTotem(request, { name: uniq('UI Hist'), game: 'snake' })
  created.push(totem._id)
  await login(page)
  await page.goto('/')
  await page.getByRole('button', { name: `Histórico de ${totem.name}` }).click()
  const dialog = page.getByRole('dialog', { name: 'Histórico' })
  await expect(dialog.getByText('Partidas', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Nenhuma partida neste período.')).toBeVisible()
  // The segmented control's radio sits transparent over its label text
  await dialog.getByRole('radio', { name: '7 dias' }).check()
  await expect(dialog.getByRole('radio', { name: '7 dias' })).toBeChecked()
  await expect(dialog.getByText('Espera média na fila')).toBeVisible()
})

test('API de operação exige login', async ({ request }) => {
  expect((await request.get('/api/totems')).status()).toBe(401)
  expect((await request.get('/api/totems', { headers: AUTH })).status()).toBe(200)
})
