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
  await expect(page.getByRole('alert')).toContainText('Usuário ou senha incorretos')

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

  // Pause: confirm, the card shows "Pausado"; resume needs no confirmation
  await card.getByRole('button', { name: `Pausar ${name}` }).click()
  await page.getByRole('dialog', { name: `Pausar "${name}"?` }).getByRole('button', { name: 'Pausar totem' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Totem pausado')
  await expect(card.getByText('Pausado')).toBeVisible()
  await card.getByRole('button', { name: `Retomar ${name}` }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Totem retomado')
  await expect(card.getByText('Pausado')).toHaveCount(0)

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

test('ajustes do jogo: formulário em vez de JSON, segundos na tela e o valor salvo no totem', async ({ page, request }) => {
  const totem = await createTotem(request, { name: uniq('UI Config'), game: 'snake' })
  created.push(totem._id)
  await login(page)
  await page.goto('/')
  await page.getByRole('button', { name: `Editar ${totem.name}` }).click()
  const edit = page.getByRole('dialog', { name: 'Editar totem' })
  const speed = edit.getByLabel('Velocidade da cobra')
  await expect(speed).toHaveAttribute('placeholder', '5')
  await speed.fill('50')
  await edit.getByRole('button', { name: 'Salvar totem' }).click()
  await expect(edit.getByRole('alert')).toContainText('o máximo é 20')
  await speed.fill('8')
  await edit.getByLabel('Mostrar painel de debug').selectOption('true')
  await edit.getByRole('button', { name: 'Salvar totem' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Totem atualizado')
  const saved = await (await request.get(`/api/totems/${totem._id}`, { headers: AUTH })).json()
  expect(saved.gameConfig).toEqual({ gameSpeed: 8, debugPanel: true })
})

test('seções: evento, apelidos, usuários (entra com a conta nova) e atividade', async ({ page, browser }) => {
  await login(page)
  await page.goto('/#evento')
  await expect(page.getByRole('heading', { name: 'Evento', level: 1 })).toBeVisible()
  await expect(page.getByText('Partidas por totem')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Exportar planilha' })).toHaveAttribute('href', '/api/sessions.csv?range=24h')

  await page.getByRole('link', { name: 'Apelidos' }).click()
  await expect(page.locator('#nick-examples li')).toHaveCount(6)
  await page.getByLabel(/^Bichos/).fill('Capivara\nTatu')
  await page.getByLabel(/^Adjetivos/).fill('Veloz')
  await page.getByRole('button', { name: 'Salvar listas' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Listas salvas')
  await expect(page.locator('#nick-examples li').first()).toHaveText(/^(Capivara|Tatu) Veloz/)
  await page.getByRole('button', { name: 'Voltar ao padrão' }).click()
  await page.getByRole('dialog', { name: 'Voltar às listas padrão?' }).getByRole('button', { name: 'Voltar ao padrão' }).click()
  await expect(page.getByText('Usando as listas padrão.')).toBeVisible()

  const username = uniq('ui.op').toLowerCase()
  await page.getByRole('link', { name: 'Usuários' }).click()
  await page.getByRole('button', { name: 'Adicionar usuário' }).click()
  const form = page.getByRole('dialog', { name: 'Novo usuário' })
  await form.getByLabel('Nome').fill('Operadora UI')
  await form.getByLabel('Usuário').fill(username)
  await form.getByLabel(/^Senha/).fill('senha-longa-ui')
  await form.getByRole('button', { name: 'Salvar usuário' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Usuário criado')
  await expect(page.getByRole('cell', { name: username })).toBeVisible()

  // The new operator logs in by name and does not see the admin sections
  const ctx = await browser.newContext()
  const op = await ctx.newPage()
  await op.goto('/login')
  await op.getByLabel('Usuário').fill(username)
  await op.getByRole('textbox', { name: 'Senha' }).fill('senha-longa-ui')
  await op.getByRole('button', { name: 'Entrar' }).click()
  await expect(op.getByRole('heading', { name: 'Totens', level: 1 })).toBeVisible()
  await expect(op.locator('#me-name')).toHaveText('Operadora UI')
  await expect(op.getByRole('link', { name: 'Usuários' })).toBeHidden()
  await ctx.close()

  await page.getByRole('link', { name: 'Atividade' }).click()
  await expect(page.locator('#audit-list')).toContainText(`Criou o usuário ${username}`)
  await expect(page.locator('#audit-list')).toContainText('Operadora UI')

  // Clean up the account
  await page.getByRole('link', { name: 'Usuários' }).click()
  await page.getByRole('button', { name: 'Excluir Operadora UI' }).click()
  await page.getByRole('dialog', { name: 'Excluir "Operadora UI"?' }).getByRole('button', { name: 'Excluir usuário' }).click()
  await expect(page.locator('.db-toast').last()).toContainText('Usuário excluído')
})

test('API de operação exige login', async ({ request }) => {
  expect((await request.get('/api/totems')).status()).toBe(401)
  expect((await request.get('/api/totems', { headers: AUTH })).status()).toBe(200)
})
