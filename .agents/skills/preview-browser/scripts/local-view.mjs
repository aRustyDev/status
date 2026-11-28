// Create the loopback listener only after a request to view a tab.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export async function localView(page) {
  const path = '/' + randomBytes(24).toString('hex')
  const expires = Date.now() + 120_000
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== path || req.headers.host !== server.address()?.address + ':' + server.address()?.port || Date.now() >= expires) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' })
    try {
      while (!res.destroyed && !page.isClosed() && Date.now() < expires) {
        const frame = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 4000 })
        if (res.destroyed || res.writableLength > 1024 * 1024) break
        res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frame.length + '\r\n\r\n')
        res.write(frame)
        res.write('\r\n')
        await delay(600)
      }
    } catch { /* Closing the tab ends the stream. */ }
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections() }
  const timer = setTimeout(close, expires - Date.now()).unref()
  return { url: 'http://127.0.0.1:' + server.address().port + path, close }
}
