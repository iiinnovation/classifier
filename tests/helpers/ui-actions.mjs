// Follow disclosure controls as a user would; do not force hidden controls open.
export async function revealControl(locator) {
  await locator.waitFor({ state: 'attached' })
  const dialog = locator.locator('xpath=ancestor::dialog')
  if (await dialog.count()) await dialog.waitFor({ state: 'visible' })
  for (const details of await locator.locator('xpath=ancestor::details').all()) {
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
  }
}
export async function clickControl(page, selector) {
  const locator = page.locator(selector)
  await revealControl(locator)
  await locator.click()
}
export async function moreAction(scope, name) {
  const locator = scope.getByRole('button', { name, exact: true, includeHidden: true })
  await revealControl(locator)
  await locator.click()
}
