import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' })

function mustDocker(...args: string[]): string {
  const result = docker(...args)
  assert.equal(result.status, 0, `docker ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`condition not met within ${timeoutMs}ms`)
}

test('P6-R2 真实 Docker：停止态 exact container 断网后启动仍隔离，loopback 可用但宿主不可达', async () => {
  const suffix = `${process.pid}-${Date.now()}`
  const container = `xjm-restore-isolation-${suffix}`
  const networkA = `xjm-restore-a-${suffix}`
  const networkB = `xjm-restore-b-${suffix}`

  try {
    mustDocker('network', 'create', networkA)
    mustDocker('network', 'create', networkB)
    mustDocker(
      'run', '-d', '--name', container,
      '--restart', 'on-failure:3',
      '--network', networkA,
      '--network-alias', 'app',
      '-p', '127.0.0.1::3000',
      'node:26-alpine',
      'node', '-e',
      'require("http").createServer((q,r)=>{r.end("ready");if(q.url==="/exit")setTimeout(()=>process.exit(42),50)}).listen(3000,"0.0.0.0")',
    )
    mustDocker('network', 'connect', '--alias', 'app-secondary', networkB, container)

    const hostPort = mustDocker('port', container, '3000/tcp').replace(/^127\.0\.0\.1:/, '')
    await waitUntil(() => docker('exec', container, 'node', '-e',
      'fetch("http://127.0.0.1:3000").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))',
    ).status === 0)
    const before = await fetch(`http://127.0.0.1:${hostPort}`)
    assert.equal(before.status, 200)

    mustDocker('stop', container)
    const containerId = mustDocker('inspect', '--format', '{{.Id}}', container)
    const networkAId = mustDocker('network', 'inspect', '--format', '{{.Id}}', networkA)
    const networkBId = mustDocker('network', 'inspect', '--format', '{{.Id}}', networkB)
    mustDocker('network', 'disconnect', networkAId, containerId)
    mustDocker('network', 'disconnect', networkBId, containerId)
    assert.equal(mustDocker('inspect', '--format', '{{json .NetworkSettings.Networks}}', containerId), '{}')

    mustDocker('start', containerId)
    await waitUntil(() => docker('exec', containerId, 'node', '-e',
      'fetch("http://127.0.0.1:3000").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))',
    ).status === 0)
    assert.equal(mustDocker('inspect', '--format', '{{json .NetworkSettings.Networks}}', containerId), '{}')
    await assert.rejects(fetch(`http://127.0.0.1:${hostPort}`, { signal: AbortSignal.timeout(1_000) }))

    await new Promise((resolve) => setTimeout(resolve, 11_000))
    docker('exec', containerId, 'node', '-e',
      'fetch("http://127.0.0.1:3000/exit").catch(()=>{}).finally(()=>setTimeout(()=>process.exit(0),100))',
    )
    await waitUntil(() => {
      const state = docker('inspect', '--format', '{{.State.Running}} {{.RestartCount}} {{json .NetworkSettings.Networks}}', containerId)
      if (state.status !== 0) return false
      const [running, restartCount, networks] = state.stdout.trim().split(/\s+/, 3)
      return running === 'true' && Number(restartCount) >= 1 && networks === '{}'
    })
    assert.equal(mustDocker('inspect', '--format', '{{json .NetworkSettings.Networks}}', containerId), '{}')
    await assert.rejects(fetch(`http://127.0.0.1:${hostPort}`, { signal: AbortSignal.timeout(1_000) }))
  } finally {
    docker('rm', '-f', container)
    docker('network', 'rm', networkA)
    docker('network', 'rm', networkB)
  }
})
