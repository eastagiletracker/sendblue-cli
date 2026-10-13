import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import test from 'node:test'

const longContent = 'This inbound message is deliberately longer than eighty characters so the human view would truncate it.'

const page = {
    status: 'OK',
    data: [
        {
            content: longContent,
            number: '+15551234567',
            from_number: '+15551234567',
            to_number: '+15557654321',
            is_outbound: false,
            status: 'RECEIVED',
            date_sent: '2026-06-06T10:15:00.000Z',
            date_updated: '2026-06-06T10:15:00.000Z',
            sendblue_number: '+15557654321',
            message_handle: 'msg-handle-1',
            row_id: 'row-1',
            service: 'iMessage',
            reply_to: { message_handle: 'msg-handle-0' }
        }
    ],
    pagination: { total: 3, limit: 1, offset: 0, hasMore: true }
}

async function runMessages(args, handler) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sendblue-cli-messages-'))
    const configDir = path.join(home, '.sendblue')
    await fs.mkdir(configDir, { mode: 0o700 })
    await fs.writeFile(path.join(configDir, 'credentials.json'), JSON.stringify({
        apiKey: 'integration-key',
        apiSecret: 'integration-secret',
        email: 'owner@example.com',
        assignedNumber: '',
        plan: 'test',
        createdAt: new Date().toISOString()
    }), { mode: 0o600 })

    const requests = []
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        requests.push(url)
        handler(url, res)
    })

    try {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        assert.ok(address && typeof address === 'object')

        const child = spawn(process.execPath, ['dist/index.js', 'messages', ...args], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HOME: home,
                SENDBLUE_API_BASE: `http://127.0.0.1:${address.port}`
            },
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })

        const [code] = await once(child, 'exit')
        return { code, stdout, stderr, requests }
    } finally {
        server.closeAllConnections?.()
        await new Promise((resolve) => server.close(resolve))
        await fs.rm(home, { recursive: true, force: true })
    }
}

function respondWith(status, body) {
    return (url, res) => {
        if (url.pathname !== '/api/v2/messages') {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end('{}')
            return
        }
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
    }
}

test('messages --json prints full message objects and pagination on stdout', { timeout: 15_000 }, async () => {
    const { code, stdout, requests } = await runMessages(
        ['--json', '-n', '(555) 123-4567', '--limit', '1', '--inbound'],
        respondWith(200, page)
    )

    assert.equal(code, 0)
    const output = JSON.parse(stdout)
    assert.deepEqual(output, { data: page.data, pagination: page.pagination })
    assert.equal(output.data[0].content, longContent)
    assert.equal(output.data[0].message_handle, 'msg-handle-1')

    assert.equal(requests.length, 1)
    assert.equal(requests[0].searchParams.get('number'), '+15551234567')
    assert.equal(requests[0].searchParams.get('limit'), '1')
    assert.equal(requests[0].searchParams.get('is_outbound'), 'false')
})

test('messages --json prints an empty data array when there are no messages', { timeout: 15_000 }, async () => {
    const empty = { status: 'OK', data: [], pagination: { total: 0, limit: 10, offset: 0, hasMore: false } }
    const { code, stdout } = await runMessages(['--json'], respondWith(200, empty))

    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), { data: [], pagination: empty.pagination })
})

test('messages --json keeps stdout empty and reports API errors on stderr', { timeout: 15_000 }, async () => {
    const { code, stdout, stderr } = await runMessages(['--json'], respondWith(500, { error: 'history unavailable' }))

    assert.equal(code, 1)
    assert.equal(stdout, '')
    assert.match(stderr, /Failed: history unavailable/)
})

test('messages without --json keeps the human-readable listing', { timeout: 15_000 }, async () => {
    const { code, stdout } = await runMessages(['--limit', '1'], respondWith(200, page))

    assert.equal(code, 0)
    assert.throws(() => JSON.parse(stdout))
    assert.match(stdout, /Messages/)
    assert.match(stdout, /\+1 \(555\) 123-4567/)
    assert.match(stdout, /Showing 1 of 3/)
    assert.ok(!stdout.includes(longContent))
})
