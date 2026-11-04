// #320: in the Instance editor the Source documents, Review comments and Decisions log panels sit behind the toolbar's Sources & decisions
// toggle, which is off on every page load. A browser test that works in one of those panels switches it on first (again after any reload).
export async function showSourcesAndDecisions(page) {
  const toggle = page.getByTestId('reference-toggle')
  await toggle.waitFor()
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await page.getByTestId('reference-panels').waitFor()
}

// Switches the toggle off again, back to the Fields and the status panels above them (the Out of date banner among them).
export async function showFields(page) {
  const toggle = page.getByTestId('reference-toggle')
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
  await page.locator('main#modules').waitFor()
}
