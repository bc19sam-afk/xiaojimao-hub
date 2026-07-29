import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { backupManifestPath } from '../lib/backup-manifest.ts'
import { writeBackupManifestFixture } from './backup-manifest-fixture.ts'

// ============================================================================
// scripts/restore.sh 回归（P6-R2 复审必修 1 / 建议 3）
//
// 用**桩 docker** 跑真实脚本：桩把 `docker compose run ... -v H:C ... -e <JS>` 里的容器路径按挂载
// 规格换回宿主路径，然后用真 node 跑那段 JS——于是 VACUUM INTO 是真的在跑、真的读写真 SQLite 库，
// 只有「起容器」这一层被替换掉。stop/start 默认是空操作，readiness 由 docker exec 桩返回。
//
// ⚠️ 测试库隔离（红线）：全程临时目录，DATA_DIR/BACKUP_DIR 都指向 tmp，绝不碰真实 data/。
// ============================================================================

const REPO = path.resolve(import.meta.dirname, '..')
const RESTORE_SH = path.join(REPO, 'scripts', 'restore.sh')

let tmpDir: string
let binDir: string
let originalTmpDir: string | undefined

// 桩 docker 的真身：解析 -v/-e，把容器内路径换成宿主路径，再用真 node 跑那段 JS。
// 顺带充当**断言点**：挂载源必须是存在的绝对路径——相对路径会被真 docker 当成「命名卷」
// 静默建个空卷（容器读到空目录、脚本却以为在读宿主的库），这里直接判失败。
//
// 🔴 `:ro` 必须真的只读，否则这层桩就是假的。真容器里 `-v H:/snap.db:ro` 把文件挂在**根目录**
//    下、属主 root，进程是 `USER node`(uid1000)：SQLite 想在同目录建 -wal/-shm 会直接被拒。
//    桩若只是把 /snap.db 替换成宿主那个可写目录里的路径，这个约束就凭空消失了——实测过：
//    去掉 immutable=1 的破坏版在「不模拟只读」的桩下照样全绿（假绿）。
//    故：带 :ro 的挂载先把文件复制进一个 0500 的临时目录再喂给 JS，逼真地还原「同目录不可写」。
const DOCKER_STUB = `import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n')
const validatorId = 'e'.repeat(64)
const validatorStatePath = process.env.STUB_LOG + '.validator.json'
const validatorImage = 'sha256:' + '1'.repeat(64)

if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.TEST_VALIDATOR_IMAGE_INSPECT_FAIL === '1') process.exit(78)
  const formatAt = args.indexOf('--format')
  const format = formatAt >= 0 ? args[formatAt + 1] : ''
  if (format.includes('.Id')) console.log(validatorImage)
  else if (format.includes('.Config.Env')) console.log('[]')
  else process.exit(79)
  process.exit(0)
}

if (args[0] === 'create') {
  if (process.env.TEST_VALIDATOR_CREATE_FAIL === '1') process.exit(78)
  const mountAt = args.indexOf('--mount')
  const commandAt = args.indexOf('-e')
  const mount = mountAt >= 0 ? args[mountAt + 1] : ''
  const sourceField = mount.split(',').find((field) => field.startsWith('src=')) || ''
  const source = sourceField.slice(4)
  const js = commandAt >= 0 ? args[commandAt + 1] : ''
  if (!source || !js || !fs.existsSync(source)) process.exit(80)
  fs.writeFileSync(validatorStatePath, JSON.stringify({ source, js }))
  console.log(validatorId)
  process.exit(0)
}

if (args[0] === 'inspect' && args.at(-1) === validatorId) {
  if (process.env.TEST_VALIDATOR_INSPECT_FAIL === '1') process.exit(78)
  const formatAt = args.indexOf('--format')
  const format = formatAt >= 0 ? args[formatAt + 1] : ''
  const validator = JSON.parse(fs.readFileSync(validatorStatePath, 'utf8'))
  if (format.includes('XJM_VALIDATOR_MOUNT')) {
    console.log(['XJM_VALIDATOR_MOUNT', 'bind', validator.source, '/snap.db', 'false'].join('\\t'))
  } else if (format.includes('.Image')) console.log(validatorImage)
  else if (format.includes('.HostConfig.NetworkMode')) console.log('none')
  else if (format.includes('.HostConfig.ReadonlyRootfs')) console.log('true')
  else if (format.includes('.HostConfig.CapDrop')) console.log('["ALL"]')
  else if (format.includes('.HostConfig.SecurityOpt')) console.log('["no-new-privileges"]')
  else if (format.includes('.Config.User')) console.log('0:0')
  else if (format.includes('.Config.Entrypoint')) console.log('["node"]')
  else if (format.includes('.Config.Cmd')) console.log(JSON.stringify(['-e', validator.js]))
  else if (format.includes('.Config.Env')) {
    console.log(process.env.TEST_VALIDATOR_ENV_DRIFT === '1' ? '["SERVICE_SECRET=leak"]' : '[]')
  } else process.exit(79)
  process.exit(0)
}

if (args[0] === 'start' && args.at(-1) === validatorId) {
  if (process.env.TEST_VALIDATOR_START_FAIL === '1') process.exit(78)
  const validator = JSON.parse(fs.readFileSync(validatorStatePath, 'utf8'))
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-validator-ro-'))
  const inner = path.join(jail, 'snap.db')
  fs.copyFileSync(validator.source, inner)
  fs.chmodSync(inner, 0o444)
  fs.chmodSync(jail, 0o500)
  const rewritten = validator.js.split('/snap.db').join(inner)
  const result = spawnSync(process.execPath, ['-e', rewritten], { stdio: 'inherit' })
  fs.chmodSync(jail, 0o700)
  fs.rmSync(jail, { recursive: true, force: true })
  process.exit(result.status ?? 1)
}

if (args[0] === 'rm' && args.at(-1) === validatorId) {
  if (process.env.TEST_VALIDATOR_RM_FAIL === '1') process.exit(78)
  fs.rmSync(validatorStatePath, { force: true })
  console.log(validatorId)
  process.exit(0)
}

if (args[0] === 'inspect') {
  if (process.env.TEST_CONTAINER_MOUNT_MODE === 'inspect-fail') process.exit(78)
  const mode = process.env.TEST_CONTAINER_MOUNT_MODE || 'bind'
  const source = process.env.TEST_CONTAINER_DATA_SOURCE || process.env.TEST_COMPOSE_DATA_SOURCE || process.env.DATA_DIR || ''
  const formatAt = args.indexOf('--format')
  const format = formatAt >= 0 ? args[formatAt + 1] : ''
  if (format.includes('com.docker.compose.project')) {
    console.log('xiaojimao-hub\\tapp\\tFalse\\t' + 'c'.repeat(64))
    process.exit(0)
  }
  if (format.includes('.Id')) {
    console.log(process.env.TEST_INSPECT_ID_OVERRIDE || 'a'.repeat(64))
    process.exit(0)
  }
  if (format.includes('.Image')) {
    console.log('sha256:' + '1'.repeat(64))
    process.exit(0)
  }
  if (format.includes('XJM_NETWORK_ID')) {
    if (!fs.existsSync(process.env.STUB_LOG + '.isolated')) {
      console.log('XJM_NETWORK_ID\\t' + 'd'.repeat(64))
    }
    process.exit(0)
  }
  if (format.includes('XJM_NETWORK_RECORD')) {
    if (!fs.existsSync(process.env.STUB_LOG + '.isolated')) {
      console.log('XJM_NETWORK_RECORD\\tstub-network\\t' + 'd'.repeat(64) + '\\tapp\\tstub-app')
    }
    process.exit(0)
  }
  if (format.includes('XJM_BIND')) {
    console.log('XJM_BIND\\t' + source + '\\t/app/data')
    if (process.env.TEST_CONTAINER_EXTRA_BIND_SOURCE) {
      console.log(
        'XJM_BIND\\t' + process.env.TEST_CONTAINER_EXTRA_BIND_SOURCE + '\\t' +
        (process.env.TEST_CONTAINER_EXTRA_BIND_TARGET || '/app/extra'),
      )
    }
    process.exit(0)
  }
  if (format.includes('IPAMConfig')) {
    if (process.env.TEST_UNSUPPORTED_NETWORK_CONFIG === '1') console.log('stub-network\tstatic-ipv4')
    process.exit(0)
  }
  if (format.includes('NetworkSettings.Networks')) {
    if (!fs.existsSync(process.env.STUB_LOG + '.isolated')) console.log('stub-network\\tapp\\tstub-app')
    process.exit(0)
  }
  if (format.includes('.State.Running')) {
    console.log(fs.existsSync(process.env.STUB_LOG + '.stopped') ? 'false' : 'true')
    process.exit(0)
  }
  if (mode === 'missing') process.exit(0)
  if (mode === 'multiple') {
    console.log(\`bind\\t\${source}\`)
    console.log(\`bind\\t\${process.env.TEST_CONTAINER_DATA_SOURCE_2 || source}\`)
    process.exit(0)
  }
  console.log(\`\${mode === 'named' ? 'volume' : 'bind'}\\t\${mode === 'named' ? 'xiaojimao_data' : source}\`)
  process.exit(0)
}
if (args[0] === 'stop') {
  const exitCode = Number(process.env.TEST_DOCKER_STOP_EXIT || 0)
  if (exitCode === 0) fs.writeFileSync(process.env.STUB_LOG + '.stopped', '')
  process.exit(exitCode)
}
if (args[0] === 'start') {
  fs.rmSync(process.env.STUB_LOG + '.stopped', { force: true })
  const stateFile = process.env.TEST_START_STATE || ''
  const wal = process.env.TEST_WAL_PATH || ''
  const shm = process.env.TEST_SHM_PATH || ''
  if (stateFile) {
    fs.appendFileSync(stateFile, JSON.stringify({
      walExists: wal ? fs.existsSync(wal) : null,
      shmExists: shm ? fs.existsSync(shm) : null,
    }) + '\\n')
  }
  if (process.env.TEST_CREATE_SIDECARS_ON_START === '1') {
    if (wal) fs.writeFileSync(wal, 'NEW-DB-WAL')
    if (shm) fs.writeFileSync(shm, 'NEW-DB-SHM')
  }
  process.exit(0)
}
if (args[0] === 'network') {
  if (args[1] === 'disconnect') fs.writeFileSync(process.env.STUB_LOG + '.isolated', '')
  if (args[1] === 'connect') fs.rmSync(process.env.STUB_LOG + '.isolated', { force: true })
  process.exit(0)
}
if (args[0] === 'exec') {
  if (process.env.TEST_READY_ENTERED) fs.writeFileSync(process.env.TEST_READY_ENTERED, '')
  if (process.env.TEST_READY_BLOCK_MS) {
    spawnSync('sleep', [String(Number(process.env.TEST_READY_BLOCK_MS) / 1000)])
  }
  if (process.env.TEST_CLOCK_FILE) {
    const clock = JSON.parse(fs.readFileSync(process.env.TEST_CLOCK_FILE, 'utf8'))
    const maxTime = Number(args.at(-1))
    const startedAt = clock.now
    const duration = clock.curlDurations[clock.curlCalls.length] ?? 0
    clock.curlCalls.push({ startedAt, maxTime, deadline: clock.deadline })
    clock.now += Math.min(duration, maxTime)
    fs.writeFileSync(process.env.TEST_CLOCK_FILE, JSON.stringify(clock))
    process.exit(7)
  }
  const body = process.env.TEST_READY_BODY ?? '{"ok":true}'
  const status = process.env.TEST_READY_STATUS || '200'
  process.stdout.write(body)
  process.exit(Number(process.env.TEST_READY_EXIT || (status === '200' ? 0 : 8)))
}
if (args[0] !== 'compose') process.exit(0)
if (args[1] === 'ps') {
  if (process.env.TEST_CONTAINER_MOUNT_MODE === 'container-missing' && !fs.existsSync(process.env.STUB_LOG + '.created')) process.exit(0)
  if (process.env.TEST_CONTAINER_MOUNT_MODE === 'container-multiple') {
    console.log('1111111111111111111111111111111111111111111111111111111111111111')
    console.log('2222222222222222222222222222222222222222222222222222222222222222')
    process.exit(0)
  }
  console.log(process.env.TEST_COMPOSE_CONTAINER_ID || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  process.exit(0)
}
if (args[1] === 'create') {
  fs.writeFileSync(process.env.STUB_LOG + '.created', '')
  fs.writeFileSync(process.env.STUB_LOG + '.stopped', '')
  process.exit(0)
}
if (args[1] === 'stop') process.exit(0)
if (args[1] === 'start') {
  // 信号/退出路径测试需要证明「start 被调用的那个瞬间」sidecar 已经处于安全状态，不能只看
  // 脚本退出后的最终文件——后续命令可能把证据删掉或重建，形成假绿。
  const stateFile = process.env.TEST_START_STATE || ''
  const wal = process.env.TEST_WAL_PATH || ''
  const shm = process.env.TEST_SHM_PATH || ''
  if (stateFile) {
    fs.appendFileSync(stateFile, JSON.stringify({
      walExists: wal ? fs.existsSync(wal) : null,
      shmExists: shm ? fs.existsSync(shm) : null,
    }) + '\\n')
  }
  // 模拟 app 启动后新库立即进入 WAL 模式并产生自己的 sidecar。用于证明后续 EXIT trap
  // 不能把「新库正在使用的 WAL」误当成旧库残留再删一次。
  if (process.env.TEST_CREATE_SIDECARS_ON_START === '1') {
    if (wal) fs.writeFileSync(wal, 'NEW-DB-WAL')
    if (shm) fs.writeFileSync(shm, 'NEW-DB-SHM')
  }
  process.exit(0)
}
if (args[1] === 'config') {
  const mountMode = process.env.TEST_COMPOSE_MOUNT_MODE || 'bind'
  if (mountMode === 'config-fail') process.exit(77)
  if (args.includes('--hash')) {
    console.log('app ' + 'c'.repeat(64))
    process.exit(0)
  }
  const formatAt = args.indexOf('--format')
  if (formatAt >= 0 && args[formatAt + 1] === 'json') {
    const source = process.env.TEST_COMPOSE_DATA_SOURCE || process.env.DATA_DIR || ''
    let volumes = []
    if (mountMode === 'bind') {
      volumes = [{ type: 'bind', source, target: '/app/data', bind: {} }]
    } else if (mountMode === 'named') {
      volumes = [{ type: 'volume', source: 'xiaojimao_data', target: '/app/data', volume: {} }]
    } else if (mountMode === 'multiple') {
      volumes = [
        { type: 'bind', source, target: '/app/data', bind: {} },
        { type: 'bind', source: process.env.TEST_COMPOSE_DATA_SOURCE_2 || source, target: '/app/data', bind: {} },
      ]
    }
    if (process.env.TEST_COMPOSE_EXTRA_BIND_SOURCE) {
      volumes.push({
        type: 'bind',
        source: process.env.TEST_COMPOSE_EXTRA_BIND_SOURCE,
        target: process.env.TEST_COMPOSE_EXTRA_BIND_TARGET || '/app/extra',
        bind: {},
      })
    }
    const app = { volumes }
    if (process.env.TEST_COMPOSE_FALSE_POSITIVE_NETWORK_KEY === '1') {
      app.environment = { interface_name: 'diagnostic-only', mac_address: 'not-an-endpoint' }
    }
    console.log(JSON.stringify({ services: { app } }, null, 2))
    process.exit(0)
  }
  // R4-P1①：restore.sh 改用 docker compose config app 读容器内 DB_PATH。
  // 桩默认不输出 DB_PATH 行（模拟未设 DB_PATH 的默认配置）；测试可通过 TEST_CONTAINER_DB_PATH
  // 注入非默认值触发守卫。真 config 会展开 env_file、引号剥离、插值等，桩只输最终形式。
  const inject = process.env.TEST_CONTAINER_DB_PATH || ''
  if (inject) console.log(\`      DB_PATH: \${inject}\`)
  process.exit(0)
}
if (args[1] !== 'run') process.exit(0)

const mounts = []
const roDirs = []
let js = null
for (let i = 2; i < args.length; i++) {
  if (args[i] === '-v') {
    const spec = args[++i]
    const [host, ctr, mode] = spec.split(':')
    if (!host.startsWith('/')) {
      console.error('桩 docker：挂载源不是绝对路径（真 docker 会当成命名卷建个空卷）：' + spec)
      process.exit(90)
    }
    if (!fs.existsSync(host)) {
      console.error('桩 docker：挂载源不存在（真 docker 会以 root 悄悄新建）：' + spec)
      process.exit(91)
    }
    if (mode === 'ro') {
      // 复刻真容器的只读语义：文件放进一个不可写目录
      const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-ro-'))
      const inner = path.join(jail, path.basename(ctr))
      fs.copyFileSync(host, inner)
      fs.chmodSync(inner, 0o444)
      fs.chmodSync(jail, 0o500)
      roDirs.push(jail)
      mounts.push({ ctr, host: inner })
    } else {
      mounts.push({ ctr, host })
    }
  } else if (args[i] === '-e') {
    js = args[++i]
  }
}
// 长的容器路径先替换，避免短路径是长路径前缀时替错
mounts.sort((a, b) => b.ctr.length - a.ctr.length)
let rewritten = js
for (const m of mounts) rewritten = rewritten.split(m.ctr).join(m.host)

const r = spawnSync(process.execPath, ['-e', rewritten], { stdio: 'inherit' })
for (const d of roDirs) {
  fs.chmodSync(d, 0o700)
  fs.rmSync(d, { recursive: true, force: true })
}
process.exit(r.status ?? 1)
`

const READY_CURL_STUB = `#!/bin/sh
echo "unexpected host curl: restore readiness must use docker exec exact-id" >&2
exit 97
`

// 本轮架构回归需要一个有真实“容器 A / 容器 B / 运行态 / 网络隔离”状态的 Docker 桩。
// 旧的轻量桩继续服务既有用例；新增的身份漂移、网络隔离与 SIGKILL 测试使用本桩。
const STATEFUL_DOCKER_STUB = `import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const stateFile = process.env.TEST_DOCKER_STATE
const logFile = process.env.STUB_LOG
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
fs.appendFileSync(logFile, JSON.stringify(args) + '\\n')

const validatorId = 'e'.repeat(64)
if (
  args[0] === 'image' ||
  args[0] === 'create' ||
  args[0] === 'rm' ||
  ((args[0] === 'inspect' || args[0] === 'start') && args.at(-1) === validatorId)
) {
  const base = spawnSync(process.execPath, [process.env.TEST_BASE_DOCKER_STUB, ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  process.exit(base.status ?? 1)
}

function save() { fs.writeFileSync(stateFile, JSON.stringify(state)) }
function resolveId(ref) {
  if (state.containers[ref]) return ref
  const matches = Object.keys(state.containers).filter((id) => id.startsWith(ref))
  return matches.length === 1 ? matches[0] : ref
}
function renderId(id) {
  const truncate = !args.includes('--no-trunc') && (
    process.env.TEST_TRUNCATE_ALL_IDS_WITHOUT_FLAG === '1' ||
    (process.env.TEST_TRUNCATE_SERVICE_IDS_WHEN_EXTRA === '1' && state.extraAppeared)
  )
  return truncate ? id.slice(0, 12) : id
}
function drift(point) {
  if (state.drifted || state.driftAt !== point) return
  state.containers[state.driftTarget].composeProject = state.composeProject
  state.containers[state.driftTarget].composeService = state.composeService
  state.current = state.driftTarget
  state.composeSource = state.containers[state.driftTarget].dataSource
  state.containers[state.driftTarget].running = true
  state.drifted = true
  state.events.push(['drift', point, state.driftTarget])
}
function materializeExtra(point) {
  if (state.extraAppeared || state.extraAt !== point) return
  const extra = state.containers[state.extraTarget]
  extra.composeProject = state.composeProject
  extra.composeService = state.composeService
  extra.running = true
  state.extraAppeared = true
  state.events.push(['extra-service', point, state.extraTarget])
}
function injectExternalNetwork(point) {
  if (state.externalNetworkInjected || state.externalNetworkAt !== point) return
  const container = state.containers[state.current]
  container.networks.push({
    name: 'unexpected-network',
    networkId: 'f'.repeat(64),
    aliases: ['unexpected-app'],
    runtimeMacAddress: '02:42:ac:13:00:77',
  })
  container.isolated = false
  state.externalNetworkInjected = true
  state.events.push(['external-network-connect', point, state.current])
}
function startContainer(id, source) {
  if (!state.containers[id]) process.exit(79)
  state.containers[id].running = true
  state.events.push([source, id])
  const startState = process.env.TEST_START_STATE || ''
  const wal = process.env.TEST_WAL_PATH || ''
  const shm = process.env.TEST_SHM_PATH || ''
  if (startState) {
    fs.appendFileSync(startState, JSON.stringify({
      walExists: wal ? fs.existsSync(wal) : null,
      shmExists: shm ? fs.existsSync(shm) : null,
    }) + '\\n')
  }
  if (process.env.TEST_CREATE_SIDECARS_ON_START === '1') {
    if (wal) fs.writeFileSync(wal, 'NEW-DB-WAL')
    if (shm) fs.writeFileSync(shm, 'NEW-DB-SHM')
  }
}

if (args[0] === 'inspect') {
  const id = resolveId(args.at(-1))
  const container = state.containers[id]
  if (!container) process.exit(79)
  if (process.env.TEST_INSPECT_FAIL_ID === id) process.exit(78)
  const formatAt = args.indexOf('--format')
  const format = formatAt >= 0 ? args[formatAt + 1] : ''
  if (format.includes('com.docker.compose.project')) {
    console.log(
      container.composeProject + '\\t' + container.composeService + '\\tFalse\\t' + container.composeConfigHash,
    )
  } else if (format.includes('.Id')) {
    console.log(process.env.TEST_INSPECT_ID_OVERRIDE || id)
  } else if (format.includes('.Image')) {
    if (process.env.TEST_IMAGE_INSPECT_DELAY_MS) {
      spawnSync('sleep', [String(Number(process.env.TEST_IMAGE_INSPECT_DELAY_MS) / 1000)])
    }
    console.log(container.image)
  } else if (format.includes('XJM_NETWORK_ID')) {
    for (const network of container.networks) {
      console.log('XJM_NETWORK_ID\\t' + network.networkId)
    }
  } else if (format.includes('XJM_NETWORK_RECORD')) {
    for (const network of container.networks) {
      console.log([
        'XJM_NETWORK_RECORD',
        network.name,
        network.networkId,
        ...network.aliases,
      ].join('\\t'))
    }
  } else if (
    format.includes('IPAMConfig') ||
    format.includes('GwPriority') ||
    format.includes('DriverOpts') ||
    format.includes('Links')
  ) {
    for (const network of container.networks) {
      if (format.includes('IPv4Address') && network.staticIpv4) {
        console.log(network.name + '\tstatic-ipv4')
      }
      if (format.includes('GwPriority') && network.gwPriority) {
        console.log(network.name + '\tgw-priority\t' + network.gwPriority)
      }
    }
  } else if (format.includes('NetworkSettings.Networks')) {
    for (const network of container.networks) {
      console.log([network.name, ...network.aliases].join('\\t'))
    }
  } else if (format.includes('.State.Running')) {
    console.log(container.running ? 'true' : 'false')
  } else if (format.includes('XJM_BIND')) {
    console.log('XJM_BIND\\t' + container.dataSource + '\\t/app/data')
    for (const bind of container.extraBinds || []) {
      console.log('XJM_BIND\\t' + bind.source + '\\t' + bind.target)
    }
  } else {
    console.log('bind\\t' + container.dataSource)
  }
  process.exit(0)
}

if (args[0] === 'stop') {
  const id = resolveId(args.at(-1))
  if (state.containers[id]) {
    const publicStage = path.join(state.containers[id].dataSource, '.restore-in-progress', 'snapshot.db')
    if (process.env.TEST_PRESTOP_STAGE_OBSERVATION) {
      fs.writeFileSync(
        process.env.TEST_PRESTOP_STAGE_OBSERVATION,
        JSON.stringify({
          publicLockVisible: fs.existsSync(path.dirname(publicStage)),
          publicStageVisible: fs.existsSync(publicStage),
        }),
      )
    }
    if (process.env.TEST_MUTATE_PUBLIC_STAGE_BEFORE_STOP === '1' && fs.existsSync(publicStage)) {
      fs.writeFileSync(publicStage, 'APP-TAMPERED-STAGE')
    }
    state.containers[id].running = false
    state.events.push(['stop', id])
    drift('after-stop')
    materializeExtra('after-stop')
    save()
  }
  process.exit(Number(process.env.TEST_DOCKER_STOP_EXIT || 0))
}

if (args[0] === 'start') {
  drift('before-start')
  materializeExtra('before-start')
  const id = resolveId(args.at(-1))
  startContainer(id, 'start')
  drift('after-start')
  materializeExtra('after-start')
  save()
  if (process.env.TEST_BLOCK_START_AFTER_DRIFT === '1') {
    if (process.env.TEST_START_AFTER_DRIFT_ENTERED) {
      fs.writeFileSync(process.env.TEST_START_AFTER_DRIFT_ENTERED, '')
    }
    while (true) spawnSync('sleep', ['1'])
  }
  process.exit(0)
}

if (args[0] === 'network') {
  const action = args[1]
  const id = resolveId(args.at(-1))
  const networkRef = args.at(-2)
  const container = state.containers[id]
  if (!container) process.exit(79)
  state.networkCatalog ||= {}
  if (action === 'disconnect') {
    const requestedNetwork = container.networks.find(
      (network) => network.name === networkRef || network.networkId === networkRef,
    )
    const resolvedNetworkName = requestedNetwork?.name || state.networkCatalog[networkRef]?.name || networkRef
    if (requestedNetwork) state.networkCatalog[requestedNetwork.networkId] = requestedNetwork
    if (
      process.env.TEST_FAIL_ROLLBACK_DISCONNECT === '1' &&
      state.events.some((event) => event[0] === 'network-connect-failed')
    ) {
      state.events.push(['network-disconnect-failed', resolvedNetworkName, id])
      save()
      process.exit(77)
    }
    container.networks = container.networks.filter(
      (network) => network.name !== networkRef && network.networkId !== networkRef,
    )
    container.isolated = container.networks.length === 0
    state.events.push(['network-disconnect', resolvedNetworkName, id])
  } else if (action === 'connect') {
    const aliases = []
    for (let i = 2; i < args.length - 2; i++) {
      if (args[i] === '--alias') aliases.push(args[++i])
    }
    const catalogNetwork = state.networkCatalog[networkRef]
    const networkName = catalogNetwork?.name || networkRef
    if (process.env.TEST_FAIL_NETWORK_CONNECT === networkName ||
        process.env.TEST_FAIL_NETWORK_CONNECT === networkRef) {
      state.events.push(['network-connect-failed', networkName, id])
      save()
      process.exit(76)
    }
    if (process.env.TEST_BLOCK_NETWORK_CONNECT_BEFORE_EFFECT === networkName) {
      state.events.push(['network-connect-blocked-before-effect', networkName, id])
      save()
      if (process.env.TEST_NETWORK_CONNECT_ENTERED) {
        fs.writeFileSync(process.env.TEST_NETWORK_CONNECT_ENTERED, '')
      }
      while (true) spawnSync('sleep', ['1'])
    }
    if (!container.networks.some((network) => network.networkId === networkRef)) {
      container.networks.push({
        name: networkName,
        networkId: networkRef,
        aliases,
        runtimeMacAddress: '02:42:ac:12:00:99',
      })
    }
    container.isolated = false
    save()
    if (process.env.TEST_BLOCK_NETWORK_CONNECT_AFTER_EFFECT === networkName) {
      state.events.push(['network-connect-blocked-after-effect', networkName, id])
      save()
      if (process.env.TEST_NETWORK_CONNECT_ENTERED) {
        fs.writeFileSync(process.env.TEST_NETWORK_CONNECT_ENTERED, '')
      }
      while (true) spawnSync('sleep', ['1'])
    }
    const accepted = fs.existsSync(path.join(container.dataSource + '.restore-control', 'ready-accepted'))
    state.events.push([
      'network-connect',
      networkName,
      networkRef,
      id,
      accepted ? 'accepted' : 'unaccepted',
      ...aliases,
    ])
  }
  save()
  process.exit(0)
}

if (args[0] === 'exec') {
  let cursor = 1
  while (cursor < args.length && args[cursor].startsWith('-')) {
    cursor += args[cursor] === '--user' ? 2 : 1
  }
  const id = resolveId(args[cursor])
  const container = state.containers[id]
  if (!container || !container.running) process.exit(79)
  injectExternalNetwork('before-ready')
  state.events.push(['exec-readiness', id, String(container.networks.length)])
  save()
  if (process.env.TEST_READY_ENTERED) fs.writeFileSync(process.env.TEST_READY_ENTERED, '')
  if (process.env.TEST_READY_BLOCK_MS) {
    spawnSync('sleep', [String(Number(process.env.TEST_READY_BLOCK_MS) / 1000)])
  }
  const body = process.env.TEST_READY_BODY ?? '{"ok":true}'
  const status = process.env.TEST_READY_STATUS || '200'
  process.stdout.write(body)
  process.exit(Number(process.env.TEST_READY_EXIT || (status === '200' ? 0 : 8)))
}
if (args[0] === 'ps') {
  let idFilter = ''
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i] === '--filter' && args[i + 1].startsWith('id=')) {
      idFilter = args[++i].slice(3)
    }
  }
  if (!idFilter && process.env.TEST_FAIL_SERVICE_PS_WHEN_EXTRA === '1' && state.extraAppeared) {
    state.events.push(['service-enumeration-failed', 'docker-ps'])
    save()
    process.exit(78)
  }
  const resolvedIdFilter = idFilter ? resolveId(idFilter) : ''
  for (const [id, container] of Object.entries(state.containers)) {
    if (resolvedIdFilter && id !== resolvedIdFilter) continue
    if (container.composeProject === state.composeProject && container.composeService === state.composeService) {
      console.log(renderId(id))
    }
  }
  process.exit(0)
}
if (args[0] !== 'compose') process.exit(0)

if (args[1] === 'ps') {
  if (process.env.TEST_FAIL_COMPOSE_PS_ALWAYS === '1' ||
      (process.env.TEST_FAIL_COMPOSE_PS_WHEN_EXTRA === '1' && state.extraAppeared)) {
    state.events.push(['service-enumeration-failed', 'compose-ps'])
    save()
    process.exit(79)
  }
  if (state.current) console.log(renderId(state.current))
  process.exit(0)
}
if (args[1] === 'create') {
  if (!state.current && state.createId) {
    state.current = state.createId
    state.composeSource = state.containers[state.createId].dataSource
    state.events.push(['compose-create', state.createId])
    save()
  }
  process.exit(0)
}
if (args[1] === 'stop') {
  const id = state.current
  if (id) {
    state.containers[id].running = false
    state.events.push(['compose-stop', id])
    drift('after-stop')
    materializeExtra('after-stop')
    save()
  }
  process.exit(0)
}
if (args[1] === 'start') {
  drift('before-start')
  materializeExtra('before-start')
  const id = state.current
  startContainer(id, 'compose-start')
  drift('after-start')
  materializeExtra('after-start')
  save()
  process.exit(0)
}
if (args[1] === 'config') {
  const control = state.composeSource + '.restore-control'
  if (fs.existsSync(path.join(control, 'network-published'))) {
    materializeExtra('after-published')
    save()
  }
  if (
    process.env.TEST_BLOCK_AFTER_NETWORK_PUBLISHED === '1' &&
    fs.existsSync(path.join(control, 'network-published'))
  ) {
    if (process.env.TEST_AFTER_NETWORK_PUBLISHED_ENTERED) {
      fs.writeFileSync(process.env.TEST_AFTER_NETWORK_PUBLISHED_ENTERED, '')
    }
    while (true) spawnSync('sleep', ['1'])
  }
  if (args.includes('--hash')) {
    console.log('app ' + state.composeConfigHash)
    process.exit(0)
  }
  const formatAt = args.indexOf('--format')
  if (formatAt >= 0 && args[formatAt + 1] === 'json') {
    const app = { volumes: [
      { type: 'bind', source: state.composeSource, target: '/app/data', bind: {} },
      ...(state.composeExtraBinds || []).map((bind) => ({ type: 'bind', ...bind, bind: {} })),
    ] }
    if (state.composeNetworkMode === 'static-ipv4') {
      app.networks = { 'stub-network': { ipv4_address: '172.30.0.10' } }
    } else if (state.composeNetworkMode === 'interface-name') {
      app.networks = { 'stub-network': { interface_name: 'eth42' } }
    } else if (state.composeNetworkMode === 'mac-address') {
      app.networks = { 'stub-network': { mac_address: '02:11:22:33:44:55' } }
    } else if (state.composeNetworkMode === 'env-interface-name') {
      app.networks = { 'stub-network': {} }
      app.environment = { interface_name: 'diagnostic-only' }
    }
    console.log(JSON.stringify({ services: { app } }, null, 2))
  }
  process.exit(0)
}
if (args[1] === 'run') {
  const base = spawnSync(process.execPath, [process.env.TEST_BASE_DOCKER_STUB, ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  process.exit(base.status ?? 1)
}
process.exit(0)
`

function installReadyCurlStub(dir: string): void {
  fs.writeFileSync(path.join(dir, 'curl'), READY_CURL_STUB, { mode: 0o755 })
}

function installArmedMarkerFailureBin(root: string): string {
  const dir = path.join(root, 'armed-marker-fail-bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(dir)
  fs.writeFileSync(
    path.join(dir, 'install'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
if [ "$target" = "$TEST_FAIL_INSTALL_TARGET" ]; then
  exit 73
fi
/usr/bin/install "$@"
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'mktemp'),
    `#!/bin/sh
if [ "$1" = "$TEST_FAIL_MKTEMP_TEMPLATE" ]; then
  exit 73
fi
/usr/bin/mktemp "$@"
`,
    { mode: 0o755 },
  )
  return dir
}

const CONTAINER_A = 'a'.repeat(64)
const CONTAINER_B = 'b'.repeat(64)
const NETWORK_ID = 'd'.repeat(64)

type DockerState = {
  current: string
  composeSource: string
  composeProject: string
  composeService: string
  composeConfigHash: string
  composeNetworkMode?: 'static-ipv4' | 'interface-name' | 'mac-address' | 'env-interface-name'
  composeExtraBinds?: Array<{ source: string; target: string }>
  createId?: string
  driftAt?: 'after-stop' | 'before-start' | 'after-start'
  driftTarget?: string
  drifted?: boolean
  extraAt?: 'after-stop' | 'before-start' | 'after-start' | 'after-published'
  extraTarget?: string
  extraAppeared?: boolean
  externalNetworkAt?: 'before-ready'
  externalNetworkInjected?: boolean
  containers: Record<string, {
    dataSource: string
    image: string
    running: boolean
    isolated: boolean
    composeProject: string
    composeService: string
    composeConfigHash: string
    extraBinds?: Array<{ source: string; target: string }>
    networks: Array<{
      name: string
      networkId: string
      aliases: string[]
      staticIpv4?: boolean
      runtimeMacAddress?: string
      gwPriority?: number
    }>
  }>
  events: string[][]
}

function makeDockerState(dataA: string, dataB?: string): DockerState {
  const containers: DockerState['containers'] = {
    [CONTAINER_A]: {
      dataSource: dataA,
      image: 'sha256:' + '1'.repeat(64),
      running: true,
      isolated: false,
      composeProject: 'xiaojimao-hub',
      composeService: 'app',
      composeConfigHash: 'c'.repeat(64),
      networks: [{
        name: 'stub-network',
        networkId: NETWORK_ID,
        aliases: ['app', 'stub-app-a'],
        runtimeMacAddress: '02:42:ac:12:00:02',
        gwPriority: 0,
      }],
    },
  }
  if (dataB) {
    containers[CONTAINER_B] = {
      dataSource: dataB,
      image: 'sha256:' + '2'.repeat(64),
      running: false,
      isolated: false,
      composeProject: 'not-yet-compose-service',
      composeService: 'app',
      composeConfigHash: 'c'.repeat(64),
      networks: [{
        name: 'stub-network',
        networkId: NETWORK_ID,
        aliases: ['app', 'stub-app-b'],
        runtimeMacAddress: '02:42:ac:12:00:03',
        gwPriority: 0,
      }],
    }
  }
  return {
    current: CONTAINER_A,
    composeSource: dataA,
    composeProject: 'xiaojimao-hub',
    composeService: 'app',
    composeConfigHash: 'c'.repeat(64),
    containers,
    events: [],
  }
}

function installStatefulDockerBin(root: string): { dir: string; stateFile: string } {
  const dir = path.join(root, 'stateful-bin')
  fs.mkdirSync(dir, { recursive: true })
  const stateFile = path.join(root, 'docker-state.json')
  fs.writeFileSync(path.join(dir, 'docker-stateful.mjs'), STATEFUL_DOCKER_STUB)
  fs.writeFileSync(
    path.join(dir, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'docker-stateful.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(dir)
  return { dir, stateFile }
}

function readDockerState(stateFile: string): DockerState {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as DockerState
}

const OWNER_TEST_BOOT_ID = '11111111-2222-4333-8444-555555555555'

function linuxOwnerFingerprint(startTicks: string, bootId = OWNER_TEST_BOOT_ID): string {
  return `v2 linux-proc ${bootId} ${startTicks}`
}

function installLinuxOwnerProbeBin(
  dir: string,
): { sudoPath: string; probeLog: string } {
  const probeLog = path.join(dir, 'owner-probe.log')
  const sudoPath = path.join(dir, 'sudo-owner-probe')
  fs.writeFileSync(probeLog, '')
  fs.writeFileSync(
    path.join(dir, 'uname'),
    '#!/bin/sh\nprintf \'%s\\n\' Linux\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'id'),
    `#!/bin/sh
case "$1" in
  -u) printf '%s\\n' 2001 ;;
  -g) printf '%s\\n' 2001 ;;
  *) exec /usr/bin/id "$@" ;;
esac
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    sudoPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_OWNER_PROBE_LOG"
if [ "$1" = "id" ] && [ "$2" = "-u" ]; then
  printf '%s\\n' 0
  exit 0
fi
if [ "$1" = "cat" ] && [ "$2" = "--" ]; then
  case "$3" in
    /proc/sys/kernel/random/boot_id)
      printf '%s\\n' "$TEST_OWNER_BOOT_ID"
      exit 0
      ;;
    /proc/*/stat)
      case "$TEST_OWNER_PROC_MODE" in
        denied) exit 13 ;;
        dead) exit 1 ;;
      esac
      pid=\${3#/proc/}
      pid=\${pid%/stat}
      ticks="$TEST_OWNER_CURRENT_TICKS"
      # field 2 (comm) intentionally contains spaces and a ')' so production must
      # strip through the final ") " before taking field 22 (remaining field 20).
      printf '%s\\n' "$pid (root restore ) worker) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 $ticks 0"
      exit 0
      ;;
  esac
fi
if [ "$1" = "test" ] && [ "$2" = "-d" ]; then
  if [ "$3" = "/proc" ]; then exit 0; fi
  if [ "$3" = "/proc/$TEST_OWNER_PID" ]; then
    [ "$TEST_OWNER_PROC_MODE" != "dead" ]
    exit $?
  fi
fi
if [ "$1" = "find" ] && [ "$2" = "/proc" ]; then
  case "$TEST_OWNER_PROC_MODE" in
    denied) exit 13 ;;
    dead)
      printf '%s\\n' /proc/1
      exit 0
      ;;
  esac
  printf '%s\\n' /proc/1 "/proc/$TEST_OWNER_PID"
  exit 0
fi
exec "$@"
`,
    { mode: 0o755 },
  )
  return { sudoPath, probeLog }
}

function installDirectLinuxOwnerProbeBin(dir: string): { probeLog: string } {
  const probeLog = path.join(dir, 'owner-direct-probe.log')
  fs.writeFileSync(probeLog, '')
  fs.writeFileSync(
    path.join(dir, 'uname'),
    '#!/bin/sh\nprintf \'%s\\n\' Linux\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'id'),
    `#!/bin/sh
case "$1" in
  -u) printf '%s\\n' 2001 ;;
  -g) printf '%s\\n' 2001 ;;
  *) exec /usr/bin/id "$@" ;;
esac
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'cat'),
    `#!/bin/sh
printf 'cat %s\\n' "$*" >> "$TEST_OWNER_PROBE_LOG"
if [ "$1" = "--" ]; then
  case "$2" in
    /proc/sys/kernel/random/boot_id)
      printf '%s\\n' "$TEST_OWNER_BOOT_ID"
      exit 0
      ;;
    /proc/*/stat)
      exit 1
      ;;
  esac
fi
exec /bin/cat "$@"
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(dir, 'find'),
    `#!/bin/sh
printf 'find %s\\n' "$*" >> "$TEST_OWNER_PROBE_LOG"
if [ "$1" = "/proc" ]; then
  printf '%s\\n' /proc/1
  exit 0
fi
exec /usr/bin/find "$@"
`,
    { mode: 0o755 },
  )
  return { probeLog }
}

function ownerResidualCase(
  name: string,
  ownerPid: string,
  ownerFingerprint: string,
): {
  dataDir: string
  backupsDir: string
  snap: string
  control: string
  dockerBin: string
  stateFile: string
} {
  const root = fs.mkdtempSync(path.join(tmpDir, name + '-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-owner-probe.db')
  makeSnapshot(snap, 'UNUSED')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  fs.mkdirSync(control, { mode: 0o700 })
  fs.writeFileSync(path.join(control, 'app-started'), '', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'container-id'), CONTAINER_A + '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-project'), 'xiaojimao-hub\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-service'), 'app\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'owner-pid'), ownerPid + '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'owner-start-fingerprint'), ownerFingerprint + '\n', { mode: 0o600 })
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir)))
  return { dataDir, backupsDir, snap, control, dockerBin, stateFile }
}

function writeDefinitelyStaleOwnerEvidence(control: string): void {
  const ownerPid = String(process.pid)
  let fingerprint: string
  if (process.platform === 'linux') {
    const currentBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const staleBootId = currentBootId === '00000000-0000-4000-8000-000000000000'
      ? 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      : '00000000-0000-4000-8000-000000000000'
    fingerprint = linuxOwnerFingerprint('1', staleBootId)
  } else if (process.platform === 'darwin') {
    fingerprint = `v2 darwin-ps ${process.getuid?.() ?? 0} 0:0`
  } else {
    throw new Error(`owner residual fixture 仅支持 Linux/Darwin，当前为 ${process.platform}`)
  }
  fs.writeFileSync(path.join(control, 'owner-pid'), ownerPid + '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'owner-start-fingerprint'), fingerprint + '\n', { mode: 0o600 })
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-restore-'))
  originalTmpDir = process.env.TMPDIR
  // restore 的 SIGKILL 回归会故意阻止 shell cleanup；把子进程 mktemp 也收进本测试沙箱，
  // 由 after() 连同其余 fixture 一次清理，避免在宿主 TMPDIR 遗留 0600 readiness body。
  process.env.TMPDIR = tmpDir
  binDir = path.join(tmpDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  fs.writeFileSync(path.join(binDir, 'docker-stub.mjs'), DOCKER_STUB)
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  // 宿主 curl 是 fail-fast sentinel：restore readiness 必须从 exact 容器内 loopback 探测。
  installReadyCurlStub(binDir)
  process.env.TEST_BASE_DOCKER_STUB = path.join(binDir, 'docker-stub.mjs')
})

after(() => {
  delete process.env.TEST_BASE_DOCKER_STUB
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } finally {
    if (originalTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpDir
  }
})

// 建一个带 marker 行的真 WAL 库，用于分辨「还原出来的到底是哪一份」。
// 用于**活库**（data/app.db）——生产里 app.db 就是 WAL 模式，必须保持一致。
function makeDb(p: string, marker: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.rmSync(p, { force: true })
  const d = new DatabaseSync(p)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('CREATE TABLE marker (v TEXT)')
  d.prepare('INSERT INTO marker (v) VALUES (?)').run(marker)
  d.close()
}

// 建一份**快照**：与 backupDb() 的产物同形态——VACUUM INTO 出来的一致性单文件，
// 文件头 offset 18/19 = 1/1（journal 模式，自足）。
//
// 🔴 R7-P1① 起，restore.sh 拒绝 WAL 模式（头字节 2/2）的快照主文件，因为那种文件的已提交数据
//    可能只在配套 -wal 里、单独还原会静默丢数据。所以快照类 fixture 必须走 VACUUM INTO，
//    不能再用 makeDb（那是 WAL 活库、现在会被守卫正确拒掉）。
//    这正是本文件里「活库」与「快照」两个角色第一次必须分开构造：以前脚本两者都收，一个
//    makeDb 混用没问题；现在脚本对快照有了更强的要求，fixture 也得跟着分。
function makeSnapshot(p: string, marker: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.rmSync(p, { force: true })
  fs.rmSync(backupManifestPath(p), { force: true })
  const stage = p + '.stage'
  fs.rmSync(stage, { force: true })
  const d = new DatabaseSync(stage)
  try {
    d.exec('CREATE TABLE marker (v TEXT)')
    d.prepare('INSERT INTO marker (v) VALUES (?)').run(marker)
    d.prepare('VACUUM INTO ?').run(p)
  } finally {
    d.close()
  }
  fs.rmSync(stage, { force: true })
  const hdr = fs.readFileSync(p).subarray(18, 20)
  assert.deepEqual(
    [hdr[0], hdr[1]],
    [1, 1],
    '前置：快照 fixture 必须是 journal 模式（头 1/1），否则会被 R7-P1① 守卫拒掉',
  )
  fs.chmodSync(p, 0o600)
  writeBackupManifestFixture(p)
}

function refreshSnapshotManifest(p: string): void {
  fs.chmodSync(p, 0o600)
  fs.rmSync(backupManifestPath(p), { force: true })
  writeBackupManifestFixture(p)
}

function rewriteManifest(p: string, mutate: (value: Record<string, unknown>) => void): void {
  const manifestPath = backupManifestPath(p)
  const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  mutate(value)
  fs.writeFileSync(manifestPath, JSON.stringify(value) + '\n', { mode: 0o600 })
  fs.chmodSync(manifestPath, 0o600)
}

function readMarker(p: string): string {
  const d = new DatabaseSync(p, { readOnly: true })
  try {
    return (d.prepare('SELECT v FROM marker').get() as unknown as { v: string }).v
  } finally {
    d.close()
  }
}

// 建一套沙箱场景：<case>/data/app.db + <case>/data/backups/
function scene(name: string, appMarker: string): { dataDir: string; backupsDir: string } {
  const root = fs.mkdtempSync(path.join(tmpDir, name + '-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), appMarker)
  return { dataDir, backupsDir }
}

function runRestore(
  dataDir: string,
  backupsDir: string,
  snapshot: string,
  envOverrides: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string; log: string } {
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snapshot], {
    cwd: REPO, // 脚本要求在 compose 所在目录（仓库根）跑
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '', // 沙箱里当前用户就是属主，不用 sudo（也避免测试弹密码）
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      ...envOverrides,
    },
    encoding: 'utf8',
  })
  return {
    status: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    log: fs.readFileSync(logFile, 'utf8'),
  }
}

function runStatefulRestore(
  dataDir: string,
  backupsDir: string,
  snapshot: string,
  dockerBin: string,
  dockerStateFile: string,
  envOverrides: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string; log: string } {
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snapshot], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${dockerBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      TEST_DOCKER_STATE: dockerStateFile,
      ...envOverrides,
    },
    encoding: 'utf8',
  })
  return {
    status: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    log: fs.readFileSync(logFile, 'utf8'),
  }
}

function spawnStatefulRestore(
  dataDir: string,
  backupsDir: string,
  snapshot: string,
  dockerBin: string,
  dockerStateFile: string,
  envOverrides: NodeJS.ProcessEnv = {},
): {
  child: ReturnType<typeof spawn>
  exited: ReturnType<typeof collectExit>
  logFile: string
} {
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const child = spawn('sh', [RESTORE_SH, snapshot], {
    cwd: REPO,
    detached: true,
    env: {
      ...process.env,
      PATH: `${dockerBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      TEST_DOCKER_STATE: dockerStateFile,
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { child, exited: collectExit(child, 30_000), logFile }
}

function publicationCase(name: string): {
  root: string
  dataDir: string
  backupsDir: string
  snap: string
  dockerBin: string
  stateFile: string
} {
  const root = fs.mkdtempSync(path.join(tmpDir, name + '-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-publication.db')
  makeSnapshot(snap, 'ACCEPTED-SNAPSHOT')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir)))
  return { root, dataDir, backupsDir, snap, dockerBin, stateFile }
}

async function waitForFile(p: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return
    await delay(20)
  }
  throw new Error(`等待测试握手文件超时：${p}`)
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(20)
  }
  throw new Error(message)
}

function collectExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`restore 子进程 ${timeoutMs}ms 内未退出`)), timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  assert.ok(child.pid, '子进程必须有 pid')
  process.kill(-child.pid, signal)
}

async function sigkillAtFile(
  child: ReturnType<typeof spawn>,
  exited: ReturnType<typeof collectExit>,
  entered: string,
  beforeKill: () => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  try {
    await Promise.race([
      waitForFile(entered, 20_000),
      exited.then((result) => {
        throw new Error(
          `restore 在目标 SIGKILL 窗口前提前退出：code=${result.code} signal=${result.signal}\n${result.stdout}\n${result.stderr}`,
        )
      }),
    ])
    beforeKill()
    killProcessGroup(child, 'SIGKILL')
    const killed = await exited
    assert.equal(killed.code, null)
    assert.equal(killed.signal, 'SIGKILL')
    return killed
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { killProcessGroup(child, 'SIGKILL') } catch {}
    }
  }
}

// ① 🔴🔴 必修 1 的核心回归：从 pre-restore.db 二次反悔
//    用户跑过一次 restore、发现还是不对，想拿 pre-restore.db 回到最初状态——最自然的路径。
//    修复前：脚本先用**当前 app.db** 重建同名的 pre-restore.db，把恢复源就地覆盖掉，
//    再 install 它 → app.db 原封不动还是坏的那份，而唯一回滚点已经没了。
//    最毒的是全程不报错：打印 ✅、/api/ready 也过（库合法、schema 版本也对），用户不会发现。
test('必修1：从 pre-restore.db 还原 → 拿到的是 ORIGINAL，不是被当前库覆盖后的内容', () => {
  const { dataDir, backupsDir } = scene('self-destruct', 'CURRENT-BROKEN')
  const snap = path.join(backupsDir, 'pre-restore.db')
  makeSnapshot(snap, 'ORIGINAL')

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)

  assert.equal(
    readMarker(path.join(dataDir, 'app.db')),
    'ORIGINAL',
    '🔴 还原出来的必须是快照内容；拿到 CURRENT-BROKEN 说明快照在被读取前就被本次运行覆盖了（静默丢数据）',
  )
  // 同时：新的回滚点应当是这次还原前的现场
  assert.equal(
    readMarker(snap),
    'CURRENT-BROKEN',
    'pre-restore.db 应更新为本次还原前的现场（下一次反悔的回滚点）',
  )
  // 私有 stage / 状态锁要清掉，不留整库副本
  assert.ok(
    !fs.existsSync(path.join(dataDir, '.restore-in-progress')),
    '成功后私有 restore 锁目录应被释放',
  )
})

// ①b 常规还原（快照是某份 backup-*.db）不受必修 1 的改动影响
test('必修1 回归：从 backup-*.db 常规还原仍正确，且现场存进 pre-restore.db', () => {
  const { dataDir, backupsDir } = scene('normal', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-26T01-00-00-a1b2c3.db')
  makeSnapshot(snap, 'SNAPSHOT-A')

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)

  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-A')
  assert.equal(readMarker(path.join(backupsDir, 'pre-restore.db')), 'CURRENT', '现场应被留存')
  assert.equal(readMarker(snap), 'SNAPSHOT-A', '快照本身不该被改动')
  // 现场留存走的是 VACUUM INTO（不是 cp）：桩 docker 收到过 run 调用
  assert.match(r.log, /"run"/, '现场留存必须借容器跑 VACUUM INTO，不能退化成 cp')
  const preRestore = path.join(backupsDir, 'pre-restore.db')
  assert.doesNotThrow(() => {
    const manifest = JSON.parse(fs.readFileSync(backupManifestPath(preRestore), 'utf8')) as { name: string }
    assert.equal(manifest.name, 'pre-restore.db')
  }, '现场留存必须发布 matching manifest')
})

test('P6-R2 validator：不继承 Compose service，使用 exact image + 最小只读隔离容器', () => {
  const { dataDir, backupsDir } = scene('isolated-validator-contract', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-validator-contract.db')
  makeSnapshot(snap, 'VALIDATOR-SNAPSHOT')

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  const calls = r.log
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
  const validatorCreate = calls.find(
    (args) => args[0] === 'create' && args.some((arg) => arg.includes('dst=/snap.db')),
  )
  assert.ok(validatorCreate, '快照校验必须走 docker create，而不是 docker compose run')
  assert.ok(validatorCreate.includes('--network') && validatorCreate.includes('none'))
  assert.ok(validatorCreate.includes('--read-only'))
  assert.ok(validatorCreate.includes('--cap-drop') && validatorCreate.includes('ALL'))
  assert.ok(validatorCreate.includes('--security-opt') && validatorCreate.includes('no-new-privileges'))
  assert.ok(validatorCreate.includes('--user') && validatorCreate.includes('0:0'))
  const commandAt = validatorCreate.indexOf('-e')
  assert.equal(validatorCreate[commandAt - 1], `sha256:${'1'.repeat(64)}`, '必须直接使用已捕获 exact image ID')
  const mounts = validatorCreate
    .map((arg, index) => validatorCreate[index - 1] === '--mount' ? arg : '')
    .filter(Boolean)
  assert.equal(mounts.length, 1)
  assert.match(mounts[0], /dst=\/snap\.db,readonly$/)
  assert.doesNotMatch(mounts[0], /\/app\/data/)
  assert.ok(!calls.some(
    (args) => args[0] === 'compose' && args[1] === 'run' && args.some((arg) => arg.includes('/snap.db')),
  ))
  assert.ok(calls.some((args) => args[0] === 'rm' && args.includes('-f')), 'validator 必须显式清理')
})

for (const validatorFailure of [
  { label: 'image inspect 失败', env: { TEST_VALIDATOR_IMAGE_INSPECT_FAIL: '1' }, created: false },
  { label: 'create 失败', env: { TEST_VALIDATOR_CREATE_FAIL: '1' }, created: false },
  { label: 'inspect 失败', env: { TEST_VALIDATOR_INSPECT_FAIL: '1' }, created: true },
  { label: 'service Env 漂入', env: { TEST_VALIDATOR_ENV_DRIFT: '1' }, created: true },
  { label: '执行失败', env: { TEST_VALIDATOR_START_FAIL: '1' }, created: true },
  { label: 'cleanup 失败', env: { TEST_VALIDATOR_RM_FAIL: '1' }, created: true },
] as const) {
  test(`P6-R2 validator fail-closed：${validatorFailure.label} 不得停 app 或改活库`, () => {
    const { dataDir, backupsDir } = scene(`validator-fail-${validatorFailure.label}`, 'CURRENT')
    const snap = path.join(backupsDir, 'backup-validator-failure.db')
    makeSnapshot(snap, 'VALIDATOR-SNAPSHOT')
    const liveBefore = fs.readFileSync(path.join(dataDir, 'app.db'))

    const r = runRestore(dataDir, backupsDir, snap, validatorFailure.env)
    assert.equal(r.status, 1, `${validatorFailure.label} 必须 fail-closed：\n${r.stdout}\n${r.stderr}`)
    assert.doesNotMatch(r.log, /"stop"/, 'validator 失败必须发生在停 app 前')
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'app.db')), liveBefore)
    if (validatorFailure.created) assert.match(r.log, /\["rm","-f"/, '已 create 的 validator 必须尝试清理')
  })
}

test('P6-R2-R8 provenance：hot rollback-journal 裸拷即使 1/1 + quick_check=ok 也因无 manifest 被拒', () => {
  const { dataDir, backupsDir } = scene('hot-rollback-bare-copy', 'CURRENT')
  const live = path.join(backupsDir, 'hot-live.db')
  const snap = path.join(backupsDir, 'backup-hot-bare-copy.db')
  const d = new DatabaseSync(live)
  d.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA cache_size=5;
    PRAGMA cache_spill=ON;
    CREATE TABLE t(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    BEGIN;
  `)
  const insert = d.prepare('INSERT INTO t(payload) VALUES (?)')
  for (let i = 0; i < 5000; i++) insert.run('BASE'.padEnd(1000, 'x'))
  d.exec('COMMIT; BEGIN IMMEDIATE;')
  const update = d.prepare('UPDATE t SET payload=? WHERE id=?')
  for (let i = 1; i <= 5000; i++) update.run('DIRTY'.padEnd(1000, 'y'), i)
  assert.ok(fs.existsSync(live + '-journal'), '前置：真实 rollback journal 必须存在')
  fs.copyFileSync(live, snap)
  d.exec('ROLLBACK')
  d.close()
  fs.chmodSync(snap, 0o600)

  const header = fs.readFileSync(snap).subarray(18, 20)
  assert.deepEqual([...header], [1, 1], '前置：裸拷 header 仍是 1/1')
  const copied = new DatabaseSync(`file:${snap}?immutable=1`, { readOnly: true })
  const quick = copied.prepare('PRAGMA quick_check').get() as { quick_check: string }
  const dirty = copied.prepare("SELECT count(*) AS n FROM t WHERE payload LIKE 'DIRTY%'").get() as { n: number }
  copied.close()
  assert.equal(quick.quick_check, 'ok', '前置：quick_check 仍会误报 ok')
  assert.ok(dirty.n >= 4995, `前置：裸拷应含随后 rollback 的未提交行，实际 ${dirty.n}`)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /manifest|provenance|legacy 裸 \.db/i)
  assert.doesNotMatch(r.log, /"stop"/, 'provenance 拒绝必须发生在停机前')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
})

for (const manifestCase of [
  { label: '缺 manifest', mutate: (p: string) => fs.rmSync(backupManifestPath(p)) },
  { label: '错 version', mutate: (p: string) => rewriteManifest(p, (v) => { v.version = 2 }) },
  { label: '错 method', mutate: (p: string) => rewriteManifest(p, (v) => { v.method = 'bare-copy' }) },
  { label: '错 filename', mutate: (p: string) => rewriteManifest(p, (v) => { v.name = 'other.db' }) },
  { label: '错 size', mutate: (p: string) => rewriteManifest(p, (v) => { v.size = Number(v.size) + 1 }) },
  { label: '伪造 digest', mutate: (p: string) => rewriteManifest(p, (v) => { v.sha256 = '0'.repeat(64) }) },
  { label: 'manifest 0644', mutate: (p: string) => fs.chmodSync(backupManifestPath(p), 0o644) },
  { label: 'snapshot 0644', mutate: (p: string) => fs.chmodSync(p, 0o644) },
  { label: 'manifest JSON 截断', mutate: (p: string) => fs.writeFileSync(backupManifestPath(p), '{"version":1', { mode: 0o600 }) },
  { label: 'manifest 非规范序列化', mutate: (p: string) => {
    const manifest = backupManifestPath(p)
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    fs.writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.chmodSync(manifest, 0o600)
  } },
] as const) {
  test(`P6-R2-R8 manifest fail-closed：${manifestCase.label} 在停机前拒绝`, () => {
    const { dataDir, backupsDir } = scene(`manifest-${manifestCase.label.replaceAll(' ', '-')}`, 'CURRENT')
    const snap = path.join(backupsDir, 'backup-manifest-negative.db')
    makeSnapshot(snap, 'SNAPSHOT')
    manifestCase.mutate(snap)
    const r = runRestore(dataDir, backupsDir, snap)
    assert.equal(r.status, 1, `${manifestCase.label} 必须拒绝：\n${r.stdout}\n${r.stderr}`)
    assert.doesNotMatch(r.log, /"stop"/, 'manifest 拒绝必须在停机前')
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  })
}

test('P6-R2-R8 manifest digest：合法 pair 的 snapshot 同大小字节翻转必须在停机前拒绝', () => {
  const { dataDir, backupsDir } = scene('manifest-snapshot-byte-flip', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-manifest-byte-flip.db')
  makeSnapshot(snap, 'SNAPSHOT-BYTE-FLIP')
  const manifest = backupManifestPath(snap)
  const manifestBefore = fs.readFileSync(manifest)
  const snapshotBefore = fs.readFileSync(snap)
  const mutated = Buffer.from(snapshotBefore)
  const index = Math.max(100, Math.floor(mutated.length / 2))
  mutated[index] ^= 0x01
  fs.writeFileSync(snap, mutated, { mode: 0o600 })
  fs.chmodSync(snap, 0o600)

  assert.equal(fs.statSync(snap).size, snapshotBefore.length, 'mutation 必须保持 snapshot size 不变')
  assert.deepEqual(fs.readFileSync(manifest), manifestBefore, 'mutation 不得改 manifest 字节')

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1, `同大小 snapshot 篡改必须被 digest 拒绝：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /SHA-256|digest|manifest/i)
  assert.doesNotMatch(r.log, /"create"|"stop"/, 'digest 拒绝必须早于 validator create 与 app stop')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
})

test('P6-R2-R8 manifest 并发半发布：最终名正在写入时必须立即拒绝且不停 app', async () => {
  const { dataDir, backupsDir } = scene('manifest-concurrent-half-publish', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-manifest-half-published.db')
  makeSnapshot(snap, 'SNAPSHOT-HALF-PUBLISHED')
  const manifest = backupManifestPath(snap)
  const body = fs.readFileSync(manifest, 'utf8')
  fs.rmSync(manifest)
  const ready = path.join(path.dirname(dataDir), 'manifest-writer-ready')
  const release = path.join(path.dirname(dataDir), 'manifest-writer-release')
  const writer = spawn(
    process.execPath,
    ['-e', `
const fs = require('node:fs')
const [manifest, ready, release, body] = process.argv.slice(1)
const split = Math.max(1, Math.floor(body.length / 2))
const fd = fs.openSync(manifest, 'wx', 0o600)
try { fs.writeSync(fd, body.slice(0, split)); fs.fchmodSync(fd, 0o600) } finally { fs.closeSync(fd) }
fs.writeFileSync(ready, '')
const timer = setInterval(() => {
  if (!fs.existsSync(release)) return
  clearInterval(timer)
  fs.appendFileSync(manifest, body.slice(split))
}, 10)
`, manifest, ready, release, body],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const writerExit = collectExit(writer, 10_000)
  try {
    await waitForFile(ready, 5_000)
    const r = runRestore(dataDir, backupsDir, snap)
    assert.equal(r.status, 1, `并发半发布 manifest 必须 fail closed：\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /manifest|JSON|内容异常|无法解析/i)
    assert.doesNotMatch(r.log, /"create"|"stop"/, '半发布拒绝必须早于 validator create 与 app stop')
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  } finally {
    fs.writeFileSync(release, '')
    const result = await writerExit
    assert.equal(result.code, 0, `manifest writer cleanup failed:\n${result.stdout}\n${result.stderr}`)
  }
})

test('P6-R2-R8 manifest fail-closed：manifest symlink / 非 regular 一律拒绝', () => {
  for (const kind of ['symlink', 'directory'] as const) {
    const { dataDir, backupsDir } = scene(`manifest-nonregular-${kind}`, 'CURRENT')
    const snap = path.join(backupsDir, 'backup-manifest-nonregular.db')
    makeSnapshot(snap, 'SNAPSHOT')
    const manifest = backupManifestPath(snap)
    const body = fs.readFileSync(manifest)
    fs.rmSync(manifest)
    if (kind === 'symlink') {
      const target = manifest + '.target'
      fs.writeFileSync(target, body, { mode: 0o600 })
      fs.symlinkSync(path.basename(target), manifest)
    } else {
      fs.mkdirSync(manifest)
    }
    const r = runRestore(dataDir, backupsDir, snap)
    assert.equal(r.status, 1)
    assert.doesNotMatch(r.log, /"stop"/)
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  }
})

test('P6-R2-R8 manifest fail-closed：snapshot symlink 即使目标 pair 合法也拒绝', () => {
  const { dataDir, backupsDir } = scene('snapshot-symlink-reject', 'CURRENT')
  const target = path.join(backupsDir, 'backup-real.db')
  makeSnapshot(target, 'REAL')
  const snap = path.join(backupsDir, 'backup-link.db')
  fs.symlinkSync(path.basename(target), snap)
  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /符号链接/)
  assert.doesNotMatch(r.log, /"stop"/)
})

// ② 建议 3：截断的快照必须在**任何破坏性步骤之前**被拦下
test('建议3：截断快照被 quick_check 拦下 → 退出 1，且没停过 app、没动过 app.db', () => {
  const { dataDir, backupsDir } = scene('truncated', 'CURRENT')
  // 造一个「有 SQLite 头但被截断」的快照：head -c 15 照样过，quick_check 抛 malformed
  const full = path.join(backupsDir, 'full.db')
  makeSnapshot(full, 'SNAPSHOT-B') // 用一致性快照当底本：确保拦下它的是 quick_check，不是 R7-P1① 的 WAL 守卫
  const snap = path.join(backupsDir, 'backup-2026-07-26T02-00-00-ffffff.db')
  fs.writeFileSync(snap, fs.readFileSync(full).subarray(0, 2048))
  refreshSnapshotManifest(snap)
  assert.equal(
    fs.readFileSync(snap).subarray(0, 15).toString(),
    'SQLite format 3',
    '前置：截断后文件头仍在，故只靠 head -c 15 是拦不住的',
  )

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1, `应以 1 退出：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /完整性校验/, '应说明是完整性校验没过')
  assert.equal(
    readMarker(path.join(dataDir, 'app.db')),
    'CURRENT',
    '🔴 拦截必须发生在换库之前，app.db 不得被改动',
  )
  assert.doesNotMatch(r.log, /"stop"/, '🔴 校验没过就不该停服务（否则白停一次、现场也白存）')
})

// ②b 🔴 R7-P1①（codex R6 指出）：纯 cp 出来的 WAL 主文件必须被**拒收**。
//
// ⚠️ 这条测试的判据在本轮**被有意反转**了。R6 之前它断言的是「wal 模式的完好快照不该被拒」——
//    那时脚本只关心「能不能打开、quick_check 过不过」，而 cp 出来的 WAL 主文件这两条都过。
//    问题是它过得**太容易**：WAL 库的已提交数据可能只躺在 -wal sidecar 里，单拷主文件就丢了那
//    一截，剩下的页结构完好 ⇒ quick_check=ok ⇒ 恢复"成功" ⇒ readiness 也过 ⇒ 数据静默少一块。
//    本轮实测复现过（150 行的库只还原出 100 行）。故守卫改为按文件头 offset 18/19 判：
//    2/2 = WAL 模式 → 拒；1/1 = journal 模式（VACUUM INTO 产物）→ 收。
//    代价是**干净关闭**的 WAL 库（内容其实完整）也一并被拒——磁盘上区分不了，宁可误拒，
//    脚本会打印用 VACUUM INTO 重做一份的确切命令。详见 restore.sh 里那段注释。
test('R7-P1①：纯 cp 出来的 wal 模式快照（非 VACUUM 产物）被拒收，且未动库、未停 app', () => {
  const { dataDir, backupsDir } = scene('walcopy', 'CURRENT')
  // 直接 cp 一个活动 WAL 库的主文件——保留 WAL 形态（文件头 2/2）
  const live = path.join(backupsDir, 'live.db')
  makeDb(live, 'SNAPSHOT-C')
  const snap = path.join(backupsDir, 'copied.db')
  fs.copyFileSync(live, snap)
  refreshSnapshotManifest(snap)
  {
    const hdr = fs.readFileSync(snap).subarray(18, 20)
    assert.deepEqual([hdr[0], hdr[1]], [2, 2], '前置：这份快照确实是 wal 模式（文件头 2/2）')
    // 这份文件本身是"完好"的（能打开、quick_check 过）——正因如此，旧守卫拦不住它
    const d = new DatabaseSync(`file:${snap}?immutable=1`, { readOnly: true })
    const qc = d.prepare('PRAGMA quick_check').get() as unknown as { quick_check: string }
    d.close()
    assert.equal(qc.quick_check, 'ok', '前置：quick_check 是过的 → 单靠它拦不住 WAL 主文件')
  }

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1, `🔴 WAL 模式主文件必须被拒：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /WAL 模式的主文件，拒绝使用/, '应说明拒收原因是 WAL 形态')
  assert.match(r.stderr, /VACUUM INTO/, '🔴 必须给出可执行的补救路径（转成一致性快照）')
  assert.equal(
    readMarker(path.join(dataDir, 'app.db')),
    'CURRENT',
    '🔴 拦截必须发生在换库之前，app.db 不得被改动',
  )
  assert.doesNotMatch(r.log, /"stop"/, '🔴 校验没过就不该停服务（否则白停一次、现场也白存）')
})

for (const { label, bytes } of [
  { label: '0/0', bytes: [0, 0] },
  { label: '1/0', bytes: [1, 0] },
  { label: '0/1', bytes: [0, 1] },
  { label: '3/3', bytes: [3, 3] },
] as const) {
  test(`R7-P1① fail-closed：未知 SQLite header ${label} 一律拒收（只接受 1/1）`, () => {
    const { dataDir, backupsDir } = scene(`unknown-header-${label.replace('/', '-')}`, 'CURRENT')
    const snap = path.join(backupsDir, `backup-unknown-${label.replace('/', '-')}.db`)
    makeSnapshot(snap, 'UNKNOWN-HEADER')
    const buf = fs.readFileSync(snap)
    buf[18] = bytes[0]
    buf[19] = bytes[1]
    fs.writeFileSync(snap, buf)
    refreshSnapshotManifest(snap)

    const r = runRestore(dataDir, backupsDir, snap)
    assert.equal(r.status, 1, `未知 header ${label} 必须 fail-closed：\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /header.*18.*19.*1\/1|只接受.*1\/1/i, '必须明确只接受已知安全的 1/1')
    assert.doesNotMatch(r.log, /"stop"/, 'header 未知时必须在停服务前拒绝')
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT', '当前库不得被替换')
  })
}

// ②c 反向回归：VACUUM INTO 产物（文件头 1/1，backupDb 与 preupgrade.db 的真实形态）必须照收。
//     没有这条，P1① 守卫退化成「拒绝一切快照」也能全绿。
test('R7-P1① 回归：VACUUM INTO 产物（journal 模式）正常放行', () => {
  const { dataDir, backupsDir } = scene('vacuum-ok', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T04-00-00-bbbbbb.db')
  makeSnapshot(snap, 'VACUUMED') // 内含头字节 1/1 的前置断言

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `一致性快照不该被拒：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'VACUUMED')
})

// ③ 快照就是当前库本身：提前拒绝（install 同文件会 exit 64，那会儿 app 已停、现场已存）
test('自盖守卫：快照就是 app.db 本身 → 退出 2，且没停过 app', () => {
  const { dataDir, backupsDir } = scene('samefile', 'CURRENT')
  const r = runRestore(dataDir, backupsDir, path.join(dataDir, 'app.db'))
  assert.equal(r.status, 2, `应以 2 退出：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.log, /"stop"/, '应在停服务之前就拒绝')
})

// ④ 建议 5：DATA_DIR/BACKUP_DIR 覆盖必须真的生效——脚本头与 docs §5.2 声称支持这两个变量。
//    桩 docker 会在挂载源不是「存在的绝对路径」时直接判失败，故本例同时钉住：
//    覆盖后的路径确实以 -v 显式挂进了容器，而不是依赖 compose 里那条 ./data:/app/data。
test('建议5：BACKUP_DIR 覆盖到非默认位置时，pre-restore.db 真落在覆盖后的目录', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'override-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(root, 'elsewhere', 'my-backups') // 不在 data/ 下
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-26T03-00-00-aaaaaa.db')
  makeSnapshot(snap, 'SNAPSHOT-D')

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-D')
  assert.ok(
    fs.existsSync(path.join(backupsDir, 'pre-restore.db')),
    '🔴 现场必须落在 BACKUP_DIR 覆盖后的目录里；落到别处＝文档承诺了代码不支持的能力',
  )
  assert.equal(readMarker(path.join(backupsDir, 'pre-restore.db')), 'CURRENT')
})

test('P6-R2 DATA_DIR 绑定门禁：配置指向真数据目录时，错误 DATA_DIR 必须在停机/写库前 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'wrong-data-dir-'))
  const actualDataDir = path.join(root, 'actual-data')
  const wrongDataDir = path.join(root, 'wrong-data')
  const wrongBackups = path.join(wrongDataDir, 'backups')
  fs.mkdirSync(wrongBackups, { recursive: true })
  makeDb(path.join(actualDataDir, 'app.db'), 'ACTUAL-SERVICE-DB')
  makeDb(path.join(wrongDataDir, 'app.db'), 'WRONG-TARGET-BEFORE')
  const snap = path.join(wrongBackups, 'backup-wrong-target.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')

  const r = runRestore(wrongDataDir, wrongBackups, snap, {
    TEST_COMPOSE_DATA_SOURCE: actualDataDir,
    TEST_READY_STATUS: '200',
    TEST_READY_BODY: '{"ok":true}', // 真服务仍 ready：旧逻辑因此会假成功
  })

  assert.notEqual(r.status, 0, `🔴 DATA_DIR 不匹配必须拒绝：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /DATA_DIR|\/app\/data|bind source/i)
  assert.equal(readMarker(path.join(actualDataDir, 'app.db')), 'ACTUAL-SERVICE-DB', '真库不得改动')
  assert.equal(readMarker(path.join(wrongDataDir, 'app.db')), 'WRONG-TARGET-BEFORE', '错路径也不得被写入')
  assert.ok(!fs.existsSync(path.join(wrongDataDir, '.restore-in-progress')), '不得创建 restore 锁')
  assert.ok(!fs.existsSync(path.join(wrongBackups, 'pre-restore.db')), '不得生成现场快照')
  assert.doesNotMatch(r.log, /"run"|"stop"|"start"/, '只允许静态 config，不得启动容器或改变运行态')
})

for (const mode of ['missing', 'named', 'multiple', 'config-fail'] as const) {
  test(`P6-R2 DATA_DIR 绑定门禁：${mode} /app/data 配置必须 fail-closed`, () => {
    const { dataDir, backupsDir } = scene(`compose-data-${mode}`, 'CURRENT')
    const snap = path.join(backupsDir, `backup-${mode}.db`)
    makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
    const second = path.join(path.dirname(dataDir), 'second-data')
    fs.mkdirSync(second, { recursive: true })

    const r = runRestore(dataDir, backupsDir, snap, {
      TEST_COMPOSE_MOUNT_MODE: mode,
      TEST_COMPOSE_DATA_SOURCE: dataDir,
      TEST_COMPOSE_DATA_SOURCE_2: second,
    })

    assert.notEqual(r.status, 0, `🔴 ${mode} 布局不得继续恢复：\n${r.stdout}\n${r.stderr}`)
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
    assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
    assert.doesNotMatch(r.log, /"run"|"stop"|"start"/)
  })
}

test('P6-R2 DATA_DIR 绑定门禁：相对/绝对路径及 symlink 规范化到同一目录时正常放行', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'data-dir-symlink-'))
  const actualDataDir = path.join(root, 'actual-data')
  const aliasDataDir = path.join(root, 'data-alias')
  const backupsDir = path.join(actualDataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(actualDataDir, 'app.db'), 'CURRENT')
  fs.symlinkSync(actualDataDir, aliasDataDir, 'dir')
  const snap = path.join(backupsDir, 'backup-symlink-ok.db')
  makeSnapshot(snap, 'SYMLINK-SNAPSHOT')

  const r = runRestore(aliasDataDir, path.join(aliasDataDir, 'backups'), snap, {
    TEST_COMPOSE_DATA_SOURCE: path.relative(REPO, actualDataDir),
  })
  assert.equal(r.status, 0, `指向同一实体目录的 symlink 应放行：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(actualDataDir, 'app.db')), 'SYMLINK-SNAPSHOT')
})

test('P6-R2 DATA_DIR 绑定门禁：Compose 已改但现有容器仍挂旧目录时必须在写库前拒绝', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'stale-container-mount-'))
  const configuredDataDir = path.join(root, 'configured-data')
  const staleContainerDataDir = path.join(root, 'stale-container-data')
  const backupsDir = path.join(configuredDataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(configuredDataDir, 'app.db'), 'CONFIGURED-CURRENT')
  makeDb(path.join(staleContainerDataDir, 'app.db'), 'STALE-CONTAINER-CURRENT')
  const snap = path.join(backupsDir, 'backup-stale-container.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')

  const r = runRestore(configuredDataDir, backupsDir, snap, {
    TEST_COMPOSE_DATA_SOURCE: configuredDataDir,
    TEST_CONTAINER_DATA_SOURCE: staleContainerDataDir,
    TEST_READY_STATUS: '200',
    TEST_READY_BODY: '{"ok":true}',
  })

  assert.notEqual(r.status, 0, `🔴 旧容器挂载与当前 Compose 不一致时不得假成功：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /container|容器|mount|挂载|\/app\/data/i)
  assert.equal(readMarker(path.join(configuredDataDir, 'app.db')), 'CONFIGURED-CURRENT')
  assert.equal(readMarker(path.join(staleContainerDataDir, 'app.db')), 'STALE-CONTAINER-CURRENT')
  assert.ok(!fs.existsSync(path.join(configuredDataDir, '.restore-in-progress')))
  assert.ok(!fs.existsSync(path.join(backupsDir, 'pre-restore.db')))
  assert.doesNotMatch(r.log, /"run"|"stop"|"start"/)
})

test('P6-R2 DATA_DIR 绑定门禁：app 容器尚不存在时按已核验 Compose create 为停止态后正常恢复', () => {
  const { dataDir, backupsDir } = scene('container-data-container-missing', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-container-missing.db')
  makeSnapshot(snap, 'CREATED-CONTAINER-RESTORED')

  const r = runRestore(dataDir, backupsDir, snap, {
    TEST_CONTAINER_MOUNT_MODE: 'container-missing',
    TEST_CONTAINER_DATA_SOURCE: dataDir,
  })
  const calls = r.log.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])

  assert.equal(r.status, 0, `合法的 container-missing 应先 create 停止态容器再恢复：\n${r.stdout}\n${r.stderr}`)
  assert.ok(calls.some((call) => call[0] === 'compose' && call[1] === 'create' && call.at(-1) === 'app'))
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CREATED-CONTAINER-RESTORED')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
})

for (const mode of ['container-multiple', 'missing', 'named', 'multiple', 'inspect-fail'] as const) {
  test(`P6-R2 DATA_DIR 绑定门禁：现有容器挂载状态 ${mode} 必须 fail-closed`, () => {
    const { dataDir, backupsDir } = scene(`container-data-${mode}`, 'CURRENT')
    const snap = path.join(backupsDir, `backup-container-${mode}.db`)
    makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
    const second = path.join(path.dirname(dataDir), 'second-container-data')
    fs.mkdirSync(second, { recursive: true })

    const r = runRestore(dataDir, backupsDir, snap, {
      TEST_CONTAINER_MOUNT_MODE: mode,
      TEST_CONTAINER_DATA_SOURCE: dataDir,
      TEST_CONTAINER_DATA_SOURCE_2: second,
    })

    assert.notEqual(r.status, 0, `🔴 容器挂载状态 ${mode} 不明确时不得继续恢复：\n${r.stdout}\n${r.stderr}`)
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
    assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
    assert.ok(!fs.existsSync(path.join(backupsDir, 'pre-restore.db')))
    assert.doesNotMatch(r.log, /"run"|"stop"|"start"/)
  })
}

test('P6-R2 DATA_DIR 绑定门禁：校验后的 symlink 换靶不得改变锁与数据库实际目标', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'data-dir-retarget-'))
  const actualDataDir = path.join(root, 'actual-data')
  const retargetDataDir = path.join(root, 'retarget-data')
  const aliasDataDir = path.join(root, 'data-alias')
  const backupsDir = path.join(actualDataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(actualDataDir, 'app.db'), 'ACTUAL-CURRENT')
  makeDb(path.join(retargetDataDir, 'app.db'), 'RETARGET-CURRENT')
  fs.symlinkSync(actualDataDir, aliasDataDir, 'dir')
  const snap = path.join(backupsDir, 'backup-retarget.db')
  makeSnapshot(snap, 'PINNED-SNAPSHOT')

  const retargetBin = path.join(root, 'retarget-bin')
  fs.mkdirSync(retargetBin, { recursive: true })
  fs.writeFileSync(
    path.join(retargetBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(retargetBin)
  const retargetDone = path.join(root, 'retarget-done')
  const dirnameStub = path.join(retargetBin, 'dirname-stub.mjs')
  fs.writeFileSync(
    dirnameStub,
    `import fs from 'node:fs'
import path from 'node:path'
if (process.argv.at(-1) === process.env.TEST_RETARGET_TRIGGER && !fs.existsSync(process.env.TEST_RETARGET_DONE)) {
  fs.unlinkSync(process.env.TEST_DATA_ALIAS)
  fs.symlinkSync(process.env.TEST_RETARGET_DEST, process.env.TEST_DATA_ALIAS, 'dir')
  fs.writeFileSync(process.env.TEST_RETARGET_DONE, '')
}
console.log(path.dirname(process.argv.at(-1)))
`,
  )
  fs.writeFileSync(
    path.join(retargetBin, 'dirname'),
    `#!/bin/sh\nexec "${process.execPath}" "${dirnameStub}" "$@"\n`,
    { mode: 0o755 },
  )

  const logFile = path.join(root, 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${retargetBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: aliasDataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_COMPOSE_DATA_SOURCE: actualDataDir,
      TEST_CONTAINER_DATA_SOURCE: actualDataDir,
      TEST_DATA_ALIAS: aliasDataDir,
      TEST_RETARGET_DEST: retargetDataDir,
      TEST_RETARGET_DONE: retargetDone,
      TEST_RETARGET_TRIGGER: snap,
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 0, `规范化后应固定写入已验证实体目录：\n${r.stdout}\n${r.stderr}`)
  assert.ok(fs.existsSync(retargetDone), '前置：验证后确实发生了 symlink 换靶')
  assert.equal(readMarker(path.join(actualDataDir, 'app.db')), 'PINNED-SNAPSHOT')
  assert.equal(readMarker(path.join(retargetDataDir, 'app.db')), 'RETARGET-CURRENT', '换靶目录不得被写入')
  assert.ok(!fs.existsSync(path.join(retargetDataDir, '.restore-in-progress')))
})

for (const driftAt of ['after-stop', 'before-start', 'after-start'] as const) {
  test(`P6-R2 容器身份固定：${driftAt} 发生 A→B recreate 时不得接受 B 的 readiness`, () => {
    const root = fs.mkdtempSync(path.join(tmpDir, `container-drift-${driftAt}-`))
    const dataA = path.join(root, 'data-a')
    const dataB = path.join(root, 'data-b')
    const backupsDir = path.join(dataA, 'backups')
    fs.mkdirSync(backupsDir, { recursive: true })
    makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
    makeDb(path.join(dataB, 'app.db'), 'B-OLD-SERVICE')
    const snap = path.join(backupsDir, `backup-${driftAt}.db`)
    makeSnapshot(snap, 'A-RESTORED')
    const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
    const state = makeDockerState(dataA, dataB)
    state.driftAt = driftAt
    state.driftTarget = CONTAINER_B
    fs.writeFileSync(stateFile, JSON.stringify(state))

    const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
      TEST_READY_STATUS: '200',
      TEST_READY_BODY: '{"ok":true}',
    })
    const afterState = readDockerState(stateFile)
    const control = `${fs.realpathSync(dataA)}.restore-control`

    assert.notEqual(r.status, 0, `🔴 容器身份漂移必须 fail-closed：\n${r.stdout}\n${r.stderr}`)
    assert.doesNotMatch(r.stdout, /恢复完成/, '不得把 B 的 readiness 宣告为 A 恢复成功')
    assert.equal(
      readMarker(path.join(dataA, 'app.db')),
      driftAt === 'after-stop' ? 'A-CURRENT' : 'A-RESTORED',
      'after-stop 漂移应在 replace 前中止；更晚漂移则只能影响已钉住的数据目录 A',
    )
    assert.equal(readMarker(path.join(dataB, 'app.db')), 'B-OLD-SERVICE', '并发 recreate 的 B 库不得被改动')
    assert.ok(fs.existsSync(control), '身份漂移后必须保留 host-only control 与阶段证据')
    assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')), '漂移时绝不能记录 accepted')
    assert.equal(afterState.containers[CONTAINER_B].running, false, '错误目标 B 也必须被停止，不能继续冒充成功实例')
  })
}

test('P6-R2 容器身份：初始即存在额外同 project/service 容器时在停机与写库前 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'container-extra-initial-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-extra-initial.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.containers[CONTAINER_B].composeProject = state.composeProject
  state.containers[CONTAINER_B].composeService = state.composeService
  state.containers[CONTAINER_B].running = true
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, `🔴 多个同 service 容器时必须 fail-closed：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /多个|额外|容器|service|身份/i)
  assert.equal(readMarker(path.join(dataA, 'app.db')), 'A-CURRENT')
  assert.equal(readMarker(path.join(dataB, 'app.db')), 'B-CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'), '初始身份不唯一时不得先停任一实例')
  assert.ok(!fs.existsSync(path.join(dataA, '.restore-in-progress')))
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataA)}.restore-control`))
})

test('P6-R2 容器身份：Compose ps 返回非完整 64hex ID 时在建锁/停机/写库前拒绝', () => {
  const { dataDir, backupsDir } = scene('container-id-malformed', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-malformed-id.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')

  const r = runRestore(dataDir, backupsDir, snap, {
    TEST_COMPOSE_CONTAINER_ID: 'abc123',
  })

  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /容器.*ID|64|hex|身份/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.doesNotMatch(r.log, /"run"|"stop"|"start"/)
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`))
})

test('P6-R2 容器身份：docker inspect .Id 不等于 Compose 捕获值时在建锁/停机/写库前拒绝', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('container-id-mismatch')

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_INSPECT_ID_OVERRIDE: CONTAINER_B,
  })
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /容器.*ID|inspect|身份.*不一致/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'))
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`))
})

test('P6-R2 容器身份：start 后出现额外同 service 容器时拒绝 accepted 并收口所有未验收实例', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'container-extra-after-start-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-extra-after-start.db')
  makeSnapshot(snap, 'A-RESTORED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.extraAt = 'after-start'
  state.extraTarget = CONTAINER_B
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)
  const control = `${fs.realpathSync(dataA)}.restore-control`

  assert.notEqual(r.status, 0, `🔴 start 后 service 身份不再唯一时不得成功：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.stdout, /恢复完成/)
  assert.ok(afterState.events.some((event) => event[0] === 'extra-service' && event[1] === 'after-start'))
  assert.equal(afterState.containers[CONTAINER_A].running, false, '未验收 A 必须停止')
  assert.equal(afterState.containers[CONTAINER_B].running, false, '额外 B 也必须停止')
  assert.deepEqual(afterState.containers[CONTAINER_A].networks, [])
  assert.deepEqual(afterState.containers[CONTAINER_B].networks, [])
  assert.ok(fs.existsSync(control))
  assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')), '额外实例出现后绝不能接受 readiness')
})

test('P6-R2 cleanup：service 标签枚举失败时不得把未知额外 B 当作已收口', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'cleanup-service-enumeration-fail-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-enumeration-fail.db')
  makeSnapshot(snap, 'A-RESTORED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.extraAt = 'after-start'
  state.extraTarget = CONTAINER_B
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_SERVICE_PS_WHEN_EXTRA: '1',
  })
  const afterState = readDockerState(stateFile)
  const control = `${fs.realpathSync(dataA)}.restore-control`

  assert.notEqual(r.status, 0)
  assert.equal(afterState.containers[CONTAINER_A].running, false, '即使枚举失败也必须先停止已捕获 A')
  assert.equal(afterState.containers[CONTAINER_B].running, true, '前置：枚举故障使 B 无法被可靠发现')
  assert.ok(
    afterState.events.some((event) => event[0] === 'service-enumeration-failed'),
    '前置：cleanup 的 service 枚举故障必须真实命中',
  )
  assert.ok(
    fs.existsSync(path.join(control, 'ambiguous-publication')),
    '🔴 无法证明所有 service 候选已收口时必须保留明确 ambiguous 证据',
  )
  assert.match(r.stderr, /无法枚举|无法确认.*service|发布状态不明|ambiguous/i)
})

test('P6-R2 cleanup：Compose ps 枚举失败也必须保留未发布状态不明证据', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'cleanup-compose-enumeration-fail-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-compose-enumeration-fail.db')
  makeSnapshot(snap, 'A-RESTORED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.extraAt = 'after-start'
  state.extraTarget = CONTAINER_B
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_COMPOSE_PS_WHEN_EXTRA: '1',
  })
  const afterState = readDockerState(stateFile)
  const control = `${fs.realpathSync(dataA)}.restore-control`

  assert.notEqual(r.status, 0)
  assert.equal(afterState.containers[CONTAINER_A].running, false, '已捕获 A 必须先停止')
  assert.equal(afterState.containers[CONTAINER_B].running, true, '前置：Compose 枚举故障使 B 无法确认收口')
  assert.ok(afterState.events.some((event) => event[0] === 'service-enumeration-failed' && event[1] === 'compose-ps'))
  assert.ok(fs.existsSync(path.join(control, 'ambiguous-publication')))
  assert.match(r.stderr, /Compose.*指针|无法确认.*候选|发布状态不明|ambiguous/i)
})

test('P6-R2 cleanup：network-published 后枚举失败时保留 A 并记录发布身份不明', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'published-cleanup-enumeration-fail-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-published-enumeration-fail.db')
  makeSnapshot(snap, 'A-ACCEPTED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.extraAt = 'after-published'
  state.extraTarget = CONTAINER_B
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_SERVICE_PS_WHEN_EXTRA: '1',
  })
  const afterState = readDockerState(stateFile)
  const control = `${fs.realpathSync(dataA)}.restore-control`

  assert.notEqual(r.status, 0)
  assert.equal(afterState.containers[CONTAINER_A].running, true, 'network-published 后 trusted A 不得反向停机')
  assert.equal(afterState.containers[CONTAINER_B].running, true, '前置：枚举故障使额外 B 的状态无法确认')
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
  assert.ok(fs.existsSync(path.join(control, 'network-published')))
  assert.ok(
    fs.existsSync(path.join(control, 'ambiguous-publication')),
    '🔴 已发布后无法枚举替代实例时必须留下明确发布身份不明证据',
  )
  assert.match(r.stderr, /无法完整枚举|发布身份状态不明|ambiguous/i)
})

test('P6-R2 cleanup：network-published 后 Compose ps 失败也不得释放 accepted 状态', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'published-cleanup-compose-fail-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-published-compose-fail.db')
  makeSnapshot(snap, 'A-ACCEPTED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.extraAt = 'after-published'
  state.extraTarget = CONTAINER_B
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_COMPOSE_PS_WHEN_EXTRA: '1',
  })
  const afterState = readDockerState(stateFile)
  const control = `${fs.realpathSync(dataA)}.restore-control`

  assert.notEqual(r.status, 0)
  assert.equal(afterState.containers[CONTAINER_A].running, true, 'published A 必须保留运行')
  assert.equal(afterState.containers[CONTAINER_B].running, true, '前置：Compose ps 故障使 B 无法确认收口')
  assert.ok(afterState.events.some((event) => event[0] === 'service-enumeration-failed' && event[1] === 'compose-ps'))
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
  assert.ok(fs.existsSync(path.join(control, 'network-published')))
  assert.ok(fs.existsSync(path.join(control, 'ambiguous-publication')))
  assert.match(r.stderr, /Compose.*指针|发布身份状态不明|ambiguous/i)
})

test('P6-R2 cleanup：network-published 后短 ID 不得把 trusted A 当作额外 B 停止', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'published-cleanup-short-id-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-CURRENT')
  makeDb(path.join(dataB, 'app.db'), 'B-CURRENT')
  const snap = path.join(backupsDir, 'backup-published-short-id.db')
  makeSnapshot(snap, 'A-ACCEPTED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.extraAt = 'after-published'
  state.extraTarget = CONTAINER_B
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_TRUNCATE_SERVICE_IDS_WHEN_EXTRA: '1',
  })
  const afterState = readDockerState(stateFile)
  const control = `${fs.realpathSync(dataA)}.restore-control`

  assert.notEqual(r.status, 0, '额外 B 出现后必须 fail-closed')
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 trusted published A 不得因短 ID 比较被误停')
  assert.equal(afterState.containers[CONTAINER_B].running, false, '未验收 B 必须停止并隔离')
  assert.deepEqual(afterState.containers[CONTAINER_B].networks, [])
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
  assert.ok(fs.existsSync(path.join(control, 'network-published')))
})

test('P6-R2 容器身份：Docker 默认短 ID 时必须显式 no-trunc 后正常成功', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'container-stable-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-stable.db')
  makeSnapshot(snap, 'STABLE-RESTORED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir)))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_TRUNCATE_ALL_IDS_WITHOUT_FLAG: '1',
  })
  const afterState = readDockerState(stateFile)
  const disconnectAt = afterState.events.findIndex((event) => event[0] === 'network-disconnect' && event[2] === CONTAINER_A)
  const startAt = afterState.events.findIndex((event) => event[0] === 'start' && event[1] === CONTAINER_A)
  const reconnectAt = afterState.events.findIndex(
    (event) => event[0] === 'network-connect' && event[3] === CONTAINER_A,
  )
  assert.equal(r.status, 0, `合法无漂移路径应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'STABLE-RESTORED')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
  assert.ok(disconnectAt >= 0 && disconnectAt < startAt && startAt < reconnectAt, '🔴 app 必须先断网，再启动，accepted 后才恢复网络')
  assert.ok(
    afterState.events.some((event) => event[0] === 'exec-readiness' && event[1] === CONTAINER_A && event[2] === '0'),
    'readiness 必须从已捕获 exact ID 的容器内执行，且 probe 时网络集合仍为空',
  )
  assert.ok(
    afterState.events.some((event) =>
      event[0] === 'network-connect' &&
      event[1] === 'stub-network' &&
      event[3] === CONTAINER_A &&
      event[4] === 'accepted'),
    '🔴 ready-accepted 写入前不得恢复容器网络；否则 SIGKILL 可把未接受实例暴露给流量',
  )
  assert.doesNotMatch(r.log, /--mac-address/, '动态 endpoint MAC 不得捕获或重放')
  assert.equal(
    afterState.containers[CONTAINER_A].networks[0].runtimeMacAddress,
    '02:42:ac:12:00:99',
    '动态 MAC 可由 Docker 在重连时改变，NetworkID/name/aliases 不变即应成功',
  )
})

test('P6-R2 方案A SIGKILL：app-started / ready 前实例保持断网，重试先停精确 ID 再 exit 4', async () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('sigkill-pre-ready')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const entered = path.join(root, 'ready-entered')
  const { child, exited } = spawnStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_READY_ENTERED: entered,
    TEST_READY_BLOCK_MS: '30000',
  })

  await sigkillAtFile(child, exited, entered, () => {
    const state = readDockerState(stateFile)
    assert.equal(state.containers[CONTAINER_A].running, true, '前置：exact A 已启动')
    assert.deepEqual(state.containers[CONTAINER_A].networks, [], '🔴 strict readiness 前必须保持零网络')
    assert.ok(fs.existsSync(path.join(control, 'app-started')))
    assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')))
    assert.ok(!fs.existsSync(path.join(control, 'network-published')))
  })

  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterRetry = readDockerState(stateFile)
  const ownerPidFile = path.join(control, 'owner-pid')
  const ownerFingerprintFile = path.join(control, 'owner-start-fingerprint')
  const persistedOwnerFingerprint = fs.readFileSync(ownerFingerprintFile, 'utf8').trim()
  assert.equal(retry.status, 4)
  assert.equal(afterRetry.containers[CONTAINER_A].running, false, '🔴 未验收残锁必须先停 exact A')
  assert.deepEqual(afterRetry.containers[CONTAINER_A].networks, [], '未验收残锁必须确认 A 仍隔离')
  assert.ok(fs.existsSync(control), '残锁与 app-started 证据必须保留')
  assert.equal(fs.statSync(ownerPidFile).mode & 0o777, 0o600, 'owner PID 状态必须保持 0600')
  assert.equal(fs.statSync(ownerFingerprintFile).mode & 0o777, 0o600, 'owner 指纹状态必须保持 0600')
  assert.match(
    persistedOwnerFingerprint,
    /^v2 (?:linux-proc [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12} [0-9]+|darwin-ps [0-9]+ [0-9]+:[0-9]+)$/,
    'owner 指纹必须使用单行、版本化、严格可解析的格式',
  )
})

test('P6-R2 方案A SIGKILL：ready-accepted / reconnect 前可验收但仍断网，重试收口后 exit 4', async () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('sigkill-pre-reconnect')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const entered = path.join(root, 'connect-before-effect')
  const { child, exited } = spawnStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_BLOCK_NETWORK_CONNECT_BEFORE_EFFECT: 'stub-network',
    TEST_NETWORK_CONNECT_ENTERED: entered,
  })

  await sigkillAtFile(child, exited, entered, () => {
    const state = readDockerState(stateFile)
    assert.ok(fs.existsSync(path.join(control, 'ready-accepted')), '🔴 reconnect 前必须先持久化 trusted accepted')
    assert.ok(fs.existsSync(path.join(control, 'networks-reconnecting')))
    assert.ok(!fs.existsSync(path.join(control, 'network-published')))
    assert.equal(state.containers[CONTAINER_A].running, true)
    assert.deepEqual(state.containers[CONTAINER_A].networks, [], 'connect 生效前仍必须零网络')
  })

  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterRetry = readDockerState(stateFile)
  assert.equal(retry.status, 4)
  assert.equal(afterRetry.containers[CONTAINER_A].running, false)
  assert.deepEqual(afterRetry.containers[CONTAINER_A].networks, [])
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')), 'accepted 证据不得因残锁收口删除')
})

test('P6-R2 方案A SIGKILL：connect 已生效 / network-published 前，重试撤回 endpoint 并停机', async () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('sigkill-post-connect')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const entered = path.join(root, 'connect-after-effect')
  const { child, exited } = spawnStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_BLOCK_NETWORK_CONNECT_AFTER_EFFECT: 'stub-network',
    TEST_NETWORK_CONNECT_ENTERED: entered,
  })

  await sigkillAtFile(child, exited, entered, () => {
    const state = readDockerState(stateFile)
    assert.ok(fs.existsSync(path.join(control, 'ready-accepted')), '🔴 endpoint 生效前 accepted 已持久化')
    assert.ok(!fs.existsSync(path.join(control, 'network-published')))
    assert.equal(state.containers[CONTAINER_A].networks.length, 1, '前置：network connect 已真实生效')
  })

  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterRetry = readDockerState(stateFile)
  assert.equal(retry.status, 4)
  assert.equal(afterRetry.containers[CONTAINER_A].running, false)
  assert.deepEqual(afterRetry.containers[CONTAINER_A].networks, [], '🔴 未提交 publication 的 endpoint 必须撤回')
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
})

test('P6-R2 方案A SIGKILL：network-published / lock release 前属于已验收实例，重试不得反向停 A', async () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('sigkill-post-published')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const entered = path.join(root, 'network-published-entered')
  const { child, exited } = spawnStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_BLOCK_AFTER_NETWORK_PUBLISHED: '1',
    TEST_AFTER_NETWORK_PUBLISHED_ENTERED: entered,
  })

  await sigkillAtFile(child, exited, entered, () => {
    const state = readDockerState(stateFile)
    assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
    assert.ok(fs.existsSync(path.join(control, 'network-published')), '🔴 对外可达前必须已有唯一 commit marker')
    assert.equal(state.containers[CONTAINER_A].running, true)
    assert.equal(state.containers[CONTAINER_A].networks.length, 1)
  })

  const beforeRetry = readDockerState(stateFile)
  const stopCount = beforeRetry.events.filter((event) => event[0] === 'stop' && event[1] === CONTAINER_A).length
  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterRetry = readDockerState(stateFile)
  assert.equal(retry.status, 4)
  assert.equal(afterRetry.containers[CONTAINER_A].running, true, '已发布 exact A 不得被残锁处理反向停机')
  assert.equal(afterRetry.containers[CONTAINER_A].networks.length, 1)
  assert.equal(
    afterRetry.events.filter((event) => event[0] === 'stop' && event[1] === CONTAINER_A).length,
    stopCount,
  )
  assert.ok(fs.existsSync(control), 'published 后 SIGKILL 的 accepted/published 证据必须保留')
})

test('P6-R2 隔离不变量：start 后被外部接入网络时，probe/accepted 前复核必须 fail-closed', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('external-connect-before-ready')
  const state = readDockerState(stateFile)
  state.externalNetworkAt = 'before-ready'
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, `🔴 隔离态被外部 network connect 破坏后不得成功：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.stdout, /恢复完成/)
  assert.ok(afterState.events.some((event) => event[0] === 'external-network-connect'))
  assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')), '🔴 网络集合非空时不得写 trusted accepted')
  assert.equal(afterState.containers[CONTAINER_A].running, false)
  assert.deepEqual(afterState.containers[CONTAINER_A].networks, [])
  assert.ok(fs.existsSync(control), '隔离不变量失败必须保留阶段锁')
})

test('P6-R2 host-only stage：app 在 stop 前看不到也不能篡改已校验 replace stage', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'host-only-stage-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-host-only-stage.db')
  makeSnapshot(snap, 'HOST-ONLY-STAGE-RESTORED')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir)))
  const observation = path.join(root, 'prestop-stage.json')

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_PRESTOP_STAGE_OBSERVATION: observation,
    TEST_MUTATE_PUBLIC_STAGE_BEFORE_STOP: '1',
  })

  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(observation, 'utf8')),
    { publicLockVisible: false, publicStageVisible: false },
    '🔴 stop 前不得创建 app 可换 entry 的 public lock/stage；唯一状态必须在 host-only control',
  )
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'HOST-ONLY-STAGE-RESTORED')
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`), '成功后 host-only 控制锁必须清理')
})

test('P6-R2 host-only 控制面：Compose 额外 bind 覆盖 DATA_DIR 父目录时必须在建锁/停机前拒绝', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'control-overlap-compose-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-overlap-compose.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.composeExtraBinds = [{ source: root, target: '/app/repo' }]
  state.containers[CONTAINER_A].extraBinds = [{ source: root, target: '/app/repo' }]
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '🔴 app 能经父目录 bind 看见 data.restore-control 时必须 fail-closed')
  assert.match(r.stderr, /host-only|control|bind|挂载.*重叠|祖先/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'))
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`))
})

test('P6-R2 host-only 控制面：现有容器额外 ancestor bind 即使 Compose 未声明也必须拒绝', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'control-overlap-container-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-overlap-container.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.containers[CONTAINER_A].extraBinds = [{ source: root, target: '/ops' }]
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '🔴 stale/手工容器的额外 bind 也不得暴露 trusted control sibling')
  assert.match(r.stderr, /host-only|control|bind|实际挂载|祖先/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'))
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
})

test('P6-R2 host-only 控制面：不包含 control sibling 的独立额外 bind 不应被误拒', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'control-nonoverlap-bind-'))
  const dataDir = path.join(root, 'data')
  const independent = fs.mkdtempSync(path.join(tmpDir, 'control-independent-'))
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-nonoverlap.db')
  makeSnapshot(snap, 'SAFE-EXTRA-BIND')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.composeExtraBinds = [{ source: independent, target: '/app/assets' }]
  state.containers[CONTAINER_A].extraBinds = [{ source: independent, target: '/app/assets' }]
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  assert.equal(r.status, 0, `独立 bind 不包含 host-only control，应允许恢复：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SAFE-EXTRA-BIND')
})

test('P6-R2 网络身份：Compose-only 静态 IPv4 必须在停机/断网前 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'network-static-ip-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-static-ip.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.composeNetworkMode = 'static-ipv4'
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '🔴 无法无损重放的静态 IP 网络配置必须 fail-closed')
  assert.match(r.stderr, /网络.*(静态|IPv4|重放|不支持)|ipv4_address/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'), '静态网络门禁必须发生在停机前')
  assert.ok(!afterState.events.some((event) => event[0] === 'network-disconnect'), '静态网络门禁不得先断网')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '前置门禁失败不得留下 restore 锁')
})

test('P6-R2 网络身份：Compose-only interface_name 必须在停机/断网前 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'network-interface-name-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-interface-name.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.composeNetworkMode = 'interface-name'
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '🔴 无法无损重放的 interface_name 必须 fail-closed')
  assert.match(r.stderr, /网络.*(interface|接口|重放|不支持)|interface_name/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'), 'interface_name 门禁必须发生在停机前')
  assert.ok(!afterState.events.some((event) => event[0] === 'network-disconnect'), 'interface_name 门禁不得先断网')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '前置门禁失败不得留下 restore 锁')
})

test('P6-R2 网络身份：environment/label 中同名 interface_name 或 mac_address 不得触发误拒', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'network-key-false-positive-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-network-key-false-positive.db')
  makeSnapshot(snap, 'DYNAMIC-NETWORK-OK')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.composeNetworkMode = 'env-interface-name'
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  assert.equal(r.status, 0, `非网络字段的同名 key 不应误拒：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'DYNAMIC-NETWORK-OK')
})

test('P6-R2 网络身份：container-only 非零 GwPriority 必须在停机/断网前 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'network-gw-priority-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-gw-priority.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.containers[CONTAINER_A].networks[0].gwPriority = 17
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '🔴 现有容器的非零 GwPriority 无法由 aliases-only 重连无损重放')
  assert.match(r.stderr, /网络.*(gateway|gw|优先级|重放|不支持)|GwPriority/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'), 'GwPriority 门禁必须发生在停机前')
  assert.ok(!afterState.events.some((event) => event[0] === 'network-disconnect'), 'GwPriority 门禁不得先断网')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '前置门禁失败不得留下 restore 锁')
})

test('P6-R2 容器身份：停止态旧容器 config hash 陈旧时仍必须 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'network-stale-config-hash-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-stale-config-hash.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.containers[CONTAINER_A].running = false
  state.containers[CONTAINER_A].composeConfigHash = 'd'.repeat(64)
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '🔴 停止态旧容器必须由 Compose config hash 漂移门禁拒绝')
  assert.match(r.stderr, /config hash|recreate|配置.*不一致/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'), 'config hash 门禁必须发生在停机前')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`))
})

test('P6-R2 网络身份：Compose 显式 mac_address 必须在停机/断网前 fail-closed', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'network-compose-mac-address-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-compose-mac.db')
  makeSnapshot(snap, 'SHOULD-NOT-INSTALL')
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataDir)
  state.composeNetworkMode = 'mac-address'
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /mac_address|MAC|网络.*不支持/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'))
  assert.ok(!afterState.events.some((event) => event[0] === 'network-disconnect'))
  assert.ok(!fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`))
})

// ============================================================================
// P6-R2 复审三轮第 1 条 + R6① 回归：DB_PATH 覆盖 fail-closed 守卫
//
// backupPaths 尊重 DB_PATH，但 restore.sh 此前硬编码 `DB="$DATA_DIR/app.db"`，在 DB_PATH
// 覆盖时要么恢复到错误位置、要么 realpath 失败崩。解析 DB_PATH 的通用逻辑需要处理符号链接/相对
// 路径/cwd 不定/多级 ../，脚本层做不到以 Node 同样逻辑归一 → fail-closed 简单守卫：检测到
// DB_PATH≠默认值 → 拒绝运行 + 清晰报错。
//
// R6① 增强（codex R5）：宿主侧 DB_PATH 只能看 export 的值，漏了「容器内 .env/compose 配置、
// 宿主未 export」的正常运维场景。增强：从 Compose 最终配置静态读实际生效值，两侧任一非默认就拒绝。
// ============================================================================

test('复审三轮1：DB_PATH 覆盖且≠默认值（宿主侧）→ fail-closed 拒绝运行', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-dbpath-'))
  const dataDir = path.join(tmpRoot, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const snap = path.join(backupsDir, 'backup-2026-01-01T12-00-00.000Z.db')
  fs.writeFileSync(snap, '')
  const logFile = path.join(tmpRoot, 'stub.log')
  fs.writeFileSync(logFile, '')
  try {
    const r = spawnSync('sh', [RESTORE_SH, 'backup-2026-01-01T12-00-00.000Z.db'], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_LOG: logFile,
        SUDO: '',
        DATA_DIR: dataDir,
        BACKUP_DIR: backupsDir,
        DB_PATH: '/custom/path/to/app.db', // 🔴 覆盖值≠默认
      },
      encoding: 'utf8',
    })
    assert.equal(r.status, 2, '🔴 检测到非默认 DB_PATH（宿主侧）必须以 exit 2 拒绝')
    assert.match(r.stderr, /不支持非默认 DB_PATH/, '🔴 必须清晰说明原因')
    assert.match(r.stderr, /不可忽略本错误/, '🔴 必须警告强行执行后果')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

// R6① + R4-P1①：容器配置里的 DB_PATH（宿主未 export）→ fail-closed 拒绝运行。
//
// 🔴 R4-P1①（codex R6 指出）：R5 的修复用 `docker compose ps app | grep Up` 判断容器是否运行，
//    只在运行态才读配置。但**恢复场景的常态恰恰是容器已停/崩溃循环**（库坏了才要恢复），那时守卫
//    读不到配置 → 静默恢复到 data/app.db，而重启后的 app 仍读它自己那个 DB_PATH 库 → 用户以为
//    恢复成功（脚本 ✅、/api/ready 甚至也过，因为那个库本身是健康的），实际一个字节都没换。
//    修复：改用 `docker compose config app` 静态解析，与容器运行态无关。
//    本测试的桩**不提供 ps/exec**、只应答 config，即「容器根本没在跑」——钉住这个场景。
test('R4-P1①：容器停机时也须从 compose 配置读出 DB_PATH → fail-closed 拒绝运行', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-container-dbpath-'))
  const dataDir = path.join(tmpRoot, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const snap = path.join(backupsDir, 'backup-2026-01-01T12-00-00.000Z.db')
  fs.writeFileSync(snap, '')

  const binDir2 = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir2)
  // 桩 docker：只应答 `compose config app`，吐真 compose config 那样的 YAML 片段。
  // 🔴 ps 显式报「没有运行中的容器」、exec 直接失败——证明新守卫不依赖运行态容器。
  fs.writeFileSync(
    path.join(binDir2, 'docker'),
    `#!/bin/sh
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then
  if [ "$3" = "--format" ] && [ "$4" = "json" ]; then
    printf '{"services":{"app":{"volumes":[{"type":"bind","source":"%s","target":"/app/data","bind":{}}]}}}\n' "$DATA_DIR"
    exit 0
  fi
  echo "services:"
  echo "  app:"
  echo "    environment:"
  echo "      DB_PATH: /custom/container.db"
  echo "      TZ: Asia/Shanghai"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "ps" ]; then exit 0; fi   # 无运行中容器
if [ "$1" = "compose" ] && [ "$2" = "exec" ]; then exit 1; fi # 容器停了，exec 必失败
exit 0
`,
    { mode: 0o755 },
  )

  // 🔴 宿主侧 DB_PATH 必须真的**不存在**（即 R3① 守卫看不见），配置里却有非默认值。
  //    不能写 `DB_PATH: undefined`——spawnSync 会把它字符串化成 "undefined"，那会去触发宿主侧
  //    那条守卫，测试就变成假绿（拦下了但拦的是另一条）。故显式 delete。
  const envNoDbPath = {
    ...process.env,
    PATH: `${binDir2}:${process.env.PATH}`,
    SUDO: '',
    DATA_DIR: dataDir,
    BACKUP_DIR: backupsDir,
  }
  delete envNoDbPath.DB_PATH

  try {
    const r = spawnSync('sh', [RESTORE_SH, 'backup-2026-01-01T12-00-00.000Z.db'], {
      cwd: REPO,
      env: envNoDbPath,
      encoding: 'utf8',
    })
    assert.equal(r.status, 2, '🔴 检测到容器配置里的非默认 DB_PATH 必须以 exit 2 拒绝')
    assert.match(r.stderr, /容器内检测到 DB_PATH=/, '🔴 必须说明来源（容器侧）')
    assert.match(r.stderr, /不可忽略本错误/, '🔴 必须警告强行执行后果')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('P6-R2 fail-closed：非默认 DB_PATH 不再输出绕过主状态机的手工恢复命令', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-dbpath-no-fallback-'))
  const dataDir = path.join(tmpRoot, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const snap = path.join(backupsDir, 'backup.db')
  fs.writeFileSync(snap, '')
  const logFile = path.join(tmpRoot, 'stub.log')
  fs.writeFileSync(logFile, '')
  try {
    const r = spawnSync('sh', [RESTORE_SH, snap], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_LOG: logFile,
        SUDO: '',
        DATA_DIR: dataDir,
        BACKUP_DIR: backupsDir,
        DB_PATH: '/custom/app.db',
      },
      encoding: 'utf8',
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /不提供.*手工|必须.*同一.*状态机|拒绝.*降级/i)
    assert.doesNotMatch(
      r.stderr,
      /VACUUM INTO|sudo install|rm -f .*-(wal|shm)|docker compose stop app/,
      '🔴 不得给出跳过 header/quick_check/私有 stage/锁/trap 的弱化恢复配方',
    )
    const docs = fs.readFileSync(path.join(REPO, 'docs', 'deploy.md'), 'utf8')
    assert.match(docs, /保持 fail-closed/)
    assert.doesNotMatch(docs, /后备：手工步骤|sudo install .*data\/app\.db/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('P6-R2 升级失败回滚：旧镜像只能 build/pull + create 为停止态，恢复前不得 up/start', () => {
  const { dataDir, backupsDir } = scene('upgrade-rollback-order', 'MIGRATION-PARTIAL')
  const snap = path.join(backupsDir, 'preupgrade.db')
  makeSnapshot(snap, 'PRE-UPGRADE')
  fs.writeFileSync(path.join(dataDir, '.upgrade-in-progress'), snap)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 3, `升级标记应先阻断并给安全指引：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /docker compose (build|pull) app/)
  assert.match(r.stderr, /docker compose create .*--force-recreate.* app|docker compose create .*app/i)
  assert.match(r.stderr, /--after-image-rollback/)
  const saveAt = r.stderr.indexOf('RECOVERY_SH=')
  const stopAt = r.stderr.indexOf('docker compose stop app')
  const rollbackAt = r.stderr.indexOf('git checkout')
  const buildAt = r.stderr.indexOf('docker compose build app')
  const createAt = r.stderr.indexOf('docker compose create --force-recreate app')
  const restoreAt = r.stderr.indexOf('--after-image-rollback')
  assert.ok(
    [saveAt, stopAt, rollbackAt, buildAt, createAt, restoreAt].every((index) => index >= 0),
    `安全指引缺少必要步骤：\n${r.stderr}`,
  )
  assert.ok(
    saveAt < stopAt &&
      stopAt < rollbackAt &&
      rollbackAt < buildAt &&
      buildAt < createAt &&
      createAt < restoreAt,
    `安全指引顺序必须是保留脚本→停机→退旧代码→构建→停止态 create→恢复：\n${r.stderr}`,
  )
  assert.doesNotMatch(
    r.stderr,
    /docker compose (up -d|start) app/,
    '🔴 数据库恢复前不得启动旧服务，否则会接流量并把中间 schema 写入随后被覆盖',
  )
  assert.doesNotMatch(r.log, /"stop"|"start"/, '守卫本身不得改变容器运行态')
  const docs = fs.readFileSync(path.join(REPO, 'docs', 'deploy.md'), 'utf8')
  assert.match(
    docs,
    /回滚：停机.*退回旧代码\/镜像.*(?:build|pull).*create.*停止态.*恢复 DB.*启动/s,
    '摘要必须与详细流程的停止态 create 安全顺序一致',
  )
  assert.doesNotMatch(docs, /回滚：停容器 → 用 §5 的恢复步骤还原到升级前的备份 → 起旧镜像/)
})


test('复审三轮1：DB_PATH 未设置或=默认值 → 正常通过', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-dbpath-ok-'))
  const dataDir = path.join(tmpRoot, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const snap = path.join(backupsDir, 'backup-2026-01-01T12-00-00.000Z.db')
  const db = path.join(dataDir, 'app.db')
  // 🔴 本质是守卫逻辑测试，不是端到端恢复流程测试——后者需要真 docker 容器跑 VACUUM INTO。
  //    只需证明 DB_PATH=默认值时脚本**没被守卫挡住**；在没有真 docker 的沙箱里，脚本确实会在
  //    node_in_data 阶段 exit 125（$? 来自 spawnSync 转 docker compose 的退出码），但在那之前
  //    已经通过了守卫区（没打 ❌ 守卫文案、也不是 exit 2）。故只要「exit≠2 且 stderr 不含守卫
  //    拒绝文案」即可判断守卫放行。
  fs.writeFileSync(snap, 'SQLite format 3\x00SNAP')
  fs.writeFileSync(db, 'SQLite format 3\x00CURRENT')
  const logFile = path.join(tmpRoot, 'stub.log')
  fs.writeFileSync(logFile, '')
  try {
    // DB_PATH=默认值（等价于未设置）
    const r1 = spawnSync('sh', [RESTORE_SH, snap], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_LOG: logFile,
        SUDO: '',
        DATA_DIR: dataDir,
        BACKUP_DIR: backupsDir,
        DB_PATH: 'data/app.db', // 🔴 显式传默认值
      },
      encoding: 'utf8',
    })
    assert.notEqual(r1.status, 2, '🔴 DB_PATH=默认值不应被守卫拒绝（exit 2）')
    assert.ok(
      !r1.stderr.includes('不支持非默认 DB_PATH'),
      '🔴 DB_PATH=默认值不应触发守卫报错文案',
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('R3-新② trap 陷阱：stop 后 armed 状态原子写入失败，app 仍被重启且旧库不动', () => {
  const { dataDir, backupsDir } = scene('trap-post-stop-install', 'CURRENT-POST-STOP')
  const snapshotPath = path.join(backupsDir, 'backup-2026-01-01T00-00-00-abcdef.db')
  makeSnapshot(snapshotPath, 'SNAPSHOT-NOT-APPLIED')

  const failBin = path.join(path.dirname(dataDir), 'install-fail-bin')
  fs.mkdirSync(failBin, { recursive: true })
  fs.writeFileSync(
    path.join(failBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(failBin)
  fs.writeFileSync(
    path.join(failBin, 'install'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
if [ "$target" = "$TEST_FAIL_INSTALL_TARGET" ]; then
  echo "install: injected armed marker failure" >&2
  exit 73
fi
/usr/bin/install "$@"
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(failBin, 'mktemp'),
    `#!/bin/sh
if [ "$1" = "$TEST_FAIL_MKTEMP_TEMPLATE" ]; then
  echo "mktemp: injected armed marker failure" >&2
  exit 73
fi
/usr/bin/mktemp "$@"
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snapshotPath], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_FAIL_INSTALL_TARGET: path.join(`${fs.realpathSync(dataDir)}.restore-control`, 'replace-armed'),
      TEST_FAIL_MKTEMP_TEMPLATE: path.join(
        `${fs.realpathSync(dataDir)}.restore-control`,
        '.replace-armed.tmp.XXXXXX',
      ),
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 73, `armed 标记写入失败应保留原退出码：\n${r.stdout}\n${r.stderr}`)
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const startCalls = calls.filter((c) => c[0] === 'start' && c[1] === CONTAINER_A)
  assert.ok(startCalls.length >= 1, `trap 应调用 start app（实际 start 调用 ${startCalls.length} 次）`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-POST-STOP', '最终 mv 未发生，旧库必须原样保留')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '安全退出应释放私有 stage/锁')
})

test('P6-R2 未运行容器：换库前失败不得把原本停止的 app 启起来', () => {
  const { dataDir, backupsDir } = scene('trap-post-stop-initially-stopped', 'CURRENT-STOPPED')
  const snapshotPath = path.join(backupsDir, 'backup-2026-01-01T00-00-00-stopped.db')
  makeSnapshot(snapshotPath, 'SNAPSHOT-NOT-APPLIED')

  const failBin = installArmedMarkerFailureBin(path.dirname(dataDir))

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  // docker stub 的 .stopped 文件模拟 restore 开始前容器本来就是停止态。
  fs.writeFileSync(logFile + '.stopped', '')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const r = spawnSync('sh', [RESTORE_SH, snapshotPath], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      TEST_FAIL_INSTALL_TARGET: path.join(control, 'replace-armed'),
      TEST_FAIL_MKTEMP_TEMPLATE: path.join(control, '.replace-armed.tmp.XXXXXX'),
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 73, `换库前阶段失败应保留注入退出码：\n${r.stdout}\n${r.stderr}`)
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(
    calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A).length,
    0,
    '原本停止的 app 不得被未替换失败路径启动',
  )
  assert.ok(fs.existsSync(logFile + '.stopped'), '原本停止态必须保持停止')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-STOPPED', '换库前失败不得改动当前库')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '未替换失败应释放 public stage/锁')
})

test('P6-R2 新建容器：Compose create 的停止态实例在换库前失败后仍保持停止', () => {
  const { dataDir, backupsDir } = scene('trap-post-create-stopped', 'CURRENT-CREATED-STOPPED')
  const snapshotPath = path.join(backupsDir, 'backup-created-stopped.db')
  makeSnapshot(snapshotPath, 'SNAPSHOT-NOT-APPLIED')
  const failBin = installArmedMarkerFailureBin(path.dirname(dataDir))
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  const r = spawnSync('sh', [RESTORE_SH, snapshotPath], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      TEST_CONTAINER_MOUNT_MODE: 'container-missing',
      TEST_FAIL_INSTALL_TARGET: path.join(control, 'replace-armed'),
      TEST_FAIL_MKTEMP_TEMPLATE: path.join(control, '.replace-armed.tmp.XXXXXX'),
    },
    encoding: 'utf8',
  })

  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(r.status, 73, `create 后换库前失败应保留注入退出码：\n${r.stdout}\n${r.stderr}`)
  assert.ok(calls.some((call) => call[0] === 'compose' && call[1] === 'create'), '前置：确实 create 了停止态容器')
  assert.equal(
    calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A).length,
    0,
    '刚 create 的停止态 app 容器不得被失败路径启动（隔离 validator 的 start -a 不计入）',
  )
  assert.ok(fs.existsSync(logFile + '.stopped'), '刚 create 的容器必须保持停止态')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-CREATED-STOPPED')
})

test('P6-R2 镜像回滚：--after-image-rollback 的停止态旧容器在 DB 替换前不得启动', () => {
  const { dataDir, backupsDir } = scene('trap-rollback-stopped', 'CURRENT-ROLLBACK-STOPPED')
  const snapshotPath = path.join(backupsDir, 'preupgrade.db')
  makeSnapshot(snapshotPath, 'ROLLBACK-SNAPSHOT-NOT-APPLIED')
  fs.writeFileSync(path.join(dataDir, '.upgrade-in-progress'), snapshotPath + '\n')
  const failBin = installArmedMarkerFailureBin(path.dirname(dataDir))
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(logFile + '.stopped', '')
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  const r = spawnSync('sh', [RESTORE_SH, '--after-image-rollback', snapshotPath], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      TEST_FAIL_INSTALL_TARGET: path.join(control, 'replace-armed'),
      TEST_FAIL_MKTEMP_TEMPLATE: path.join(control, '.replace-armed.tmp.XXXXXX'),
    },
    encoding: 'utf8',
  })

  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(r.status, 73, `rollback DB 替换前失败应保留注入退出码：\n${r.stdout}\n${r.stderr}`)
  assert.equal(
    calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A).length,
    0,
    'DB 尚未恢复时不得启动旧 app 镜像（隔离 validator 的 start -a 不计入）',
  )
  assert.ok(fs.existsSync(logFile + '.stopped'), 'rollback 的停止态容器必须保持停止')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-ROLLBACK-STOPPED')
})

test('P6-R2 现场临时快照：chmod 前已是 0600，chmod 失败时 trap 清掉残留', () => {
  const { dataDir, backupsDir } = scene('pre-restore-mode', 'CURRENT-MODE')
  const snapshotPath = path.join(backupsDir, 'backup-mode-test.db')
  makeSnapshot(snapshotPath, 'SNAPSHOT-MODE')
  const preTmp = path.join(backupsDir, 'pre-restore.db.tmp')

  const failBin = path.join(path.dirname(dataDir), 'chmod-fail-bin')
  fs.mkdirSync(failBin, { recursive: true })
  fs.writeFileSync(
    path.join(failBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(failBin)
  fs.writeFileSync(
    path.join(failBin, 'chmod'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
if [ "$target" = "$TEST_PRE_RESTORE_TMP" ]; then
  "${process.execPath}" -e 'const fs=require("fs");fs.writeFileSync(process.env.TEST_MODE_FILE,String(fs.statSync(process.env.TEST_PRE_RESTORE_TMP).mode & 0o777))'
  echo "chmod: injected failure" >&2
  exit 74
fi
/bin/chmod "$@"
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  const modeFile = path.join(path.dirname(dataDir), 'pre-tmp-mode')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snapshotPath], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_PRE_RESTORE_TMP: preTmp,
      TEST_MODE_FILE: modeFile,
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 74, `chmod 注入失败应原样退出：\n${r.stdout}\n${r.stderr}`)
  assert.equal(Number(fs.readFileSync(modeFile, 'utf8')), 0o600, '🔴 VACUUM 产物从创建起就必须受 umask 077 保护')
  assert.ok(!fs.existsSync(preTmp), '优雅失败时 trap 必须清掉非正式 pre-restore 临时文件')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '安全失败后锁应释放')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-MODE', '最终替换未发生，旧库必须保持')
})

test('R4④：还原用私有 stage + mv 原子就位（非原地覆盖）', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-restore-atomic-'))
  try {
    const dataDir = path.join(tmpRoot, 'data')
    const backupsDir = path.join(dataDir, 'backups')
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 })
    const dbPath = path.join(dataDir, 'app.db')
    const snapshotPath = path.join(backupsDir, 'backup-2026-01-01T00-00-00-abcdef.db')
    const logFile = path.join(tmpRoot, 'stub.log')

    // 造快照
    const snap = new DatabaseSync(snapshotPath)
    snap.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42)')
    snap.close()
    fs.chmodSync(snapshotPath, 0o600)
    writeBackupManifestFixture(snapshotPath)

    // 造当前库
    const live = new DatabaseSync(dbPath)
    live.exec('CREATE TABLE t(x); INSERT INTO t VALUES (99)')
    live.close()

    const r = spawnSync(RESTORE_SH, [snapshotPath], {
      cwd: REPO,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        STUB_LOG: logFile,
        SUDO: '',
        DATA_DIR: dataDir,
        BACKUP_DIR: backupsDir,
        APP_URL: 'http://stub',
      },
      encoding: 'utf8',
    })

    assert.equal(r.status, 0, `脚本应成功退出（stderr: ${r.stderr})`)
    // 验证私有 stage 已 mv 就位、锁目录已释放
    assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '成功后不应留 restore stage/锁残留')
    // 验证还原内容正确
    const restored = new DatabaseSync(dbPath)
    const val = restored.prepare('SELECT x FROM t').get() as { x: number }
    restored.close()
    assert.equal(val.x, 42, '还原内容应是快照的值（42），不是原库的值（99）')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})



// ============================================================================
// R4-P1②：abspath() 符号链接归一 + stop 前私有 staging
//
// 最终方案在 stop 前把解析后的源固化为 DATA_DIR/.restore-in-progress/snapshot.db，并校验/安装同一份
// stage。因此源是 pre-restore.db 本身或任意层 symlink 时，后续现场留存覆盖原路径也不会毁掉恢复源。
// abspath 仍以 `cd -P` + 循环 readlink 解析目录/多层链接（32 层上限兜住成环）。
// ============================================================================

// ① 单层相对目标：snap.db -> pre-restore.db
test('R4-P1②：快照是 pre-restore.db 的符号链接 → provenance fail-closed 拒绝', () => {
  const { dataDir, backupsDir } = scene('symlink-1hop', 'CURRENT-BROKEN')
  makeSnapshot(path.join(backupsDir, 'pre-restore.db'), 'ORIGINAL')
  const snap = path.join(backupsDir, 'snap.db')
  fs.symlinkSync('pre-restore.db', snap)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1, `symlink 必须拒绝：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-BROKEN')
  assert.equal(readMarker(path.join(backupsDir, 'pre-restore.db')), 'ORIGINAL')
  assert.doesNotMatch(r.log, /"stop"/)
})

// ② 多层链：mid.db -> snap.db -> pre-restore.db（循环解析到底后再 stage）
test('R4-P1②：快照是两层符号链接 → provenance fail-closed 拒绝', () => {
  const { dataDir, backupsDir } = scene('symlink-2hop', 'CURRENT')
  makeSnapshot(path.join(backupsDir, 'pre-restore.db'), 'ORIGINAL')
  fs.symlinkSync('pre-restore.db', path.join(backupsDir, 'snap.db'))
  fs.symlinkSync('snap.db', path.join(backupsDir, 'mid.db'))

  const r = runRestore(dataDir, backupsDir, path.join(backupsDir, 'mid.db'))
  assert.equal(r.status, 1)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.equal(readMarker(path.join(backupsDir, 'pre-restore.db')), 'ORIGINAL')
  assert.doesNotMatch(r.log, /"stop"/)
})

// ③ 符号链接目标是绝对路径（readlink 返回 /... 时走的另一条分支）
test('R4-P1②：符号链接目标为绝对路径 → provenance fail-closed 拒绝', () => {
  const { dataDir, backupsDir } = scene('symlink-abs', 'CURRENT')
  const preRestore = path.join(backupsDir, 'pre-restore.db')
  makeSnapshot(preRestore, 'ORIGINAL')
  const snap = path.join(backupsDir, 'absl.db')
  fs.symlinkSync(preRestore, snap)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 1)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.equal(readMarker(preRestore), 'ORIGINAL')
  assert.doesNotMatch(r.log, /"stop"/)
})

// ④ 反向回归：普通快照不能被新逻辑误当成 pre-restore.db 拦下（否则现场留存整段失效）
test('R4-P1② 回归：普通备份文件仍走现场留存（不误拦）', () => {
  const { dataDir, backupsDir } = scene('symlink-none', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-27T00-00-00-xyz123.db')
  makeSnapshot(snap, 'SNAPSHOT')

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT')
  assert.equal(readMarker(path.join(backupsDir, 'pre-restore.db')), 'CURRENT', '现场应被留存')
  assert.match(r.log, /"run"/, '🔴 普通快照必须借容器跑 VACUUM INTO 留存现场')
})

// 校验与最终 install 必须使用**同一个已解析目标**。否则快照是 symlink 时，攻击者/误操作可在
// quick_check 通过后、install 前把链接改指另一份库；脚本会“校验 A、安装 B”。stop 桩就在两步间换链。
test('P6-R2 TOCTOU：快照 symlink 不进入校验/换链窗口', () => {
  const { dataDir, backupsDir } = scene('symlink-toctou', 'CURRENT')
  const good = path.join(backupsDir, 'good.db')
  const swapped = path.join(backupsDir, 'swapped.db')
  makeSnapshot(good, 'VALIDATED-GOOD')
  makeSnapshot(swapped, 'UNVALIDATED-SWAPPED')
  const snap = path.join(backupsDir, 'snapshot-link.db')
  fs.symlinkSync('good.db', snap)

  const swapBin = path.join(path.dirname(dataDir), 'swap-bin')
  fs.mkdirSync(swapBin, { recursive: true })
  fs.writeFileSync(
    path.join(swapBin, 'docker'),
    `#!/bin/sh
if [ "$1" = "stop" ] && [ "$2" = "${CONTAINER_A}" ]; then
  /bin/rm -f "$TEST_SNAPSHOT_LINK"
  /bin/ln -s "$TEST_SWAPPED_TARGET" "$TEST_SNAPSHOT_LINK"
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  installReadyCurlStub(swapBin)

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${swapBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_SNAPSHOT_LINK: snap,
      TEST_SWAPPED_TARGET: swapped,
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 1)
  assert.equal(fs.realpathSync(snap), fs.realpathSync(good), '停机前拒绝，stop 桩不得有机会换链')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
  assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /"stop"/)
})

// 不只 symlink：解析后的普通文件也可能在 quick_check 后被另一个进程用 rename 原子替换。
// 私有 stage 必须在 stop 前完成，后续安装只认 stage，不重新打开原路径。
test('P6-R2 TOCTOU：普通快照文件在校验后被原子替换 → 仍安装私有 stage 内容', () => {
  const { dataDir, backupsDir } = scene('regular-toctou', 'CURRENT')
  const snap = path.join(backupsDir, 'snapshot.db')
  const swapped = path.join(backupsDir, 'swapped.db')
  makeSnapshot(snap, 'VALIDATED-REGULAR')
  makeSnapshot(swapped, 'UNVALIDATED-REPLACEMENT')

  const swapBin = path.join(path.dirname(dataDir), 'regular-swap-bin')
  fs.mkdirSync(swapBin, { recursive: true })
  fs.writeFileSync(
    path.join(swapBin, 'docker'),
    `#!/bin/sh
if [ "$1" = "stop" ] && [ "$2" = "${CONTAINER_A}" ]; then
  /bin/mv -f "$TEST_REPLACEMENT" "$TEST_SNAPSHOT_PATH"
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  installReadyCurlStub(swapBin)

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${swapBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_REPLACEMENT: swapped,
      TEST_SNAPSHOT_PATH: snap,
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 0, `恢复应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(snap), 'UNVALIDATED-REPLACEMENT', '前置：原始普通文件确实已在 stop 时被替换')
  assert.equal(
    readMarker(path.join(dataDir, 'app.db')),
    'VALIDATED-REGULAR',
    '🔴 最终恢复必须来自校验过的私有 stage，而不是重新打开已被替换的原路径',
  )
})

// ⑤ 成环：脚本必须拒绝、不能死循环
//
// ⚠️ 实测澄清：成环的链接根本走不到 abspath——`[ -f "$SNAPSHOT" ]` 就已经判否（`-f` 会 stat
//    最终目标，成环时 stat 返 ELOOP，故不是「常规文件」），脚本在入口校验就以「快照不存在」exit 1。
//    这本身是正确的 fail-closed，所以本测试钉的是**行为**（exit 1 + 未动库 + 未停 app），
//    不钉具体文案。abspath 里那 32 层上限因此是够不到的纵深防御（防将来有人挪动/放宽入口校验，
//    以及 -f 判真但链中段成环的边角），保留但不在此断言其文案。
test('R4-P1②：符号链接成环 → exit 1 拒绝运行，不死循环', () => {
  const { dataDir, backupsDir } = scene('symlink-cycle', 'CURRENT')
  fs.symlinkSync('cyc_b', path.join(backupsDir, 'cyc_a'))
  fs.symlinkSync('cyc_a', path.join(backupsDir, 'cyc_b'))

  const r = runRestore(dataDir, backupsDir, path.join(backupsDir, 'cyc_a'))
  assert.equal(r.status, 1, `成环应以 1 退出（且不得挂住）：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT', '🔴 拦截时不得改动 app.db')
  assert.doesNotMatch(r.log, /"stop"/, '🔴 应在动手之前就拦下，不该已经停过 app')
})

// ============================================================================
// R6-P2③（codex R5 终审）：node_with_snapshot 以 uid 1000 跑时读不到 root 属主的 0600 快照
//
// 问题：运维从异机 rsync/scp 下来的备份通常是 `root:root 0600`（sync-backups.sh 产物），镜像
// 默认 `USER node`(uid1000)，bind-mount **不做 uid 映射**直接保留宿主权限 → 容器内 1000 对
// 文件判不可读 → quick_check 里 `new DatabaseSync` 抛 EACCES，守卫却把合法快照报成「截断/损坏」，
// 恢复流程根本起不了步。
//
// 修复：node_with_snapshot 加 `--user 0:0`。纯只读操作（`:ro` + `?immutable=1` + `readOnly: true`）、
// 只碰单一快照文件不碰活库、一次性容器 --rm，三条都成立故提权安全。node_in_data 仍保持 uid1000
// （会写文件、产物属主必须是 1000）。
//
// 回归测试：跑真实脚本，钉它调 quick_check 时传了 `--user 0:0`。桩 docker 的 `:ro` 复刻
// （0o500 目录）保证测试环境和真容器一样：同目录不可写 + SQLite 建不了 -wal/-shm。修复前脚本
// 不带 --user、桩会以当前进程 uid 读 0600 文件 → 桩的 node 进程看到 EACCES、quick_check 失败
// 退码非零；修复后带 --user 0:0、桩跳过该 flag（不提权、只记录）但测试进程对自己建的文件仍可读
// → 成功。真容器里的差异更直接：不带 --user 时 uid1000 对 root:root 0600 没读权限；带了就能读。
// ============================================================================
test('R6-P2③：快照 0600 时 quick_check 以 root 读（--user 0:0）', () => {
  const { dataDir, backupsDir } = scene('root-snap', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-from-remote.db')
  makeSnapshot(snap, 'REMOTE')
  fs.chmodSync(snap, 0o600)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'REMOTE')

  // 桩日志里 quick_check 的那行调用必须带 --user 0:0。找「含 immutable=1 的那行」（其它 run 不带这个）
  const calls = r.log.split('\n').filter((l) => l.includes('immutable=1'))
  assert.equal(calls.length, 2, 'host-only 预校验与停机后同文件系统 stage 必须各跑一次 quick_check')
  for (const call of calls) {
    const argv = JSON.parse(call)
    const userIdx = argv.indexOf('--user')
    assert.ok(userIdx >= 0, '🔴 quick_check 必须带 --user（修复前缺此参数 → uid1000 读不了 root:root 0600）')
    assert.equal(argv[userIdx + 1], '0:0', '🔴 必须提权到 root')
  }
})

test('P6-R2：默认 sudo 的 root-owned readiness body 必须经提权写入，不能由普通 shell 重定向', () => {
  const { dataDir, backupsDir } = scene('logical-uid-sudo-stage', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-logical-uid.db')
  makeSnapshot(snap, 'LOGICAL-UID-SNAPSHOT')

  const logicalBin = path.join(path.dirname(dataDir), 'logical-uid-bin')
  fs.mkdirSync(logicalBin, { recursive: true })
  const sudoLog = path.join(path.dirname(dataDir), 'sudo.log')
  const headLog = path.join(path.dirname(dataDir), 'head.log')
  fs.writeFileSync(sudoLog, '')
  fs.writeFileSync(headLog, '')

  fs.writeFileSync(
    path.join(logicalBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(logicalBin)
  fs.writeFileSync(
    path.join(logicalBin, 'id'),
    `#!/bin/sh
case "$1" in
  -u) printf '%s\\n' 2001 ;;
  -g) printf '%s\\n' 2001 ;;
  *) exec /usr/bin/id "$@" ;;
esac
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(logicalBin, 'sudo'),
    `#!/bin/sh
if [ -n "$TEST_ROOT_READY_BODY" ] && [ -e "$TEST_ROOT_READY_BODY" ]; then
  /bin/chmod 600 "$TEST_ROOT_READY_BODY"
fi
printf '%s\\n' "$*" >> "$TEST_SUDO_LOG"
FAKE_ELEVATED=1 "$@"
rc=$?
if [ -n "$TEST_ROOT_READY_BODY" ] && [ -e "$TEST_ROOT_READY_BODY" ]; then
  /bin/chmod 000 "$TEST_ROOT_READY_BODY"
fi
exit "$rc"
`,
    { mode: 0o755 },
  )
  // 不能真的把 app.db chown 给不存在的 uid1000；记录后成功返回即可。两层锁目录本身不得再 chown
  // 给调用者，否则 Linux caller=uid1000 时 app 与 restore 会共享写权限。
  fs.writeFileSync(
    path.join(logicalBin, 'chown'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TEST_CHOWN_LOG"\nexit 0\n',
    { mode: 0o755 },
  )
  // install 的 -o/-g 也需要逻辑模拟：剥掉属主参数后调用系统 install，保留 mode/d/source/dest。
  const installStub = path.join(logicalBin, 'install-stub.mjs')
  fs.writeFileSync(
    installStub,
    `import { spawnSync } from 'node:child_process'
const input = process.argv.slice(2)
const output = []
for (let i = 0; i < input.length; i++) {
  if (input[i] === '-o' || input[i] === '-g') { i++; continue }
  output.push(input[i])
}
const r = spawnSync('/usr/bin/install', output, { stdio: 'inherit' })
process.exit(r.status ?? 1)
`,
  )
  fs.writeFileSync(
    path.join(logicalBin, 'install'),
    `#!/bin/sh\nexec "${process.execPath}" "${installStub}" "$@"\n`,
    { mode: 0o755 },
  )
  // 精确模拟真实权限边界：stage 直接读＝EACCES，经 fake sudo 读＝允许。
  fs.writeFileSync(
    path.join(logicalBin, 'head'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
case "$target" in
  *.restore-control/snapshot.db)
    printf '%s\\n' "elevated=\${FAKE_ELEVATED:-0} target=$target" >> "$TEST_HEAD_LOG"
    if [ "\${FAKE_ELEVATED:-0}" != "1" ]; then
      echo "head: $target: Permission denied" >&2
      exit 13
    fi
    ;;
esac
exec /usr/bin/head "$@"
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${logicalBin}:${process.env.PATH}`,
    STUB_LOG: logFile,
    DATA_DIR: dataDir,
    BACKUP_DIR: backupsDir,
    APP_URL: 'http://stub',
    READY_TIMEOUT: '8',
    TEST_SUDO_LOG: sudoLog,
    TEST_CHOWN_LOG: sudoLog,
    TEST_HEAD_LOG: headLog,
    TEST_ROOT_READY_BODY: path.join(`${fs.realpathSync(dataDir)}.restore-control`, 'ready-body'),
  }
  delete env.SUDO
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env,
    encoding: 'utf8',
  })

  assert.equal(r.status, 0, `默认 sudo 路径也应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'LOGICAL-UID-SNAPSHOT')
  const sudoCalls = fs.readFileSync(sudoLog, 'utf8')
  assert.doesNotMatch(
    sudoCalls,
    /chown .*\.(restore-in-progress|restore-control)/,
    '🔴 两层锁不得 chown 给可能与 app 相同的 caller UID',
  )
  assert.match(sudoCalls, /chmod 700 .*\.restore-in-progress/, 'public evidence 锁应以 root 权限收紧')
  assert.match(sudoCalls, /chmod 700 .*\.restore-control/, 'host-only 控制锁应以 root 权限收紧')
  const headCalls = fs.readFileSync(headLog, 'utf8').trim().split('\n').filter(Boolean)
  assert.ok(headCalls.length >= 1, '前置：必须实际执行过私有 stage 的文件头读取')
  assert.ok(
    headCalls.every((line) => line.startsWith('elevated=1 ')),
    `🔴 私有 stage 的宿主文件头读取不得绕过 sudo：\n${headCalls.join('\n')}`,
  )
})

test('P6-R2 restore 互斥：已有状态锁时 exit 4，绝不 stop/start 或改库', () => {
  const { dataDir, backupsDir } = scene('restore-lock-held', 'CURRENT-LOCKED')
  const snap = path.join(backupsDir, 'backup-lock-test.db')
  makeSnapshot(snap, 'SNAPSHOT-LOCKED-OUT')
  const lock = path.join(dataDir, '.restore-in-progress')
  fs.mkdirSync(lock, { mode: 0o700 })
  fs.writeFileSync(path.join(lock, 'owner-note'), 'another restore or interrupted run', { mode: 0o600 })

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 4, `已有锁必须以 4 fail closed：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /已有另一个 restore|异常中断的状态锁/)
  assert.doesNotMatch(r.log, /"stop"|"start"/, '🔴 锁冲突时不能干扰持锁 restore 的停机窗口')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-LOCKED', '当前数据库不得被修改')
  assert.ok(fs.existsSync(lock), '别人的/异常中断的锁不得被本进程删除')
})

test('P6-R2 host-only control 预存目录：guard acquisition 前 fail-closed 且不得删除未知 control', () => {
  const { dataDir, backupsDir } = scene('restore-control-preexisting', 'CURRENT-CONTROL-PREEXISTING')
  const snap = path.join(backupsDir, 'backup-control-preexisting.db')
  makeSnapshot(snap, 'SNAPSHOT-CONTROL-PREEXISTING')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  fs.mkdirSync(control, { mode: 0o700 })
  const marker = path.join(control, 'foreign-note')
  fs.writeFileSync(marker, 'leave me alone\n', { mode: 0o600 })

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 4, `预存 host-only control 必须 exit 4：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.log, /"stop"/, '未知 control 冲突必须发生在停机前')
  assert.equal(fs.readFileSync(marker, 'utf8'), 'leave me alone\n')
  assert.ok(fs.existsSync(control), '未知 host-only control 目录不得被 acquisition trap 删除')
  assert.equal(fs.existsSync(`${control}.guard`), false, '冲突前不得留下本进程 guard')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-CONTROL-PREEXISTING')
})

test('P6-R2 control ownership：本进程取得 guard 后他人抢先创建 control 也不得被 cleanup 删除', () => {
  const { dataDir, backupsDir } = scene('restore-control-foreign-after-guard', 'CURRENT-FOREIGN-RACE')
  const snap = path.join(backupsDir, 'backup-control-foreign-race.db')
  makeSnapshot(snap, 'SNAPSHOT-FOREIGN-RACE')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const raceBin = path.join(path.dirname(dataDir), 'control-foreign-race-bin')
  const foreignNote = path.join(control, 'foreign-note')
  fs.mkdirSync(raceBin, { recursive: true })
  fs.writeFileSync(
    path.join(raceBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(raceBin)
  fs.writeFileSync(
    path.join(raceBin, 'node'),
    `#!/bin/sh
if [ -f "$TEST_CONTROL_GUARD" ] && [ ! -e "$TEST_CONTROL_LOCK" ]; then
  /bin/mkdir "$TEST_CONTROL_LOCK" || exit $?
  printf '%s\n' FOREIGN-CONTROL > "$TEST_CONTROL_LOCK/foreign-note"
  /bin/chmod 600 "$TEST_CONTROL_LOCK/foreign-note"
  exit 73
fi
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  )

  const r = runRestore(dataDir, backupsDir, snap, {
    PATH: `${raceBin}:${process.env.PATH}`,
    TEST_CONTROL_LOCK: control,
    TEST_CONTROL_GUARD: `${control}.guard`,
  })
  assert.equal(r.status, 4, `抢先出现的 foreign control 必须 fail-closed：\n${r.stdout}\n${r.stderr}`)
  assert.equal(fs.readFileSync(foreignNote, 'utf8'), 'FOREIGN-CONTROL\n')
  assert.ok(fs.existsSync(control), '本进程只有 guard，没有 control ownership token，不得删 foreign control')
  assert.equal(fs.existsSync(`${control}.guard`), false, '本进程的 guard 应自行释放')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-FOREIGN-RACE')
  assert.doesNotMatch(r.log, /"stop"/)
})

// ============================================================================
for (const { mode, signal, exitCode } of [
  { mode: 'owned', signal: 'SIGTERM' as const, exitCode: 143 },
  { mode: 'owned', signal: 'SIGINT' as const, exitCode: 130 },
  { mode: 'foreign', signal: 'SIGTERM' as const, exitCode: 143 },
] as const) {
  test(`P6-R2 control-lock trap：${signal} 命中 mkdir 窗口时${mode === 'owned' ? '不留 ownerless 锁' : '保留他人空锁'}`, async () => {
    const { dataDir, backupsDir } = scene(`control-lock-signal-${mode}-${signal}`, 'CURRENT')
    const snap = path.join(backupsDir, 'backup-control-lock-signal.db')
    makeSnapshot(snap, 'SNAPSHOT')
    const control = `${fs.realpathSync(dataDir)}.restore-control`
    const signalBin = path.join(path.dirname(dataDir), 'control-lock-signal-bin')
    const entered = path.join(path.dirname(dataDir), 'control-lock-mkdir-entered')
    const controlGuard = `${control}.guard`
    const ownershipFile = path.join(control, 'control-owner')
    fs.mkdirSync(signalBin, { recursive: true })
    fs.writeFileSync(
      path.join(signalBin, 'docker'),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
      { mode: 0o755 },
    )
    installReadyCurlStub(signalBin)
    fs.writeFileSync(
      path.join(signalBin, 'mkdir'),
      `#!/bin/sh
target=
for arg in "$@"; do
  case "$arg" in -*) ;; *) target="$arg" ;; esac
done
if [ "$target" = "$TEST_CONTROL_LOCK" ]; then
  if [ "$TEST_CONTROL_LOCK_MODE" = "foreign" ]; then
    /bin/mkdir "$target" || exit $?
    /bin/rm -f "$TEST_CONTROL_GUARD"
    printf '%s\\n' FOREIGN-GUARD > "$TEST_CONTROL_GUARD"
    /bin/chmod 600 "$TEST_CONTROL_GUARD"
    : > "$TEST_CONTROL_MKDIR_ENTERED"
    while :; do sleep 1; done
  fi
fi
exec /bin/mkdir "$@"
`,
      { mode: 0o755 },
    )
    fs.writeFileSync(
      path.join(signalBin, 'chmod'),
      `#!/bin/sh
if [ "$1" = "700" ] && [ "$2" = "$TEST_CONTROL_LOCK" ]; then
  if [ "$TEST_CONTROL_LOCK_MODE" = "foreign" ]; then
    /bin/rm -f "$TEST_CONTROL_LOCK/control-owner" "$TEST_CONTROL_GUARD"
    printf '%s\\n' FOREIGN-GUARD > "$TEST_CONTROL_GUARD"
    /bin/chmod 600 "$TEST_CONTROL_GUARD"
    : > "$TEST_CONTROL_MKDIR_ENTERED"
    while :; do sleep 1; done
  fi
fi
exec /bin/chmod "$@"
`,
      { mode: 0o755 },
    )
    const preload = path.join(signalBin, 'pause-control-owner-open.cjs')
    fs.writeFileSync(
      preload,
      `const fs = require('node:fs')
const originalOpenSync = fs.openSync
fs.openSync = function patchedOpenSync(file, ...args) {
  const target = String(file)
  if (
    process.env.TEST_CONTROL_LOCK_MODE === 'owned' &&
    target === process.env.TEST_CONTROL_OWNERSHIP_FILE &&
    fs.existsSync(process.env.TEST_CONTROL_LOCK) &&
    !fs.existsSync(target)
  ) {
    fs.writeFileSync(process.env.TEST_CONTROL_MKDIR_ENTERED, '')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
  return originalOpenSync.call(this, file, ...args)
}
`,
      { mode: 0o600 },
    )

    const logFile = path.join(path.dirname(dataDir), 'stub.log')
    fs.writeFileSync(logFile, '')
    const child = spawn('sh', [RESTORE_SH, snap], {
      cwd: REPO,
      detached: true,
      env: {
        ...process.env,
        PATH: `${signalBin}:${process.env.PATH}`,
        STUB_LOG: logFile,
        SUDO: '',
        DATA_DIR: dataDir,
        BACKUP_DIR: backupsDir,
        TEST_CONTROL_LOCK: control,
        TEST_CONTROL_LOCK_MODE: mode,
        TEST_CONTROL_MKDIR_ENTERED: entered,
        TEST_CONTROL_GUARD: controlGuard,
        TEST_CONTROL_OWNERSHIP_FILE: ownershipFile,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = collectExit(child, 20_000)
    try {
      await waitForFile(entered, 10_000)
      killProcessGroup(child, signal)
      const result = await exited
      assert.equal(result.code, exitCode, `${signal} 应由前置 trap 转为 ${exitCode}：\n${result.stdout}\n${result.stderr}`)
      assert.equal(result.signal, null)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { killProcessGroup(child, 'SIGKILL') } catch {}
      }
    }

    if (mode === 'owned') {
      assert.ok(!fs.existsSync(control), '本进程已创建但尚未写状态的 control lock 必须被事务式 acquisition 清理')
      assert.ok(!fs.existsSync(controlGuard), 'owned guard 必须与 control 一起清理')
    } else {
      assert.ok(fs.existsSync(control), 'guard 不匹配时即使 foreign control 为空也不得 rmdir')
      assert.deepEqual(fs.readdirSync(control), [])
      assert.equal(fs.readFileSync(controlGuard, 'utf8'), 'FOREIGN-GUARD\n', '未取得 guard 时绝不能删除他人 guard')
    }
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
    assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /"stop"/)
  })
}

// R7-P1②：真实 SIGTERM 命中「rename 已完成、正常 WAL 清理尚未执行」的竞态窗口
//
// 旧测试用 readiness 超时触发 EXIT，但那发生在正常路径已经执行 `rm -f "$DB-wal" "$DB-shm"`
// **之后**；把 trap 的清理删掉它仍会绿，是假绿。这里把 PATH 里的 mv 换成握手桩：
//   1. 先调用真 /bin/mv，确保 app.db 已原子换成快照；
//   2. 写出握手文件，证明 rename 已成功；
//   3. 故意阻塞，不把控制权还给父 shell（旧实现的 DB_REPLACED=1 与正常 rm 都还没机会执行）；
//   4. 测试进程向整个 restore 进程组发送真实 SIGTERM/SIGINT。
//
// 这样断言的正是生产竞态本身，不借 readiness 超时、不靠猜时间。app.db 预先删除以跳过
// VACUUM INTO，保证预置的旧 WAL/SHM 不会在信号窗口之前被 SQLite 顺手 checkpoint 掉。
// ============================================================================
for (const { signal, exitCode } of [
  { signal: 'SIGTERM' as const, exitCode: 143 },
  { signal: 'SIGINT' as const, exitCode: 130 },
]) {
test(`R7-P1②：真实 ${signal} 落在 mv 成功窗口 → 清旧 WAL/SHM 但保持停机与锁，退出 ${exitCode}`, async () => {
  const { dataDir, backupsDir } = scene(`trap-wal-${signal.toLowerCase()}`, 'CURRENT')
  const snap = path.join(backupsDir, `backup-2026-07-28T05-00-00-${exitCode}.db`)
  makeSnapshot(snap, 'SNAPSHOT-WAL')

  // 🔴 删掉 app.db：现场留存整段被跳过 ⇒ 全程没有任何东西打开这个库 ⇒ 预置的 WAL 不会被
  //    VACUUM 顺手 checkpoint 掉，能原样活到 trap 那一刻（见上面注入点说明）。
  fs.rmSync(path.join(dataDir, 'app.db'), { force: true })
  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')
  fs.writeFileSync(wal, 'STALE-WAL-FRAMES')
  fs.writeFileSync(shm, 'STALE-SHM')

  const signalBin = path.join(path.dirname(dataDir), 'signal-bin')
  fs.mkdirSync(signalBin, { recursive: true })
  fs.writeFileSync(
    path.join(signalBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(signalBin)

  const mvDone = path.join(path.dirname(dataDir), 'target-mv-done')
  fs.writeFileSync(
    path.join(signalBin, 'mv'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
/bin/mv "$@" || exit $?
if [ "$target" = "$TEST_BLOCK_MV_TARGET" ]; then
  : > "$TEST_MV_DONE"
  while :; do sleep 1; done
fi
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  const startStateFile = path.join(path.dirname(dataDir), 'start-state.jsonl')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(startStateFile, '')
  const child = spawn('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${signalBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_BLOCK_MV_TARGET: path.join(fs.realpathSync(dataDir), 'app.db'),
      TEST_MV_DONE: mvDone,
      TEST_START_STATE: startStateFile,
      TEST_WAL_PATH: wal,
      TEST_SHM_PATH: shm,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = collectExit(child, 30_000)
  let r: Awaited<typeof exited>
  try {
    await waitForFile(mvDone, 20_000)
    assert.ok(fs.existsSync(path.join(dataDir, 'app.db')), '前置：真 mv 已成功，目标库已存在')
    assert.ok(
      !fs.existsSync(path.join(dataDir, '.restore-in-progress', 'snapshot.db')),
      '前置：rename 成功后私有 stage 已消失',
    )
    killProcessGroup(child, signal)
    r = await exited
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { killProcessGroup(child, 'SIGKILL') } catch {}
    }
  }

  // ⚠️ 顺序要紧：先取 sidecar 与 start 时状态，再打开 DB；readMarker() 可能重建 sidecar。
  const walGone = !fs.existsSync(wal)
  const shmGone = !fs.existsSync(shm)
  const startStates = fs.readFileSync(startStateFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  assert.equal(r.code, exitCode, `${signal} 应映射为清晰的 ${exitCode} 退出码：\n${r.stdout}\n${r.stderr}`)
  assert.equal(r.signal, null, `${signal} 应由脚本 trap 消化后退出，不是被内核直接杀死`)
  assert.equal(
    readMarker(path.join(dataDir, 'app.db')),
    'SNAPSHOT-WAL',
    '前置：库确实已经换成快照',
  )

  // 🔴 核心：trap 必须从文件系统状态识别「rename 已成功」，不能依赖尚未来得及执行的下一行赋值。
  assert.ok(
    walGone,
    `🔴 ${signal} 落在 mv/状态推进之间时仍必须清掉旧库 -wal\n${r.stdout}\n${r.stderr}`,
  )
  assert.ok(shmGone, '🔴 trap 必须清掉旧库 -shm')
  assert.equal(startStates.length, 0, '库已替换但尚未 ready/accepted，信号收尾不得 start')
  const lock = path.join(dataDir, '.restore-in-progress')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  assert.ok(fs.existsSync(lock), '库已替换的信号退出必须保留状态锁')
  assert.ok(fs.existsSync(control), '库已替换的信号退出必须保留 host-only control')
  assert.ok(fs.existsSync(path.join(control, 'sidecars-clean')), '应留下旧 sidecar 已清理证据')
  assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')))
})
}

test('R7-P1②：SIGKILL 落在 mv 成功窗口 → 状态锁保留 armed 并阻断下一次 restore', async () => {
  const { dataDir, backupsDir } = scene('trap-wal-sigkill', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T05-15-00-sigkill.db')
  makeSnapshot(snap, 'SNAPSHOT-SIGKILL')
  fs.rmSync(path.join(dataDir, 'app.db'), { force: true })
  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')
  fs.writeFileSync(wal, 'STALE-WAL-SIGKILL')
  fs.writeFileSync(shm, 'STALE-SHM-SIGKILL')

  const killBin = path.join(path.dirname(dataDir), 'sigkill-bin')
  fs.mkdirSync(killBin, { recursive: true })
  fs.writeFileSync(
    path.join(killBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(killBin)
  const mvDone = path.join(path.dirname(dataDir), 'sigkill-mv-done')
  fs.writeFileSync(
    path.join(killBin, 'mv'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
/bin/mv "$@" || exit $?
if [ "$target" = "$TEST_BLOCK_MV_TARGET" ]; then
  : > "$TEST_MV_DONE"
  while :; do sleep 1; done
fi
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  const startStateFile = path.join(path.dirname(dataDir), 'start-state.jsonl')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(startStateFile, '')
  const child = spawn('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${killBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_BLOCK_MV_TARGET: path.join(fs.realpathSync(dataDir), 'app.db'),
      TEST_MV_DONE: mvDone,
      TEST_START_STATE: startStateFile,
      TEST_WAL_PATH: wal,
      TEST_SHM_PATH: shm,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = collectExit(child, 30_000)
  await waitForFile(mvDone, 20_000)
  killProcessGroup(child, 'SIGKILL')
  const killed = await exited

  const lock = path.join(dataDir, '.restore-in-progress')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  assert.equal(killed.code, null)
  assert.equal(killed.signal, 'SIGKILL', `应由不可捕获 SIGKILL 终止：\n${killed.stdout}\n${killed.stderr}`)
  assert.equal(fs.readFileSync(startStateFile, 'utf8'), '', 'SIGKILL 无 trap，不能假装已安全 start')
  assert.ok(fs.existsSync(path.join(control, 'replace-armed')), '进程级 SIGKILL 后 host-only armed 状态必须保留')
  assert.ok(!fs.existsSync(path.join(lock, 'snapshot.db')), 'stage 已被 mv，当前文件系统状态可判定数据库已替换')
  assert.ok(fs.existsSync(wal) && fs.existsSync(shm), '不可捕获信号下旧 sidecar 仍在，必须靠锁阻止误启动/再还原')

  const retry = runRestore(dataDir, backupsDir, snap)
  assert.equal(retry.status, 4, '🔴 下一次 restore 必须被持久锁阻断，不能踩着未清 sidecar 继续')
  assert.match(retry.stderr, /数据库.*已替换.*尚未验收|旧 WAL\/SHM 尚待确认/)
  assert.match(retry.log, /"stop"/, '下一次 restore 必须先按残锁 exact ID 尝试停机')
  assert.doesNotMatch(retry.log, /"start"/, '未验收残锁绝不能重启 app')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-SIGKILL', '数据库本体确实已完成原子替换')
})

test('P6-R2 残锁自愈：app-started 但未 accepted 时下一次 restore 必须先停精确容器再 exit 4', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'stale-app-started-lock-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-stale-lock.db')
  makeSnapshot(snap, 'UNUSED')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  fs.mkdirSync(control, { mode: 0o700 })
  fs.writeFileSync(path.join(control, 'app-started'), '', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'container-id'), CONTAINER_A + '\n', { mode: 0o600 })
  fs.writeFileSync(
    path.join(control, 'container-networks'),
    `stub-network\t${NETWORK_ID}\tapp\tstub-app-a\n`,
    { mode: 0o600 },
  )
  fs.writeFileSync(path.join(control, 'compose-project'), 'xiaojimao-hub\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-service'), 'app\n', { mode: 0o600 })
  writeDefinitelyStaleOwnerEvidence(control)
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir)))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)
  assert.equal(r.status, 4, `残锁仍应以 4 阻断：\n${r.stdout}\n${r.stderr}`)
  assert.equal(afterState.containers[CONTAINER_A].running, false, '🔴 报人工处理前必须先停未接受实例')
  assert.match(r.stderr, /app.*启动.*未.*接受|未接受实例.*停止/i)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT', '残锁处置不得修改数据库')
})

test('P6-R2 残锁 owner：跨 UID 的 Linux /proc 指纹匹配时不得 stop 或断网', () => {
  const ownerPid = '4242'
  const ownerTicks = '987654321'
  const c = ownerResidualCase(
    'live-root-owner-nonroot-retry',
    ownerPid,
    linuxOwnerFingerprint(ownerTicks),
  )
  const { sudoPath, probeLog } = installLinuxOwnerProbeBin(c.dockerBin)

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
    TEST_OWNER_PROBE_LOG: probeLog,
    TEST_OWNER_BOOT_ID: OWNER_TEST_BOOT_ID,
    TEST_OWNER_PID: ownerPid,
    TEST_OWNER_CURRENT_TICKS: ownerTicks,
    TEST_OWNER_PROC_MODE: 'matching',
  })
  const afterState = readDockerState(c.stateFile)
  const probeCalls = fs.readFileSync(probeLog, 'utf8')

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 活跃 root owner 不得被普通 UID retry 停止')
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1, '🔴 活跃 owner 的 endpoint 不得被断开')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'), '跨 UID matching 时 docker stop 必须为 0 次')
  assert.ok(
    !afterState.events.some((event) => event[0] === 'network-disconnect'),
    '跨 UID matching 时 docker network disconnect 必须为 0 次',
  )
  assert.match(r.stderr, /owner.*存活|并发 restore/i)
  assert.match(probeCalls, /cat -- \/proc\/sys\/kernel\/random\/boot_id/)
  assert.match(probeCalls, new RegExp(`cat -- /proc/${ownerPid}/stat`), '🔴 /proc owner stat 必须经 $SUDO 读取')
})

test('P6-R2 残锁 owner：Linux /proc 权限未知时必须阻断但不得 containment', () => {
  const ownerPid = '4243'
  const c = ownerResidualCase(
    'unknown-owner-permission',
    ownerPid,
    linuxOwnerFingerprint('222222222'),
  )
  const { sudoPath, probeLog } = installLinuxOwnerProbeBin(c.dockerBin)
  const accepted = path.join(c.control, 'ready-accepted')
  const published = path.join(c.control, 'network-published')
  const acceptedValue = `v2 ${CONTAINER_A} xiaojimao-hub app\n`
  fs.writeFileSync(accepted, acceptedValue, { mode: 0o600 })
  fs.writeFileSync(published, acceptedValue, { mode: 0o600 })
  const acceptedBefore = fs.readFileSync(accepted)
  const dataB = path.join(path.dirname(c.dataDir), 'data-b')
  fs.mkdirSync(dataB, { recursive: true })
  const dockerState = makeDockerState(c.dataDir, dataB)
  dockerState.containers[CONTAINER_B].composeProject = 'xiaojimao-hub'
  dockerState.containers[CONTAINER_B].composeService = 'app'
  dockerState.containers[CONTAINER_B].running = true
  fs.writeFileSync(c.stateFile, JSON.stringify(dockerState))

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
    TEST_OWNER_PROBE_LOG: probeLog,
    TEST_OWNER_BOOT_ID: OWNER_TEST_BOOT_ID,
    TEST_OWNER_PID: ownerPid,
    TEST_OWNER_CURRENT_TICKS: '222222222',
    TEST_OWNER_PROC_MODE: 'denied',
  })
  const afterState = readDockerState(c.stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 owner 权限未知不得被当 stale 停止')
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1, '🔴 owner 权限未知不得断开网络')
  assert.equal(afterState.containers[CONTAINER_B].running, true, '🔴 unknown owner 时也不得停额外 service 实例')
  assert.equal(afterState.containers[CONTAINER_B].networks.length, 1, '🔴 unknown owner 时不得断开额外实例网络')
  assert.ok(!afterState.events.some((event) => event[0] === 'stop'))
  assert.ok(!afterState.events.some((event) => event[0] === 'network-disconnect'))
  assert.deepEqual(fs.readFileSync(accepted), acceptedBefore, 'unknown 分支不得改 accepted 状态证据')
  assert.match(r.stderr, /无法确认|权限|unknown/i)
})

test('P6-R2 残锁 owner：严格格式解析失败属于 unknown，不得 containment', () => {
  const ownerPid = '4244'
  const c = ownerResidualCase(
    'malformed-owner-fingerprint',
    ownerPid,
    `${linuxOwnerFingerprint('333333333')} trailing-field`,
  )
  const { sudoPath, probeLog } = installLinuxOwnerProbeBin(c.dockerBin)

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
    TEST_OWNER_PROBE_LOG: probeLog,
    TEST_OWNER_BOOT_ID: OWNER_TEST_BOOT_ID,
    TEST_OWNER_PID: ownerPid,
    TEST_OWNER_CURRENT_TICKS: '333333333',
    TEST_OWNER_PROC_MODE: 'matching',
  })
  const afterState = readDockerState(c.stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true)
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1)
  assert.ok(!afterState.events.some((event) => event[0] === 'stop' || event[0] === 'network-disconnect'))
  assert.match(r.stderr, /无法确认|格式|unknown/i)
})

test('P6-R2 残锁 owner：Darwin sudo/ps 认证失败属于 unknown，不得 containment', () => {
  const ownerPid = '4250'
  const c = ownerResidualCase(
    'darwin-owner-permission-unknown',
    ownerPid,
    'v2 darwin-ps 0 123456:24',
  )
  const sudoLog = path.join(c.dockerBin, 'darwin-owner-sudo.log')
  const sudoPath = path.join(c.dockerBin, 'sudo-darwin-owner')
  fs.writeFileSync(sudoLog, '')
  fs.writeFileSync(path.join(c.dockerBin, 'uname'), '#!/bin/sh\nprintf \'%s\\n\' Darwin\n', { mode: 0o755 })
  fs.writeFileSync(
    path.join(c.dockerBin, 'id'),
    '#!/bin/sh\ncase "$1" in -u|-g) printf \'%s\\n\' 2001 ;; *) exec /usr/bin/id "$@" ;; esac\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    sudoPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_DARWIN_SUDO_LOG"
if [ "$1" = "env" ]; then exit 1; fi
exec "$@"
`,
    { mode: 0o755 },
  )

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
    TEST_DARWIN_SUDO_LOG: sudoLog,
  })
  const afterState = readDockerState(c.stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 sudo 认证失败不能证明 Darwin owner 已死')
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1)
  assert.ok(!afterState.events.some((event) => event[0] === 'stop' || event[0] === 'network-disconnect'))
  assert.match(fs.readFileSync(sudoLog, 'utf8'), /env LC_ALL=C ps/)
  assert.match(r.stderr, /无法确认|权限|认证|查询失败|unknown/i)
})

test('P6-R2 残锁 owner：Darwin PID 枚举成功但空输出仍是 unknown，不得 containment', () => {
  const c = ownerResidualCase(
    'darwin-owner-empty-enumeration',
    '4251',
    'v2 darwin-ps 0 123456:24',
  )
  const sudoPath = path.join(c.dockerBin, 'sudo-darwin-empty')
  fs.writeFileSync(path.join(c.dockerBin, 'uname'), '#!/bin/sh\nprintf \'%s\\n\' Darwin\n', { mode: 0o755 })
  fs.writeFileSync(
    path.join(c.dockerBin, 'id'),
    '#!/bin/sh\ncase "$1" in -u|-g) printf \'%s\\n\' 2001 ;; *) exec /usr/bin/id "$@" ;; esac\n',
    { mode: 0o755 },
  )
  fs.writeFileSync(
    sudoPath,
    '#!/bin/sh\nif [ "$1" = "env" ]; then exit 0; fi\nexec "$@"\n',
    { mode: 0o755 },
  )

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
  })
  const afterState = readDockerState(c.stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 空 PID 列表不能证明 owner 已死')
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1)
  assert.ok(!afterState.events.some((event) => event[0] === 'stop' || event[0] === 'network-disconnect'))
  assert.match(r.stderr, /无法确认|枚举格式异常|unknown/i)
})

test('P6-R2 残锁 owner：Linux 同 PID start ticks 不匹配才按 PID reuse stale 收口', () => {
  const ownerPid = '4245'
  const c = ownerResidualCase(
    'owner-pid-reused-linux-proc',
    ownerPid,
    linuxOwnerFingerprint('444444444'),
  )
  const { sudoPath, probeLog } = installLinuxOwnerProbeBin(c.dockerBin)

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
    TEST_OWNER_PROBE_LOG: probeLog,
    TEST_OWNER_BOOT_ID: OWNER_TEST_BOOT_ID,
    TEST_OWNER_PID: ownerPid,
    TEST_OWNER_CURRENT_TICKS: '555555555',
    TEST_OWNER_PROC_MODE: 'reused',
  })
  const afterState = readDockerState(c.stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, false, 'PID reuse 必须进入 stale containment')
  assert.deepEqual(afterState.containers[CONTAINER_A].networks, [])
  assert.ok(afterState.events.some((event) => event[0] === 'stop'))
})

test('P6-R2 残锁 owner：Linux /proc 明确确认 PID 已不存在时按 stale 收口', () => {
  const ownerPid = '4246'
  const c = ownerResidualCase(
    'owner-definitely-dead-linux-proc',
    ownerPid,
    linuxOwnerFingerprint('666666666'),
  )
  const { sudoPath, probeLog } = installLinuxOwnerProbeBin(c.dockerBin)

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: sudoPath,
    TEST_OWNER_PROBE_LOG: probeLog,
    TEST_OWNER_BOOT_ID: OWNER_TEST_BOOT_ID,
    TEST_OWNER_PID: ownerPid,
    TEST_OWNER_CURRENT_TICKS: '666666666',
    TEST_OWNER_PROC_MODE: 'dead',
  })
  const afterState = readDockerState(c.stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, false, '明确 dead owner 必须进入 stale containment')
  assert.deepEqual(afterState.containers[CONTAINER_A].networks, [])
  assert.ok(afterState.events.some((event) => event[0] === 'stop'))
})

test('P6-R2 hidepid：非 root 且 SUDO= 时，目标 stat 不可读必须保持 unknown', () => {
  const ownerPid = '4247'
  const c = ownerResidualCase(
    'owner-definitely-dead-linux-direct-proc',
    ownerPid,
    linuxOwnerFingerprint('777777777'),
  )
  const { probeLog } = installDirectLinuxOwnerProbeBin(c.dockerBin)

  const r = runStatefulRestore(c.dataDir, c.backupsDir, c.snap, c.dockerBin, c.stateFile, {
    SUDO: '',
    TEST_OWNER_PROBE_LOG: probeLog,
    TEST_OWNER_BOOT_ID: OWNER_TEST_BOOT_ID,
  })
  const afterState = readDockerState(c.stateFile)
  const probeCalls = fs.readFileSync(probeLog, 'utf8')

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 hidepid 下目标不可见不得推断 owner 已死')
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1)
  assert.ok(!afterState.events.some((event) => event[0] === 'stop' || event[0] === 'network-disconnect'))
  assert.match(probeCalls, new RegExp(`cat -- /proc/${ownerPid}/stat`))
  assert.doesNotMatch(probeCalls, /find \/proc /, '非 root 通道不得用 hidepid 下的不完整枚举推断 ESRCH')
  assert.match(r.stderr, /无法确认|权限|unknown/i)
})

test('P6-R2 残锁自愈：replace 已完成且 sidecar/marker 已清但未启动时也先停并隔离 exact ID', () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('stale-post-replace-lock')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  const publicLock = path.join(dataDir, '.restore-in-progress')
  fs.mkdirSync(control, { mode: 0o700 })
  fs.mkdirSync(publicLock, { mode: 0o700 })
  for (const marker of ['replace-armed', 'sidecars-clean', 'upgrade-marker-clean']) {
    fs.writeFileSync(path.join(control, marker), '\n', { mode: 0o600 })
  }
  fs.writeFileSync(path.join(control, 'container-id'), `${CONTAINER_A}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-project'), 'xiaojimao-hub\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-service'), 'app\n', { mode: 0o600 })
  writeDefinitelyStaleOwnerEvidence(control)

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, false, '🔴 post-replace 残锁也必须精确停止 A')
  assert.deepEqual(afterState.containers[CONTAINER_A].networks, [], 'post-replace 残锁必须确认无流量网络')
  assert.match(r.stderr, /数据库.*替换|sidecar|停止.*隔离|人工/i)
  assert.ok(fs.existsSync(control))
})

test('P6-R2 残锁自愈：docker inspect 故障不得伪装成 exact 容器不存在/已安全停止', () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('stale-inspect-failure')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  fs.mkdirSync(control, { mode: 0o700 })
  fs.writeFileSync(path.join(control, 'app-started'), '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'container-id'), `${CONTAINER_A}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-project'), 'xiaojimao-hub\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-service'), 'app\n', { mode: 0o600 })
  writeDefinitelyStaleOwnerEvidence(control)

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_INSPECT_FAIL_ID: CONTAINER_A,
  })
  const afterState = readDockerState(stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '前置：inspect 故障时不能声称已真的停机')
  assert.match(r.stderr, /无法确认|inspect|Docker.*状态|立即检查/i)
  assert.doesNotMatch(r.stderr, /已按锁内精确 ID 停止并隔离实例/)
  assert.match(r.log, new RegExp(`\\["inspect","${CONTAINER_A}"\\]`), '必须实际命中 exact inspect 故障分支')
  assert.match(r.log, new RegExp(`id=${CONTAINER_A}`), 'inspect 失败后必须用 docker ps id filter 区分不存在与不可观测')
  assert.ok(fs.existsSync(control))
})

test('P6-R2 残锁自愈：inspect 404 且 docker ps id filter 确认不存在时可安全报告残锁', () => {
  const { root, dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('stale-container-gone')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  fs.mkdirSync(control, { mode: 0o700 })
  fs.writeFileSync(path.join(control, 'app-started'), '\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'container-id'), `${CONTAINER_A}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-project'), 'xiaojimao-hub\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-service'), 'app\n', { mode: 0o600 })
  writeDefinitelyStaleOwnerEvidence(control)
  const state = readDockerState(stateFile)
  delete state.containers[CONTAINER_A]
  state.current = ''
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)

  assert.equal(r.status, 4)
  assert.match(r.stderr, /不存在|已移除|残锁|人工/i)
  assert.doesNotMatch(r.stderr, /无法确认.*停止|立即检查 Docker 状态/i)
  assert.match(r.log, new RegExp(`\\["inspect","${CONTAINER_A}"\\]`), '必须实际先 inspect 锁内 exact ID')
  assert.match(r.log, new RegExp(`id=${CONTAINER_A}`), 'inspect 404 后必须由 docker ps id filter 明确确认不存在')
  assert.ok(fs.existsSync(control))
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT')
})

test('P6-R2 published 残锁：Compose 漂到 B 时保留已验收 A，仅停止隔离未验收 B', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'stale-published-with-drift-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-PUBLISHED')
  makeDb(path.join(dataB, 'app.db'), 'B-UNACCEPTED')
  const snap = path.join(backupsDir, 'backup-unused.db')
  makeSnapshot(snap, 'UNUSED')
  const control = `${fs.realpathSync(dataA)}.restore-control`
  fs.mkdirSync(control, { mode: 0o700 })
  const accepted = `v2 ${CONTAINER_A} xiaojimao-hub app\n`
  fs.writeFileSync(path.join(control, 'ready-accepted'), accepted, { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'network-published'), accepted, { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'container-id'), `${CONTAINER_A}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-project'), 'xiaojimao-hub\n', { mode: 0o600 })
  fs.writeFileSync(path.join(control, 'compose-service'), 'app\n', { mode: 0o600 })
  writeDefinitelyStaleOwnerEvidence(control)
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.containers[CONTAINER_B].composeProject = state.composeProject
  state.containers[CONTAINER_B].composeService = state.composeService
  state.containers[CONTAINER_B].running = true
  state.current = CONTAINER_B
  state.composeSource = dataB
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_TRUNCATE_ALL_IDS_WITHOUT_FLAG: '1',
  })
  const afterState = readDockerState(stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, 'trusted published A 不得反向停机')
  assert.equal(afterState.containers[CONTAINER_A].networks.length, 1)
  assert.equal(afterState.containers[CONTAINER_B].running, false, '🔴 未验收替代 B 必须精确停止')
  assert.deepEqual(afterState.containers[CONTAINER_B].networks, [], '替代 B 必须撤回全部网络')
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
  assert.ok(fs.existsSync(path.join(control, 'network-published')))
})

test('P6-R2 published 残锁：仅剩 handoff 且枚举失败时持久化 ambiguous 证据', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'stale-published-handoff-enumeration-fail-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-PUBLISHED')
  makeDb(path.join(dataB, 'app.db'), 'B-UNKNOWN')
  const snap = path.join(backupsDir, 'backup-unused.db')
  makeSnapshot(snap, 'UNUSED')
  const physicalDataA = fs.realpathSync(dataA)
  const control = `${physicalDataA}.restore-control`
  const handoff = `${physicalDataA}.restore-control-accepted`
  fs.writeFileSync(handoff, `v2 ${CONTAINER_A} xiaojimao-hub app\n`, { mode: 0o600 })
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.containers[CONTAINER_B].composeProject = state.composeProject
  state.containers[CONTAINER_B].composeService = state.composeService
  state.containers[CONTAINER_B].running = true
  state.extraAppeared = true
  state.current = CONTAINER_A
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_SERVICE_PS_WHEN_EXTRA: '1',
  })
  const afterState = readDockerState(stateFile)
  const ambiguous = path.join(control, 'ambiguous-publication')

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, 'published A 不得反向停机')
  assert.equal(afterState.containers[CONTAINER_B].running, true, '前置：枚举失败时 B 的状态无法确认')
  assert.ok(fs.existsSync(handoff), 'accepted handoff 必须保留')
  assert.ok(fs.existsSync(ambiguous), '🔴 published 残锁枚举失败必须持久化 ambiguous 证据')
  assert.equal(fs.statSync(ambiguous).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(ambiguous, 'utf8'), `v2 ${CONTAINER_A} xiaojimao-hub app\n`)
})

test('P6-R2 published 残锁：仅剩 handoff 且 Compose ps 失败时同样持久化 ambiguous', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'stale-published-handoff-compose-fail-'))
  const dataA = path.join(root, 'data-a')
  const dataB = path.join(root, 'data-b')
  const backupsDir = path.join(dataA, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataA, 'app.db'), 'A-PUBLISHED')
  makeDb(path.join(dataB, 'app.db'), 'B-UNKNOWN')
  const snap = path.join(backupsDir, 'backup-unused.db')
  makeSnapshot(snap, 'UNUSED')
  const physicalDataA = fs.realpathSync(dataA)
  const control = `${physicalDataA}.restore-control`
  const handoff = `${physicalDataA}.restore-control-accepted`
  fs.writeFileSync(handoff, `v2 ${CONTAINER_A} xiaojimao-hub app\n`, { mode: 0o600 })
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  const state = makeDockerState(dataA, dataB)
  state.containers[CONTAINER_B].composeProject = state.composeProject
  state.containers[CONTAINER_B].composeService = state.composeService
  state.containers[CONTAINER_B].running = true
  state.extraAppeared = true
  state.current = CONTAINER_A
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataA, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_COMPOSE_PS_ALWAYS: '1',
  })
  const afterState = readDockerState(stateFile)
  const ambiguous = path.join(control, 'ambiguous-publication')

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true)
  assert.equal(afterState.containers[CONTAINER_B].running, true)
  assert.ok(fs.existsSync(handoff))
  assert.ok(fs.existsSync(ambiguous))
  assert.equal(fs.statSync(ambiguous).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(ambiguous, 'utf8'), `v2 ${CONTAINER_A} xiaojimao-hub app\n`)
})

test('P6-R2 public 残锁：仅 DATA_DIR 内伪造 matching accepted/published 不得获得停机授权', () => {
  const root = fs.mkdtempSync(path.join(tmpDir, 'public-forged-publication-lock-'))
  const dataDir = path.join(root, 'data')
  const backupsDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  makeDb(path.join(dataDir, 'app.db'), 'CURRENT')
  const snap = path.join(backupsDir, 'backup-legacy-forged.db')
  makeSnapshot(snap, 'UNUSED')
  const lock = path.join(dataDir, '.restore-in-progress')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  fs.mkdirSync(lock, { mode: 0o700 })
  const forged = `v1 forged-public ${CONTAINER_A}\n`
  fs.writeFileSync(path.join(lock, 'ready-accepted'), forged, { mode: 0o600 })
  fs.writeFileSync(path.join(lock, 'network-published'), forged, { mode: 0o600 })
  fs.writeFileSync(path.join(lock, 'container-id'), `${CONTAINER_A}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(lock, 'container-networks'), 'stub-network\tapp\tstub-app-a\n', { mode: 0o600 })
  const { dir: dockerBin, stateFile } = installStatefulDockerBin(root)
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir)))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.equal(r.status, 4)
  assert.equal(afterState.containers[CONTAINER_A].running, true, '🔴 app 可写的 public container-id 不得授权停止任意容器')
  assert.doesNotMatch(r.stderr, /最终身份均已确认.*不自动停止/, '没有 host-only trusted control 时不得诊断为 finalized')
  assert.ok(fs.existsSync(lock))
})

// trap 还必须在精确 `docker stop <captured-id>` **之前**安装。否则 stop 已把服务停下、父 shell 尚未来得及
// 执行下一行时收到 TERM，会直接退出且永不 start。这里让 stop 桩在“已接到停机命令”后阻塞，再发真信号。
test('R7-P1②：SIGTERM 落在 stop 命令窗口 → 保留旧 WAL 并重启 app，退出 143', async () => {
  const { dataDir, backupsDir } = scene('trap-stop-signal', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T05-30-00-stop.db')
  makeSnapshot(snap, 'SNAPSHOT-UNUSED')
  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')
  fs.writeFileSync(wal, 'CURRENT-DB-WAL')
  fs.writeFileSync(shm, 'CURRENT-DB-SHM')

  const stopBin = path.join(path.dirname(dataDir), 'stop-signal-bin')
  fs.mkdirSync(stopBin, { recursive: true })
  const stopEntered = path.join(path.dirname(dataDir), 'stop-entered')
  fs.writeFileSync(
    path.join(stopBin, 'docker'),
    `#!/bin/sh
if [ "$1" = "stop" ] && [ "$2" = "${CONTAINER_A}" ]; then
  : > "$TEST_STOP_ENTERED"
  while :; do sleep 1; done
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  installReadyCurlStub(stopBin)

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  const startStateFile = path.join(path.dirname(dataDir), 'start-state.jsonl')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(startStateFile, '')
  const child = spawn('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${stopBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_STOP_ENTERED: stopEntered,
      TEST_START_STATE: startStateFile,
      TEST_WAL_PATH: wal,
      TEST_SHM_PATH: shm,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = collectExit(child)
  let r: Awaited<typeof exited>
  try {
    await waitForFile(stopEntered)
    killProcessGroup(child, 'SIGTERM')
    r = await exited
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { killProcessGroup(child, 'SIGKILL') } catch {}
    }
  }

  const states = fs.readFileSync(startStateFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(r.code, 143, `stop 窗口 SIGTERM 应受控退出 143：\n${r.stdout}\n${r.stderr}`)
  assert.equal(r.signal, null)
  assert.deepEqual(states, [{ walExists: true, shmExists: true }], '🔴 未替换数据库时应保留当前 WAL 后再 start')
  assert.ok(fs.existsSync(wal) && fs.existsSync(shm), '当前数据库的 sidecar 不得被误删')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT', 'stop 窗口信号不得改动数据库')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), 'stop 窗口优雅收尾后应释放锁')
})

// replace-armed 已创建并不等于 rename 已成功：信号也可能落在 armed 创建后、mv 真正执行前。
// 桩 mv 在目标 rename **之前**握手并阻塞，同时重建一对旧 sidecar（避开前面 VACUUM checkpoint 的干扰）。
// 正确判据必须继续看私有 snapshot.db 是否存在；只看 armed 会误删当前库自己的 WAL。
test('R7-P1② 反向：已 armed 但 mv 尚未执行时 SIGTERM → 保留旧 DB/WAL，退出 143', async () => {
  const { dataDir, backupsDir } = scene('trap-armed-before-mv', 'CURRENT-ARMED')
  const snap = path.join(backupsDir, 'backup-2026-07-28T05-45-00-armed.db')
  makeSnapshot(snap, 'SNAPSHOT-NOT-INSTALLED')
  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')

  const signalBin = path.join(path.dirname(dataDir), 'armed-signal-bin')
  fs.mkdirSync(signalBin, { recursive: true })
  fs.writeFileSync(
    path.join(signalBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(signalBin)
  const mvEntered = path.join(path.dirname(dataDir), 'target-mv-entered')
  fs.writeFileSync(
    path.join(signalBin, 'mv'),
    `#!/bin/sh
target=
for arg in "$@"; do target="$arg"; done
if [ "$target" = "$TEST_BLOCK_MV_TARGET" ]; then
  printf '%s' 'CURRENT-DB-WAL' > "$TEST_WAL_PATH"
  printf '%s' 'CURRENT-DB-SHM' > "$TEST_SHM_PATH"
  : > "$TEST_MV_ENTERED"
  while :; do sleep 1; done
fi
/bin/mv "$@"
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  const startStateFile = path.join(path.dirname(dataDir), 'start-state.jsonl')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(startStateFile, '')
  const child = spawn('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${signalBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_BLOCK_MV_TARGET: path.join(fs.realpathSync(dataDir), 'app.db'),
      TEST_MV_ENTERED: mvEntered,
      TEST_START_STATE: startStateFile,
      TEST_WAL_PATH: wal,
      TEST_SHM_PATH: shm,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = collectExit(child)
  let r: Awaited<typeof exited>
  try {
    await waitForFile(mvEntered, 20_000)
    assert.ok(
      fs.existsSync(path.join(dataDir, '.restore-in-progress', 'snapshot.db')),
      '前置：armed 后私有 stage 仍存在',
    )
    killProcessGroup(child, 'SIGTERM')
    r = await exited
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { killProcessGroup(child, 'SIGKILL') } catch {}
    }
  }

  const states = fs.readFileSync(startStateFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(r.code, 143, `armed/mv 前窗口 SIGTERM 应受控退出 143：\n${r.stdout}\n${r.stderr}`)
  assert.equal(r.signal, null)
  assert.deepEqual(states, [{ walExists: true, shmExists: true }], '🔴 mv 未发生时 start 前必须保留当前库 sidecar')
  assert.equal(fs.readFileSync(wal, 'utf8'), 'CURRENT-DB-WAL')
  assert.equal(fs.readFileSync(shm, 'utf8'), 'CURRENT-DB-SHM')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-ARMED', 'app.db 必须仍是旧库')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), 'mv 前优雅信号应清 stage 并释放锁')
  assert.ok(
    !fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`),
    '🔴 mv 未发生且旧 app 已恢复后必须同步释放 host-only control，不能留下假 post-replace 残锁',
  )
})

for (const { label, status, body } of [
  { label: '302 redirect', status: '302', body: '{"ok":true}' },
  { label: '204 other-2xx', status: '204', body: '' },
  { label: '200 ok=false', status: '200', body: '{"ok":false}' },
  { label: '200 malformed', status: '200', body: 'not-json' },
  { label: '200 empty', status: '200', body: '' },
  { label: '200 invalid key whitespace', status: '200', body: '{"o k":true}' },
  { label: '200 invalid literal whitespace', status: '200', body: '{"ok":tr ue}' },
  { label: '200 leading garbage line', status: '200', body: 'garbage\n{"ok":true}' },
  { label: '200 trailing garbage line', status: '200', body: '{"ok":true}\ngarbage' },
  { label: '200 false then true lines', status: '200', body: '{"ok":false}\n{"ok":true}' },
  { label: '200 vertical-tab whitespace', status: '200', body: '\v{"ok":true}' },
  { label: '200 form-feed whitespace', status: '200', body: '{"ok":true}\f' },
] as const) {
  test(`P6-R2 readiness 严格接受：${label} 不得宣告恢复成功`, () => {
    const { dataDir, backupsDir } = scene(`ready-reject-${label.replace(/[^a-z0-9]/gi, '-')}`, 'CURRENT')
    const snap = path.join(backupsDir, `backup-${label.replace(/[^a-z0-9]/gi, '-')}.db`)
    makeSnapshot(snap, 'SNAPSHOT-UNACCEPTED')

    const r = runRestore(dataDir, backupsDir, snap, {
      READY_TIMEOUT: '1',
      TEST_READY_STATUS: status,
      TEST_READY_BODY: body,
    })
    const calls = r.log.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
    const starts = calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A)
    const stops = calls.filter((call) => call[0] === 'stop' && call[1] === CONTAINER_A)
    const control = `${fs.realpathSync(dataDir)}.restore-control`

    assert.equal(r.status, 1, `🔴 ${label} 必须在 deadline 后失败：\n${r.stdout}\n${r.stderr}`)
    assert.doesNotMatch(r.stdout, /恢复完成/)
    assert.equal(starts.length, 1, '只允许正常路径的一次 start，EXIT trap 不得再 start')
    assert.equal(stops.length, 2, 'readiness 未接受时必须再 stop 一次并保持停机')
    assert.ok(fs.existsSync(control), '未接受的恢复必须保留 host-only control')
    assert.ok(fs.existsSync(path.join(control, 'sidecars-clean')))
    assert.ok(fs.existsSync(path.join(control, 'upgrade-marker-clean')))
    assert.ok(fs.existsSync(path.join(control, 'app-started')))
    assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')))
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-UNACCEPTED')
  })
}

test('P6-R2 readiness 严格接受：200 body 在 true 中夹 NUL 不得被 shell 吞掉后误接受', () => {
  const { dataDir, backupsDir } = scene('ready-reject-nul', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-ready-reject-nul.db')
  makeSnapshot(snap, 'SNAPSHOT-NUL-UNACCEPTED')

  const nulBin = path.join(path.dirname(dataDir), 'nul-ready-bin')
  fs.mkdirSync(nulBin, { recursive: true })
  fs.writeFileSync(
    path.join(nulBin, 'docker'),
    `#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '{"ok":tru\\000e}'
  exit 0
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${nulBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      READY_TIMEOUT: '1',
    },
    encoding: 'utf8',
  })
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  assert.equal(r.status, 1, `🔴 NUL 响应不得变成合法 JSON 后成功：\n${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(r.stdout, /恢复完成/)
  assert.equal(calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A).length, 1)
  assert.equal(calls.filter((call) => call[0] === 'stop' && call[1] === CONTAINER_A).length, 2)
  assert.ok(fs.existsSync(control), 'NUL body 未接受时必须保留 host-only control')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-NUL-UNACCEPTED')
})

test('P6-R2 readiness 严格接受：仅 200 + {"ok":true} 释放锁并宣告成功', () => {
  const { dataDir, backupsDir } = scene('ready-accepted', 'CURRENT')
  const realDataDir = fs.realpathSync(dataDir)
  const control = `${realDataDir}.restore-control`
  const guard = `${realDataDir}.restore-control.guard`
  const snap = path.join(backupsDir, 'backup-ready-accepted.db')
  makeSnapshot(snap, 'SNAPSHOT-ACCEPTED')
  const r = runRestore(dataDir, backupsDir, snap, {
    TEST_READY_STATUS: '200',
    TEST_READY_BODY: ' { "ok" : true } ',
  })
  const calls = r.log.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
  assert.equal(r.status, 0, `合法 readiness 应通过：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /恢复完成/)
  assert.equal(calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A).length, 1)
  assert.equal(calls.filter((call) => call[0] === 'stop' && call[1] === CONTAINER_A).length, 1)
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '只有 accepted 后才释放锁')
  assert.ok(!fs.existsSync(control), '成功后 host-only control 必须释放')
  assert.ok(!fs.existsSync(guard), '成功后 control guard 必须释放')
  assert.deepEqual(
    fs.readdirSync(path.dirname(realDataDir)).filter(
      (name) => name.startsWith(`${path.basename(realDataDir)}.restore-control.guard.candidate.`),
    ),
    [],
    '成功后不得遗留 guard candidate',
  )
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-ACCEPTED')
})

test('P6-R2 network publication：按 exact NetworkID 重连全部网络并恢复捕获 aliases', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('network-reconnect-aliases')
  const state = readDockerState(stateFile)
  state.containers[CONTAINER_A].networks.push({
    name: 'stub-network-2',
    networkId: 'e'.repeat(64),
    aliases: ['app-secondary', 'worker-visible'],
    runtimeMacAddress: '02:42:ac:14:00:03',
  })
  fs.writeFileSync(stateFile, JSON.stringify(state))

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterState = readDockerState(stateFile)

  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.deepEqual(
    afterState.containers[CONTAINER_A].networks
      .map((network) => ({ id: network.networkId, name: network.name, aliases: [...network.aliases].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: NETWORK_ID, name: 'stub-network', aliases: ['app', 'stub-app-a'] },
      { id: 'e'.repeat(64), name: 'stub-network-2', aliases: ['app-secondary', 'worker-visible'] },
    ],
  )
  assert.ok(
    afterState.events
      .filter((event) => event[0] === 'network-connect')
      .every((event) => event[3] === CONTAINER_A && event[4] === 'accepted'),
    '全部 exact network connect 都必须发生在 ready-accepted 之后',
  )
})

test('P6-R2 network publication：第一个 connect 失败也必须保持全隔离并记录 publication-failed', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('network-first-connect-fail')
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_NETWORK_CONNECT: 'stub-network',
  })
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0)
  assert.equal(afterState.containers[CONTAINER_A].running, false)
  assert.deepEqual(afterState.containers[CONTAINER_A].networks, [])
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
  assert.ok(fs.existsSync(path.join(control, 'publication-failed')))
  assert.ok(!fs.existsSync(path.join(control, 'network-published')))
})

test('P6-R2 network publication：第二个 connect 失败时回滚为全隔离并保留 accepted 状态', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('publication-network-fail')
  const state = readDockerState(stateFile)
  state.containers[CONTAINER_A].networks.push({
    name: 'stub-network-2',
    networkId: 'e'.repeat(64),
    aliases: ['app-secondary'],
  })
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_NETWORK_CONNECT: 'stub-network-2',
  })
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0, '网络未完整恢复时不得成功')
  assert.doesNotMatch(r.stdout, /恢复完成/)
  assert.ok(fs.existsSync(control), '🔴 network publication 失败时 EXIT cleanup 不得释放 host-only control')
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')), '已通过 strict readiness 的 accepted 证据必须保留')
  assert.ok(fs.existsSync(path.join(control, 'container-networks')), '完整网络清单必须保留供重放/人工处置')
  assert.ok(fs.existsSync(path.join(control, 'networks-isolated')), '失败后必须保留隔离阶段证据')
  assert.ok(fs.existsSync(path.join(control, 'publication-failed')), '可确认全撤回时必须记录 accepted-but-unpublished')
  assert.ok(!fs.existsSync(path.join(control, 'network-published')), '网络未完整重连时绝不能提交 network-published')
  assert.equal(afterState.containers[CONTAINER_A].isolated, true, '🔴 部分 reconnect 失败必须撤回已连网络，恢复全隔离')
  assert.ok(
    afterState.events.some((event) => event[0] === 'network-connect-failed' && event[1] === 'stub-network-2'),
    '前置：第二个 network connect 必须真实失败',
  )
})

test('P6-R2 network publication：重连失败且撤回不完整时停实例并记录 ambiguous-publication', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('publication-network-rollback-fail')
  const state = readDockerState(stateFile)
  state.containers[CONTAINER_A].networks.push({
    name: 'stub-network-2',
    networkId: 'e'.repeat(64),
    aliases: ['app-secondary'],
  })
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const control = `${fs.realpathSync(dataDir)}.restore-control`

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_NETWORK_CONNECT: 'stub-network-2',
    TEST_FAIL_ROLLBACK_DISCONNECT: '1',
  })
  const afterState = readDockerState(stateFile)

  assert.notEqual(r.status, 0)
  assert.equal(
    afterState.containers[CONTAINER_A].running,
    false,
    '🔴 accepted 但 network-published 未提交且无法重新隔离时必须停精确容器',
  )
  assert.ok(fs.existsSync(control))
  assert.ok(fs.existsSync(path.join(control, 'ready-accepted')))
  assert.ok(!fs.existsSync(path.join(control, 'network-published')))
  assert.ok(fs.existsSync(path.join(control, 'networks-reconnecting')), '重连未完成的持久阶段证据必须保留')
  assert.ok(fs.existsSync(path.join(control, 'ambiguous-publication')), '撤回失败必须留下明确发布状态不明证据')
  assert.ok(afterState.events.some((event) => event[0] === 'network-disconnect-failed'))

  const stopCountBeforeRetry = afterState.events.filter((event) => event[0] === 'stop' && event[1] === CONTAINER_A).length
  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterRetry = readDockerState(stateFile)
  assert.equal(retry.status, 4)
  assert.match(retry.stderr, /accepted|readiness.*接受|network-published|停止.*隔离/i)
  assert.ok(
    afterRetry.events.filter((event) => event[0] === 'stop' && event[1] === CONTAINER_A).length > stopCountBeforeRetry,
    '🔴 下次 restore 遇到 accepted-but-not-finalized 残锁时必须再次确认精确实例已停止',
  )
})

test('P6-R2 accepted 控制锁释放：host-only rmdir 失败时保留 trusted 0600 handoff', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('control-release-rmdir-fail')
  const physicalDataDir = fs.realpathSync(dataDir)
  const dataB = path.join(path.dirname(dataDir), 'data-b')
  makeDb(path.join(dataB, 'app.db'), 'B-UNACCEPTED')
  fs.writeFileSync(stateFile, JSON.stringify(makeDockerState(dataDir, dataB)))
  const control = `${physicalDataDir}.restore-control`
  const trustedHandoff = `${physicalDataDir}.restore-control-accepted`
  const failedOnce = path.join(path.dirname(dataDir), 'rmdir-failed-once')
  fs.writeFileSync(
    path.join(dockerBin, 'rmdir'),
    `#!/bin/sh
if [ "$1" = "$TEST_FAIL_RMDIR_TARGET" ] && [ ! -e "$TEST_FAIL_ONCE_MARKER" ]; then
  : > "$TEST_FAIL_ONCE_MARKER"
  exit 73
fi
/bin/rmdir "$@"
`,
    { mode: 0o755 },
  )

  const first = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_RMDIR_TARGET: control,
    TEST_FAIL_ONCE_MARKER: failedOnce,
  })
  const stopCount = readDockerState(stateFile).events.filter(
    (event) => event[0] === 'stop' && event[1] === CONTAINER_A,
  ).length

  assert.notEqual(first.status, 0)
  assert.doesNotMatch(first.stdout, /恢复完成/)
  assert.ok(fs.existsSync(control), 'control rmdir 失败必须保留目录')
  assert.ok(fs.existsSync(trustedHandoff), '🔴 trusted accepted 必须留在 app 不可见的 sibling handoff')
  assert.equal(fs.statSync(trustedHandoff).mode & 0o777, 0o600)
  assert.ok(fs.existsSync(failedOnce), '前置：rmdir 首次故障注入已命中')

  const driftedState = readDockerState(stateFile)
  driftedState.containers[CONTAINER_B].composeProject = driftedState.composeProject
  driftedState.containers[CONTAINER_B].composeService = driftedState.composeService
  driftedState.containers[CONTAINER_B].running = true
  driftedState.current = CONTAINER_A
  driftedState.composeSource = dataDir
  fs.writeFileSync(stateFile, JSON.stringify(driftedState))

  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile)
  const afterRetry = readDockerState(stateFile)
  assert.equal(retry.status, 4)
  assert.match(retry.stderr, /最终身份.*确认|锁释放未完成|readiness.*确认/i)
  assert.equal(
    afterRetry.events.filter((event) => event[0] === 'stop' && event[1] === CONTAINER_A).length,
    stopCount,
    'trusted published 残锁不得误停已接受实例',
  )
  assert.equal(
    afterRetry.containers[CONTAINER_B].running,
    false,
    '🔴 handoff 必须保留 project/service 元数据，使下次 restore 能枚举并停止非当前额外 B',
  )
  assert.match(
    fs.readFileSync(trustedHandoff, 'utf8'),
    new RegExp(`^v2 ${CONTAINER_A} xiaojimao-hub app\\n$`),
    'trusted handoff 必须携带 accepted exact ID 与 service 枚举身份',
  )
})

test('P6-R2 accepted 控制锁释放：trusted accepted handoff rename 失败时原 marker 保持 0600', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('control-release-rename-fail')
  const physicalDataDir = fs.realpathSync(dataDir)
  const control = `${physicalDataDir}.restore-control`
  const trustedAccepted = path.join(control, 'ready-accepted')
  const failedOnce = path.join(path.dirname(dataDir), 'accepted-rename-failed-once')
  fs.writeFileSync(
    path.join(dockerBin, 'mv'),
    `#!/bin/sh
source=
for arg in "$@"; do
  [ "$arg" = "--" ] && continue
  case "$arg" in -*) continue ;; esac
  source=$arg
  break
done
if [ "$source" = "$TEST_FAIL_ACCEPTED_RENAME_SOURCE" ] && [ ! -e "$TEST_FAIL_ONCE_MARKER" ]; then
  : > "$TEST_FAIL_ONCE_MARKER"
  exit 75
fi
/bin/mv "$@"
`,
    { mode: 0o755 },
  )

  const r = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_ACCEPTED_RENAME_SOURCE: trustedAccepted,
    TEST_FAIL_ONCE_MARKER: failedOnce,
  })

  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.stdout, /恢复完成/)
  assert.ok(fs.existsSync(trustedAccepted), 'trusted rename 失败必须保留原 accepted marker')
  assert.equal(fs.statSync(trustedAccepted).mode & 0o777, 0o600)
  assert.ok(!fs.existsSync(`${physicalDataDir}.restore-control-accepted`))
  assert.ok(fs.existsSync(failedOnce), '前置：accepted rename 首次故障注入已命中')
})

test('P6-R2 accepted 控制锁释放：状态 unlink 失败时保留 trusted 0600 handoff 与明确诊断', () => {
  const { dataDir, backupsDir, snap, dockerBin, stateFile } = publicationCase('control-release-unlink-fail')
  const physicalDataDir = fs.realpathSync(dataDir)
  const control = `${physicalDataDir}.restore-control`
  const trustedHandoff = `${physicalDataDir}.restore-control-accepted`
  const readyBody = path.join(control, 'ready-body')
  const failedOnce = path.join(path.dirname(dataDir), 'control-unlink-failed-once')
  fs.writeFileSync(
    path.join(dockerBin, 'rm'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$TEST_FAIL_UNLINK_TARGET" ] && [ ! -e "$TEST_FAIL_ONCE_MARKER" ]; then
    : > "$TEST_FAIL_ONCE_MARKER"
    exit 74
  fi
done
/bin/rm "$@"
`,
    { mode: 0o755 },
  )

  const first = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_UNLINK_TARGET: readyBody,
    TEST_FAIL_ONCE_MARKER: failedOnce,
  })

  assert.notEqual(first.status, 0)
  assert.doesNotMatch(first.stdout, /恢复完成/)
  assert.ok(fs.existsSync(control), '控制状态未清完时目录必须保留')
  assert.ok(fs.existsSync(trustedHandoff), '🔴 accepted 必须已原子交接到 host-only sibling')
  assert.equal(fs.statSync(trustedHandoff).mode & 0o777, 0o600)
  assert.ok(fs.existsSync(failedOnce), '前置：状态 unlink 首次故障注入已命中')

  const retry = runStatefulRestore(dataDir, backupsDir, snap, dockerBin, stateFile, {
    TEST_FAIL_UNLINK_TARGET: readyBody,
  })
  assert.equal(retry.status, 4)
  assert.match(retry.stderr, /最终身份.*确认|锁释放未完成|readiness.*确认/i)
})

// ②a 反向窗口：旧 sidecar 已清理、app 已为新库创建 WAL 后 readiness 失败。
// EXIT trap 必须保留新 WAL，再次 stop app，且保留阶段锁；不得再 start 或释放锁。
test('R7-P1②：readiness 失败后保留新 WAL，停机并保留未接受恢复锁', () => {
  const { dataDir, backupsDir } = scene('trap-new-wal', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T06-00-00-dddddd.db')
  makeSnapshot(snap, 'SNAPSHOT-NEW-WAL')
  fs.rmSync(path.join(dataDir, 'app.db'), { force: true })
  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')
  fs.writeFileSync(wal, 'STALE-WAL')
  fs.writeFileSync(shm, 'STALE-SHM')

  const failBin = path.join(path.dirname(dataDir), 'new-wal-bin')
  fs.mkdirSync(failBin, { recursive: true })
  fs.writeFileSync(
    path.join(failBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  fs.writeFileSync(path.join(failBin, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 })

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  const startStateFile = path.join(path.dirname(dataDir), 'start-state.jsonl')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(startStateFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      READY_TIMEOUT: '1',
      TEST_START_STATE: startStateFile,
      TEST_WAL_PATH: wal,
      TEST_SHM_PATH: shm,
      TEST_CREATE_SIDECARS_ON_START: '1',
      TEST_READY_EXIT: '7',
    },
    encoding: 'utf8',
  })

  const states = fs.readFileSync(startStateFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(r.status, 1, 'readiness 超时应以 1 退出')
  assert.equal(states.length, 1, 'readiness 失败后 EXIT trap 不得再 start')
  assert.deepEqual(states[0], { walExists: false, shmExists: false }, '第一次 start 前旧 sidecar 已清干净')
  assert.equal(fs.readFileSync(wal, 'utf8'), 'NEW-DB-WAL', '🔴 新库 WAL 不得被 EXIT trap 误删')
  assert.equal(fs.readFileSync(shm, 'utf8'), 'NEW-DB-SHM')
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
  assert.equal(calls.filter((call) => call[0] === 'stop' && call[1] === CONTAINER_A).length, 2)
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  assert.ok(fs.existsSync(control), 'readiness 失败必须保留 host-only control')
  assert.ok(fs.existsSync(path.join(control, 'app-started')))
  assert.ok(!fs.existsSync(path.join(control, 'ready-accepted')))
})

test('P6-R2 post-replace：.upgrade-in-progress 删除失败时保持停机并保留阶段锁', () => {
  const { dataDir, backupsDir } = scene('upgrade-marker-rm-fail', 'CURRENT')
  const snap = path.join(backupsDir, 'preupgrade.db')
  makeSnapshot(snap, 'PRE-UPGRADE')
  const marker = path.join(dataDir, '.upgrade-in-progress')
  fs.writeFileSync(marker, snap)

  const failBin = path.join(path.dirname(dataDir), 'marker-rm-fail-bin')
  fs.mkdirSync(failBin, { recursive: true })
  fs.writeFileSync(
    path.join(failBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(failBin)
  fs.writeFileSync(
    path.join(failBin, 'rm'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$TEST_FAIL_RM_MARKER" ]; then
    echo "rm: injected upgrade marker failure" >&2
    exit 73
  fi
done
/bin/rm "$@"
`,
    { mode: 0o755 },
  )
  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, '--after-image-rollback', snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_FAIL_RM_MARKER: path.join(fs.realpathSync(dataDir), '.upgrade-in-progress'),
    },
    encoding: 'utf8',
  })
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
  const lock = path.join(dataDir, '.restore-in-progress')
  const control = `${fs.realpathSync(dataDir)}.restore-control`
  assert.equal(r.status, 73, `应保留 rm 原退出码：\n${r.stdout}\n${r.stderr}`)
  assert.equal(calls.filter((call) => call[0] === 'start' && call[1] === CONTAINER_A).length, 0, '标记未清不得启动')
  assert.equal(calls.filter((call) => call[0] === 'stop' && call[1] === CONTAINER_A).length, 2, '收尾再 stop 保证停机')
  assert.ok(fs.existsSync(marker), '注入失败应保留升级标记')
  assert.ok(fs.existsSync(lock), '必须保留 restore 锁')
  assert.ok(fs.existsSync(path.join(control, 'sidecars-clean')))
  assert.ok(!fs.existsSync(path.join(control, 'upgrade-marker-clean')))
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'PRE-UPGRADE')
})

// ②b 清理失败必须 fail closed：库已经换成快照时，旧 sidecar 删不掉就绝不能 start。
// 旧实现把 rm 的失败 `|| true` 吞掉，随后仍启动 app，等于明知可能混库还继续运行。
test('R7-P1②：数据库已替换但旧 WAL/SHM 删除失败 → 保持 app 停止，不带病重启', () => {
  const { dataDir, backupsDir } = scene('trap-rm-fail', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T06-30-00-rmfail.db')
  makeSnapshot(snap, 'SNAPSHOT-RM-FAIL')
  fs.rmSync(path.join(dataDir, 'app.db'), { force: true })
  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')
  fs.writeFileSync(wal, 'STALE-WAL')
  fs.writeFileSync(shm, 'STALE-SHM')

  const failBin = path.join(path.dirname(dataDir), 'rm-fail-bin')
  fs.mkdirSync(failBin, { recursive: true })
  fs.writeFileSync(
    path.join(failBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  installReadyCurlStub(failBin)
  fs.writeFileSync(
    path.join(failBin, 'rm'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "$TEST_FAIL_RM_WAL" ] || [ "$arg" = "$TEST_FAIL_RM_SHM" ]; then
    echo "rm: injected sidecar cleanup failure" >&2
    exit 73
  fi
done
/bin/rm "$@"
`,
    { mode: 0o755 },
  )

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${failBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      TEST_FAIL_RM_WAL: path.join(fs.realpathSync(dataDir), 'app.db-wal'),
      TEST_FAIL_RM_SHM: path.join(fs.realpathSync(dataDir), 'app.db-shm'),
    },
    encoding: 'utf8',
  })

  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const starts = calls.filter((c) => c[0] === 'start' && c[1] === CONTAINER_A)
  assert.equal(r.status, 1, `sidecar 清理失败应以 1 退出：\n${r.stdout}\n${r.stderr}`)
  assert.equal(starts.length, 0, '🔴 旧 sidecar 未清掉时绝不能调用 start')
  assert.ok(fs.existsSync(wal) && fs.existsSync(shm), '前置：注入确实让旧 sidecar 保持存在')
  assert.match(r.stderr, /拒绝重启 app|app 保持停止/, '必须明确说明是为防混库而保持停机')
  assert.ok(
    fs.existsSync(path.join(`${fs.realpathSync(dataDir)}.restore-control`, 'replace-armed')),
    '不安全失败必须保留 host-only armed 状态',
  )
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-RM-FAIL', '数据库本体已经原子替换成功')
})

// ②c 🔴🔴 反向回归（本轮自查发现的、比原报告更严重的一条）：**库没换掉时绝不能删 WAL**。
//
//     无条件版的 trap 会把「fail-closed、什么都没动」的安全退出变成**永久数据丢失**：
//     `docker compose stop` 正常是优雅停机（SIGTERM → close → checkpoint），但它不保证——
//     进程卡住吃满 stop 超时被 SIGKILL、容器 OOM、宿主断电后残留，都会留下一个**带已提交帧**
//     的 -wal。若脚本随后在换库前失败（pre-restore 留存失败走 fail-closed 退出、Ctrl-C……），
//     无条件删 WAL 就毁掉那段数据的唯一副本。实测：硬杀留下的 -wal 删掉后，之前 COMMIT 过的
//     表变成 "no such table" —— 数据没了，不是回滚到旧值。
//
//     这条钉住「armed + .tmp 消失」门控。没有它，上面那条测试照样全绿（无条件删也满足「删干净」），
//     可脚本已经在另一条路径上吃数据了。
test('R7-P1② 反向：换库前就失败时，当前库的 -wal/-shm 必须原样保留（不许删）', () => {
  const { dataDir, backupsDir } = scene('trap-wal-keep', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T07-00-00-eeeeee.db')
  makeSnapshot(snap, 'ORIGINAL')

  const wal = path.join(dataDir, 'app.db-wal')
  const shm = path.join(dataDir, 'app.db-shm')
  fs.writeFileSync(wal, 'COMMITTED-FRAMES-ONLY-HERE')
  fs.writeFileSync(shm, 'SHM')

  // 🔴 让脚本失败在**换库之前**：把 BACKUP_DIR 里的 pre-restore.db.tmp 占成目录，
  //    现场留存那步的 VACUUM INTO 写不进去 → fail-closed 退出（脚本自己的设计：没有回滚点
  //    就不做破坏性还原）。此刻 app.db 一个字节都没动，它的 WAL 也必须一个字节都不动。
  fs.mkdirSync(path.join(backupsDir, 'pre-restore.db.tmp'), { recursive: true })

  const r = runRestore(dataDir, backupsDir, snap)

  const walKept = fs.existsSync(wal)
  const shmKept = fs.existsSync(shm)

  assert.notEqual(r.status, 0, '前置：现场留存失败应 fail-closed 非零退出')
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT', '前置：库没被换掉')

  // 🔴 核心：这条路径的语义是「什么都没动」。删了 WAL 就等于毁掉可能只存在于其中的已提交数据。
  assert.ok(
    walKept,
    `🔴 库没换就删 -wal ＝ 永久丢数据（硬杀/OOM 后已提交帧只在 WAL 里）\n${r.stdout}\n${r.stderr}`,
  )
  assert.ok(shmKept, '🔴 -shm 同理，未换库时不得删')
  // 且 trap 仍须重启 app（两个目标不能顾此失彼）
  const calls = r.log.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(
    calls.filter((c) => c[0] === 'start' && c[1] === CONTAINER_A).length >= 1,
    '🔴 trap 仍须重启 app',
  )
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '未换库的优雅失败必须释放 public stage/锁')
  assert.ok(
    !fs.existsSync(`${fs.realpathSync(dataDir)}.restore-control`),
    '🔴 未换库且旧 app 已安全重启后必须释放 host-only control，不能留下假残锁',
  )
})

// ============================================================================
// R7-P2⑥（codex R6 指出）：readiness 轮询上限必须是绝对 deadline，不能靠迭代次数估
//
// 问题：修复前 `while [ i -lt 30 ]` + 单轮最多 5s（--max-time）+ sleep 2。正常情况下（连接被拒、
// curl 立即返回）单轮≈2s、30 轮≈60s 与 docs 承诺相符；但**恰在 readiness 卡住时**（接受连接却
// 不响应，即最需要这个上限的场景）单轮变成 5+2=7s ⇒ 实际约 210s，是承诺的 3.5 倍。运维照文档
// 等 60s 会以为脚本挂了而手动打断，打断点可能落在 trap 之外的任意位置。
//
// 修复：开跑记 DEADLINE=now+READY_TIMEOUT，每轮拿当前时间比对 ⇒ 总时长恒 ≤上限（+ 最后一轮的
// 单轮上界）。上限本身可用 READY_TIMEOUT 覆盖，默认仍是文档承诺的 60。
//
// 测试手法：date/curl/sleep 共用虚拟时钟，不靠 8~11s 墙钟区间猜行为：
//   · 第一轮 curl 最多 5s，实际耗 5s；随后 sleep 2s，虚拟时间从 100 到 107；
//   · 第二轮只剩 1s，curl --max-time 必须钳到 1；curl 立即失败后 sleep 也只能是 1；
//   · 到 108 的绝对 deadline 后退出，不能再发第三轮请求。
// 破损版会记录 curl [5,5]、sleep [2,2] 并跑到 109；修复版必须恰为 curl [5,1]、sleep [2,1]。
// 默认值仍是 60 这件事由下面那条静态断言单独钉住（与 docs 承诺对齐）。
// ============================================================================
test('R7-P2⑥ fail-closed：READY_TIMEOUT 非法或超上限时在停机前 exit 2', () => {
  for (const value of ['abc', '0', '-1', '1.5', '86401', '999999', '999999999999999999999999']) {
    const { dataDir, backupsDir } = scene(`invalid-timeout-${value.replace(/[^a-z0-9]/gi, '-')}`, 'CURRENT')
    const snap = path.join(backupsDir, 'backup-invalid-timeout.db')
    makeSnapshot(snap, 'SHOULD-NOT-INSTALL')

    const r = runRestore(dataDir, backupsDir, snap, { READY_TIMEOUT: value })
    assert.equal(r.status, 2, `READY_TIMEOUT=${value} 必须按用法错误退出：\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /READY_TIMEOUT.*1.*86400|READY_TIMEOUT.*正整数/i)
    assert.equal(r.log, '', '🔴 非法 timeout 必须在任何 docker/停机/替换前拒绝')
    assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT', '当前库不得被修改')
  }
})

test('R7-P2⑥：readiness 轮询用绝对 deadline，慢轮次下总时长仍受上限约束（不是 3 倍）', () => {
  const { dataDir, backupsDir } = scene('deadline', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-28T06-00-00-dddddd.db')
  makeSnapshot(snap, 'SNAPSHOT-DL')

  const clockBin = path.join(path.dirname(dataDir), 'clock-bin')
  fs.mkdirSync(clockBin, { recursive: true })
  fs.writeFileSync(
    path.join(clockBin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  const clockFile = path.join(path.dirname(dataDir), 'clock.json')
  fs.writeFileSync(clockFile, JSON.stringify({
    now: 100,
    deadline: 108,
    curlDurations: [5, 0],
    curlCalls: [],
    sleepCalls: [],
  }))
  const clockStub = path.join(clockBin, 'clock-stub.mjs')
  fs.writeFileSync(
    clockStub,
    `import fs from 'node:fs'
const [mode, ...args] = process.argv.slice(2)
const file = process.env.TEST_CLOCK_FILE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
if (mode === 'date') {
  console.log(state.now)
  process.exit(0)
}
if (mode === 'curl') {
  const index = args.indexOf('--max-time')
  const maxTime = Number(args[index + 1])
  const startedAt = state.now
  const duration = state.curlDurations[state.curlCalls.length] ?? 0
  state.curlCalls.push({ startedAt, maxTime, deadline: state.deadline })
  state.now += Math.min(duration, maxTime)
  fs.writeFileSync(file, JSON.stringify(state))
  process.exit(7)
}
if (mode === 'sleep') {
  const seconds = Number(args[0])
  if (!Number.isInteger(seconds)) process.exit(0)
  state.sleepCalls.push(seconds)
  state.now += seconds
  fs.writeFileSync(file, JSON.stringify(state))
  process.exit(0)
}
process.exit(98)
`,
  )
  for (const command of ['date', 'curl', 'sleep']) {
    fs.writeFileSync(
      path.join(clockBin, command),
      `#!/bin/sh\nexec "${process.execPath}" "${clockStub}" ${command} "$@"\n`,
      { mode: 0o755 },
    )
  }

  const logFile = path.join(path.dirname(dataDir), 'stub.log')
  fs.writeFileSync(logFile, '')
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${clockBin}:${process.env.PATH}`,
      STUB_LOG: logFile,
      SUDO: '',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupsDir,
      APP_URL: 'http://stub',
      READY_TIMEOUT: '8',
      TEST_CLOCK_FILE: clockFile,
    },
    encoding: 'utf8',
    timeout: 30_000,
  })
  const state = JSON.parse(fs.readFileSync(clockFile, 'utf8')) as {
    now: number
    deadline: number
    curlCalls: Array<{ startedAt: number; maxTime: number; deadline: number }>
    sleepCalls: number[]
  }

  assert.equal(r.status, 1, `readiness 一直不过应以 1 退出：\n${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /8s 内 .*未通过/, '报错文案里的秒数应跟随实际上限，不是写死的 60')
  assert.deepEqual(
    state.curlCalls.map((call) => call.maxTime),
    [5, 1],
    '🔴 每轮 curl --max-time 必须钳到绝对 deadline 的剩余秒数',
  )
  assert.deepEqual(state.sleepCalls, [2, 1], '🔴 sleep 也必须钳到剩余秒数，不能越过 deadline')
  assert.equal(state.now, state.deadline, '虚拟时间应恰好停在 deadline，不得超时或提前放弃')
  assert.ok(
    state.curlCalls.every((call) => call.maxTime <= call.deadline - call.startedAt),
    '每个 curl 的单次上限都不得大于发起时剩余时间',
  )
})

// 🔴 配套静态断言：上面用 READY_TIMEOUT=8 跑是为了省测试时长，但**对外承诺的默认上限是 60s**
//    （docs/deploy.md 明写「轮询 /api/ready 最多 60s」）。默认值若被改动而文档没跟着改，运维就会
//    照错误的预期等待/打断。这条把「脚本默认值」钉在 60，与文档形成双向约束。
test('R7-P2⑥：READY_TIMEOUT 默认值是 60，与 docs/deploy.md 承诺一致', () => {
  const sh = fs.readFileSync(RESTORE_SH, 'utf8')
  assert.match(
    sh,
    /READY_TIMEOUT="\$\{READY_TIMEOUT:-60\}"/,
    '🔴 默认上限必须是 60s；改了就要同步改 docs/deploy.md 里「最多 60s」的承诺',
  )
  const docs = fs.readFileSync(path.join(REPO, 'docs', 'deploy.md'), 'utf8')
  assert.ok(
    docs.includes('最多 60s'),
    '🔴 docs/deploy.md 里的 readiness 等待上限承诺应与脚本默认值一致',
  )
})
