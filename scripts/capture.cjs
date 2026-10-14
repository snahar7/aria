// Capture README visuals: renders src/index.html in headless Chromium with a mocked
// window.aria (scripts/mock-aria.js), then writes screenshots and an animated GIF to docs/.
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/capture.cjs        (needs ffmpeg on PATH for the GIF)
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const docs = path.join(root, 'docs')
const frames = path.join(root, 'shots', 'frames')
fs.mkdirSync(docs, { recursive: true })
fs.rmSync(frames, { recursive: true, force: true })
fs.mkdirSync(frames, { recursive: true })
const mock = fs.readFileSync(path.join(__dirname, 'mock-aria.js'), 'utf8')
const url = 'file://' + path.join(root, 'src', 'index.html')

async function open(browser, theme) {
  const page = await browser.newPage({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 2 })
  await page.addInitScript(`window.__ARIA_THEME = ${JSON.stringify(theme)};\n${mock}`)
  page.on('pageerror', (e) => console.error('pageerror:', e.message))
  await page.goto(url)
  await page.waitForTimeout(600)
  return page
}

;(async () => {
  const browser = await chromium.launch()

  for (const theme of ['light', 'dark']) {
    const page = await open(browser, theme)
    await page.screenshot({ path: path.join(docs, `aria-${theme}.png`) })
    console.log('wrote', `docs/aria-${theme}.png`)
    await page.close()
  }

  // Animated demo: type a request, Aria thinks, the new task appears.
  const page = await open(browser, 'light')
  let i = 0
  const snap = async (repeat = 1) => {
    const file = path.join(frames, `f${String(i).padStart(4, '0')}.png`)
    await page.screenshot({ path: file })
    i++
    for (let r = 1; r < repeat; r++) {
      fs.copyFileSync(file, path.join(frames, `f${String(i).padStart(4, '0')}.png`))
      i++
    }
  }
  await snap(8)
  const input = page.locator('#task-input')
  await input.click()
  const sentence = 'plan the product launch for friday'
  for (const ch of sentence) {
    await input.type(ch)
    await snap()
  }
  await snap(5)
  await page.keyboard.press('Enter')
  for (let k = 0; k < 14; k++) { await page.waitForTimeout(100); await snap() }
  await page.waitForTimeout(300)
  await snap(25)
  await page.screenshot({ path: path.join(docs, 'aria-after.png') })
  await browser.close()

  const gif = path.join(docs, 'aria-demo.gif')
  const palette = path.join(frames, 'palette.png')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(frames, 'f%04d.png'), '-vf', 'scale=400:-1:flags=lanczos,palettegen=stats_mode=diff', palette])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(frames, 'f%04d.png'), '-i', palette, '-lavfi', 'scale=400:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4', gif])
  console.log('wrote docs/aria-demo.gif', (fs.statSync(gif).size / 1024).toFixed(0) + ' KB')
})()
