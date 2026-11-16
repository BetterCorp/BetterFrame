import assert from "node:assert/strict";
import { chromium } from "playwright";
import { EntityNewPage, EntityEditPage } from "../server/src/web-templates/admin-pages.tsx";
import { webPermissionsForm } from "../server/src/shared/web-permissions.ts";
const browser=await chromium.launch({headless:true,...(process.env.BF_CHROMIUM_PATH?{executablePath:process.env.BF_CHROMIUM_PATH}:{})});
try {
  const page=await browser.newPage();
  await page.route('**/*', route=>route.abort());
  await page.setContent(String(EntityNewPage({user:'admin',cameras:[]})));
  const section=page.locator('[data-web-permissions]');
  const type=page.locator('select[name="type"]');
  for (const value of ['web','html','camera','web']) {
    await type.selectOption(value);
    assert.equal(await section.isVisible(),value!=='camera');
  }
  assert.equal(await page.locator('[name="web_permission_audio"]').isChecked(),true);
  assert.equal(await page.locator('[name="web_permission_autoplay"]').isChecked(),true);
  await page.locator('[name="web_permission_microphone"]').check();
  await page.locator('[name="web_permission_autoplay"]').uncheck();
  const data=await page.evaluate(()=>Object.fromEntries(new FormData(document.querySelector('#entity-new-root form'))));
  const config=webPermissionsForm(data);
  assert.equal(config.microphone,true);
  assert.equal(config.autoplay,false);
  await page.setContent(String(EntityEditPage({user:'admin',cameras:[],entity:{id:'entity',name:'App',type:'web',web_url:'https://example.test',input_options_json:{},web_permissions_json:config}})));
  assert.equal(await page.locator('[name="web_permission_microphone"]').isChecked(),true);
  assert.equal(await page.locator('[name="web_permission_autoplay"]').isChecked(),false);
  console.log('Web permissions: type visibility, defaults, checkbox submission and edit round-trip passed');
} finally { await browser.close(); }
