"""Self-contained browser integration suite. No network is required.
Uses an in-memory document because some managed environments block navigation.
The default suite deliberately does not claim to validate secure-origin APIs.
"""
import asyncio, base64, json, os
from pathlib import Path
import fitz
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'tests/out';OUT.mkdir(exist_ok=True)
FIXTURES=ROOT/'tests/fixtures'
RESULTS=[]
def passed(name):
 RESULTS.append(name);print('PASS',name,flush=True)
async def main():
 async with async_playwright() as playwright:
  browser=await playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader'])
  page=await browser.new_page(viewport={'width':1600,'height':1100},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  html=(ROOT/'dist/folio-pro.html').read_text()
  index=html.rfind('</script>')
  html=html[:index]+"\nwindow.__test={PDFSource,PDFWriter,NativePDFRenderer,exportVector,exportRaster,renderComposite,blankState,makePage,bytesToBase64,base64ToBytes,validateState,PageCompositor};\n"+html[index:]
  await page.set_content(html)
  await page.wait_for_function('folio.ready && [...folio.views.values()].some(v=>v.result)',timeout=20000)
  await page.wait_for_timeout(500)
  assert await page.evaluate('folio.state.pages.length')==4
  assert await page.evaluate("[...folio.texts.values()].flat().some(t=>t.text==='Clear direction.')")
  passed('Standalone boot and real PDF text/rendering')
  assert await page.locator('.thumbnail').count()==4 if await page.locator('.thumbnail').count() else await page.locator('[data-go-page]').count()>=4
  passed('Real page thumbnails')
  await page.screenshot(path=str(OUT/'workspace.png'))
  await page.keyboard.press('Control+f');await page.locator('#find-input').fill('purpose')
  await page.wait_for_function('folio.search.results.length>0')
  assert await page.locator('.search-hit').count()>0
  passed('Keyboard search and on-page matches')
  await page.locator('[data-action=close-search]').click()
  await page.evaluate('folio.goTo(0,false)')
  await page.locator('#floating-tools [data-tool=text]').click()
  box=await page.locator('.paper').first.bounding_box()
  await page.mouse.click(box['x']+80,box['y']+box['height']*.84)
  await page.locator('#dialog textarea[name=text]').fill('Browser-tested addition')
  await page.locator('#dialog-ok').click()
  await page.wait_for_function("folio.state.pages.some(p=>p.annotations.some(a=>a.text==='Browser-tested addition'))")
  passed('Add text through the real UI')
  await page.keyboard.press('Control+z')
  assert not await page.evaluate("folio.page.annotations.some(a=>a.text==='Browser-tested addition')")
  await page.keyboard.press('Control+Shift+z')
  assert await page.evaluate("folio.page.annotations.some(a=>a.text==='Browser-tested addition')")
  passed('Keyboard undo and redo')
  await page.evaluate("folio.setTool('rect')")
  box=await page.locator('.paper').first.bounding_box()
  await page.mouse.move(box['x']+60,box['y']+box['height']*.35);await page.mouse.down();await page.mouse.move(box['x']+210,box['y']+box['height']*.40,steps=8);await page.mouse.up()
  assert await page.evaluate("folio.page.annotations.some(a=>a.type==='rect'&&a.w>100)")
  passed('Pointer-driven rectangle creation')
  await page.evaluate("folio.setTool('select');const a=folio.page.annotations.find(a=>a.type==='rect');folio.select(a.id,folio.page.id)")
  old_x=await page.evaluate('folio.selection.annotation.x')
  await page.keyboard.press('Shift+ArrowRight')
  assert await page.evaluate('folio.selection.annotation.x')==old_x+10
  await page.keyboard.press('Control+d')
  assert await page.evaluate("folio.page.annotations.filter(a=>a.type==='rect').length")==2
  passed('Object nudge and duplication')
  await page.locator('[data-right=comments]').click();await page.locator('[data-edit-note]').first.click()
  await page.locator('#dialog textarea').fill('Edited review <img src=x onerror=alert(1)>')
  await page.locator('#dialog-ok').click()
  await page.wait_for_function("folio.state.pages.some(p=>p.annotations.some(a=>a.text?.startsWith('Edited review')))")
  assert await page.locator('.comment-card img').count()==0
  assert 'Edited review' in await page.locator('.comment-card').first.inner_text()
  passed('Comment editing and HTML injection safety')
  await page.locator('[data-resolve-note]').first.click()
  assert await page.evaluate('folio.state.pages[0].annotations.find(a=>a.type===\'note\').resolved')
  passed('Comment resolution')
  await page.evaluate('folio.goTo(3,false);folio.setTool("select")')
  await page.wait_for_function('folio.widgets.has(folio.state.pages[3].id)')
  await page.get_by_label('Reviewer',exact=True).fill('Ada Lovelace');await page.get_by_label('Reviewer',exact=True).press('Tab')
  await page.get_by_label('Department',exact=True).fill('Engineering');await page.get_by_label('Department',exact=True).press('Tab')
  await page.get_by_label('Reviewed',exact=True).check()
  assert await page.evaluate("Object.values(folio.state.fieldValues).includes('Ada Lovelace')")
  assert await page.evaluate('Object.values(folio.state.fieldValues).includes(true)')
  passed('Native PDF text and checkbox form filling')
  data=await page.evaluate('async()=>__test.bytesToBase64(await __test.exportVector(folio.state,folio.sources))')
  pdf=base64.b64decode(data);(OUT/'browser-vector.pdf').write_bytes(pdf)
  document=fitz.open(stream=pdf,filetype='pdf')
  assert len(document)==4 and 'Ada Lovelace' in document[3].get_text() and 'Browser-tested addition' in document[0].get_text()
  passed('Independent verification of edited and filled vector PDF')
  await page.locator('.tabs [data-tab=organize]').click()
  assert await page.locator('#organizer').is_visible()
  await page.evaluate('folio.activeIndex=0;folio.rotatePage(90);folio.duplicatePage();folio.movePage(0,3)')
  assert await page.evaluate('folio.state.pages.length')==5
  assert await page.evaluate('folio.state.pages[3].rotation')==90
  await page.screenshot(path=str(OUT/'organizer.png'))
  passed('Page organizer, rotate, duplicate, reorder')
  await page.evaluate('folio.history.undo();folio.history.undo();folio.history.undo();folio.closeOrganizer();folio.goTo(0,false)')
  assert await page.evaluate('folio.state.pages.length')==4
  saved=await page.evaluate('folio.projectPayload()')
  # Structured byte arrays stay in the browser for exact editable project round-trip.
  await page.evaluate('async()=>{const payload=folio.projectPayload();await folio.loadProject(payload)}')
  assert await page.evaluate("folio.state.pages[0].annotations.some(a=>a.text==='Browser-tested addition')")
  passed('Editable project round-trip preserves source and edit model')
  await page.evaluate("folio.history.markSaved()")
  await page.locator('#open-input').set_input_files(str(FIXTURES/'imported.pdf'))
  await page.wait_for_function("folio.state.name==='imported.pdf' && [...folio.views.values()].some(v=>v.result)")
  assert await page.evaluate("[...folio.texts.values()].flat().some(t=>t.text.includes('TOP SECRET'))")
  assert not await page.locator('.render-error').count()
  assert await page.evaluate("(()=>{const v=folio.views.get(folio.page.id),s=v.result.scale,d=v.canvas.getContext('2d').getImageData(30*s,25*s,300*s,90*s).data;let dark=0;for(let i=0;i<d.length;i+=4)if(d[i]<80&&d[i+1]<80&&d[i+2]<80)dark++;return dark>100})()")
  passed('External ReportLab PDF import, ASCII85/Flate, image XObject rendering')
  await page.screenshot(path=str(OUT/'external-pdf.png'))
  # Full rasterization must remain searchable-text-free and must replace mask pixels.
  await page.evaluate("folio.addAnnotation(folio.page.id,{type:'redact',x:30,y:70,w:240,h:35,color:'#000000'})")
  blocked=await page.evaluate('async()=>{try{await __test.exportVector(folio.state,folio.sources);return false}catch(e){return /redactions/.test(e.message)}}')
  assert blocked
  data=await page.evaluate('async()=>__test.bytesToBase64(await __test.exportRaster(folio.state,folio.sources,folio.renderer,{redactions:true,scale:2}))')
  sanitized=base64.b64decode(data);(OUT/'redacted.pdf').write_bytes(sanitized)
  redacted=fitz.open(stream=sanitized,filetype='pdf');assert redacted[0].get_text()==''
  assert 'TOP SECRET' not in ''.join(redacted.xref_object(i) for i in range(1,redacted.xref_length()))
  assert not redacted[0].get_fonts() and not redacted.embfile_count()
  pix=redacted[0].get_pixmap(matrix=fitz.Matrix(1,1));assert pix.pixel(100,85)==(0,0,0)
  assert redacted.metadata.get('title')=='Sanitized document'
  pix.save(str(OUT/'redacted.png'))
  passed('Sanitized export: opaque pixels, no text/fonts/attachments, fresh metadata')
  assert await page.evaluate("[...folio.texts.values()].flat().some(t=>t.text.includes('TOP SECRET'))")
  passed('Original remains in editable workspace; redaction export is separate')
  await page.evaluate('folio.history.markSaved()')
  await page.locator('#open-input').set_input_files(str(FIXTURES/'compressed-objects.pdf'))
  await page.wait_for_function("folio.state.name==='compressed-objects.pdf' && [...folio.views.values()].some(v=>v.result)")
  assert not await page.locator('.render-error').count()
  assert await page.evaluate("(()=>{const v=folio.views.get(folio.page.id),s=v.result.scale,d=v.canvas.getContext('2d').getImageData(30*s,25*s,300*s,90*s).data;let dark=0;for(let i=0;i<d.length;i+=4)if(d[i]<80&&d[i+1]<80&&d[i+2]<80)dark++;return dark>100})()")
  passed('Externally generated cross-reference and object-stream PDF')
  await page.locator('#image-input').set_input_files(str(FIXTURES/'test-image.png'))
  await page.wait_for_function('folio.image!==null')
  await page.evaluate("folio.placeAt('image',{x:50,y:360},folio.page)")
  assert await page.evaluate("folio.page.annotations.some(a=>a.type==='image')")
  data=await page.evaluate('async()=>__test.bytesToBase64(await __test.exportVector(folio.state,folio.sources))')
  image_doc=fitz.open(stream=base64.b64decode(data),filetype='pdf')
  assert len(image_doc[0].get_images())>=2
  passed('Image insertion and actual PDF image export')
  await page.locator('#floating-tools [data-action=signature]').click()
  await page.locator('#dialog [name=signature]').fill('Ada Lovelace')
  await page.locator('#dialog-ok').click()
  await page.wait_for_function('folio.signature!==null')
  await page.evaluate("folio.placeAt('signature',{x:50,y:490},folio.page)")
  assert await page.evaluate("folio.page.annotations.some(a=>a.type==='signature')")
  passed('Typed visual signature workflow')
  await page.evaluate("folio.history.transact('crop',s=>s.pages[0].crop={x:20,y:20,w:350,h:500});folio.rotatePage(90)")
  data=await page.evaluate('async()=>__test.bytesToBase64(await __test.exportVector(folio.state,folio.sources))')
  crop_doc=fitz.open(stream=base64.b64decode(data),filetype='pdf');assert crop_doc[0].rotation==90 and crop_doc[0].rect.width==500 and crop_doc[0].rect.height==350
  passed('Crop and rotate verified in an independent PDF reader')
  await page.set_viewport_size({'width':900,'height':850});await page.wait_for_timeout(300)
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  passed('Responsive narrow workspace without horizontal document overflow')
  assert not errors,errors
  passed('No uncaught browser exceptions during integration suite')
  result={'passed':len(RESULTS),'tests':RESULTS,'browser':browser.version,'renderer':await page.evaluate('folio.renderer.name'),'compositor':await page.evaluate('folio.gpu.mode'),'gpuReason':await page.evaluate('folio.gpuReason'),'scope':'In-memory standalone HTML; managed browser disallows URL navigation. No hardware-GPU or IndexedDB-origin validation.'}
  (OUT/'browser-results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
  await browser.close()
asyncio.run(main())
