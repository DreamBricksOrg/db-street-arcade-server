// tests/ui/embed.spec.mjs — the game embedded on a site (desktop).
import { test, expect } from '@playwright/test'
import { createTotem, deleteTotem } from './helpers.mjs'

let totem
test.beforeAll(async ({ request }) => {
  totem = await createTotem(request, { name: 'UI Embed', game: 'snake', maxPlayers: 2 })
})
test.afterAll(async ({ request }) => deleteTotem(request, totem._id))

test('iframe ganha instância própria com o cartão de QR, que recolhe e volta', async ({ page }) => {
  await page.goto(`/embed/${totem._id}`)
  await expect(page).toHaveURL(new RegExp(`/embed/${totem._id}/[0-9a-f-]{36}/$`))

  const card = page.getByRole('complementary', { name: 'Entrar no jogo pelo celular' })
  await expect(card.getByAltText('QR Code para entrar no jogo')).toBeVisible()
  await expect(card.getByRole('status')).toHaveText('2 vagas livres', { timeout: 10_000 })

  await card.getByRole('button', { name: 'Recolher QR Code' }).click()
  const pill = card.getByRole('button', { name: 'Mostrar QR Code para jogar' })
  await expect(pill).toBeVisible()
  await pill.click()
  await expect(card.getByAltText('QR Code para entrar no jogo')).toBeVisible()
})

test('showqr=false esconde o cartão', async ({ page }) => {
  await page.goto(`/embed/${totem._id}?showqr=false`)
  await expect(page.locator('.dbx')).toHaveCount(0)
})

test('o QR leva à fila daquela instância (e não à do totem físico)', async ({ page, request }) => {
  await page.goto(`/embed/${totem._id}`)
  const instance = page.url().match(/\/embed\/[^/]+\/([^/]+)\//)[1]
  const href = await page.locator('.dbx-qr').getAttribute('href')
  expect(href).toContain(`instance=${instance}`)
  const join = await request.post(`/api/totems/${totem._id}/queue/join?instance=${instance}`, { data: { playerId: 'ui_embed_p1' } })
  expect((await join.json()).status).toBe('play')
  await expect(page.locator('.dbx-status-text')).toHaveText('1 vaga livre', { timeout: 10_000 })
})
