import assert from "node:assert/strict";
import { chromium } from "playwright";
import { WebActionsEditor } from "../server/src/web-templates/web-actions-editor.tsx";
import { webActionsFormDraft, parseWebActions } from "../server/src/shared/web-actions.ts";

const script = '</textarea><script>window.escaped=true</script>&"';
const browser = await chromium.launch({ headless: true,
  ...(process.env.BF_CHROMIUM_PATH ? { executablePath: process.env.BF_CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent('<form>' + String(WebActionsEditor({config:{on_load:[{type:"javascript",script}],groups:{existing:[{type:"click",selector:"#original"}]}}})) + '</form>');
  assert.equal(await page.evaluate(()=>window.escaped),undefined);
  assert.equal(await page.locator('[name="web_on_load_step_0_value"]').inputValue(),script);
  await page.locator('[data-step-prefix="web_on_load_step"] [data-command="add-step"]').click();
  await page.locator('[name="web_on_load_step_1_type"]').selectOption("wait");
  await page.locator('[name="web_on_load_step_1_value"]').fill("0");
  await page.locator('[data-step-prefix="web_on_load_step"] [data-step-index="0"] [data-command="remove-step"]').click();
  await page.locator('[data-command="add-group"]').click();
  await page.locator('[name="web_group_1_name"]').fill("custom");
  const group = page.locator('[data-web-group-index="1"]');
  await group.locator('[data-command="add-step"]').click();
  await page.locator('[name="web_group_1_step_0_type"]').selectOption("fill");
  await page.locator('[name="web_group_1_step_0_value"]').fill('input[name="x"]=a=b');
  await group.locator('[data-command="add-step"]').click();
  await page.locator('[name="web_group_1_step_1_type"]').selectOption("javascript");
  await page.locator('[name="web_group_1_step_1_value"]').fill(script);
  await page.locator('[data-web-group-index="0"] [data-command="remove-group"]').click();
  const body = await page.evaluate(()=>Object.fromEntries(new FormData(document.querySelector('form'))));
  assert.deepEqual(parseWebActions(webActionsFormDraft(body)),{on_load:[{type:"wait",delay_ms:0}],groups:{custom:[{type:"fill",selector:'input[name="x"]',value:"a=b"},{type:"javascript",script}]}});
  assert.equal(await page.evaluate(()=>window.escaped),undefined);
  console.log("Web actions editor: dynamic rows, group deletion, values and script escaping passed");
} finally { await browser.close(); }
