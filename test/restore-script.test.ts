import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

// ============================================================================
// scripts/restore.sh 回归（P6-R2 复审必修 1 / 建议 3）
//
// 用**桩 docker** 跑真实脚本：桩把 `docker compose run ... -v H:C ... -e <JS>` 里的容器路径按挂载
// 规格换回宿主路径，然后用真 node 跑那段 JS——于是 VACUUM INTO 是真的在跑、真的读写真 SQLite 库，
// 只有「起容器」这一层被替换掉。stop/start 是空操作，curl 恒成功。
//
// ⚠️ 测试库隔离（红线）：全程临时目录，DATA_DIR/BACKUP_DIR 都指向 tmp，绝不碰真实 data/。
// ============================================================================

const REPO = path.resolve(import.meta.dirname, '..')
const RESTORE_SH = path.join(REPO, 'scripts', 'restore.sh')

let tmpDir: string
let binDir: string

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
if (args[0] !== 'compose') process.exit(0)
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

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xjm-restore-'))
  binDir = path.join(tmpDir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  fs.writeFileSync(path.join(binDir, 'docker-stub.mjs'), DOCKER_STUB)
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  // curl 桩：脚本末尾轮询 /api/ready，恒成功即可（起服务不在本文件的验证范围内）
  fs.writeFileSync(path.join(binDir, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
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

async function waitForFile(p: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return
    await delay(20)
  }
  throw new Error(`等待测试握手文件超时：${p}`)
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
})

// ② 建议 3：截断的快照必须在**任何破坏性步骤之前**被拦下
test('建议3：截断快照被 quick_check 拦下 → 退出 1，且没停过 app、没动过 app.db', () => {
  const { dataDir, backupsDir } = scene('truncated', 'CURRENT')
  // 造一个「有 SQLite 头但被截断」的快照：head -c 15 照样过，quick_check 抛 malformed
  const full = path.join(backupsDir, 'full.db')
  makeSnapshot(full, 'SNAPSHOT-B') // 用一致性快照当底本：确保拦下它的是 quick_check，不是 R7-P1① 的 WAL 守卫
  const snap = path.join(backupsDir, 'backup-2026-07-26T02-00-00-ffffff.db')
  fs.writeFileSync(snap, fs.readFileSync(full).subarray(0, 2048))
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

// ============================================================================
// P6-R2 复审三轮第 1 条 + R6① 回归：DB_PATH 覆盖 fail-closed 守卫
//
// backupPaths 尊重 DB_PATH，但 restore.sh 此前硬编码 `DB="$DATA_DIR/app.db"`，在 DB_PATH
// 覆盖时要么恢复到错误位置、要么 realpath 失败崩。解析 DB_PATH 的通用逻辑需要处理符号链接/相对
// 路径/cwd 不定/多级 ../，脚本层做不到以 Node 同样逻辑归一 → fail-closed 简单守卫：检测到
// DB_PATH≠默认值 → 拒绝运行 + 清晰报错。
//
// R6① 增强（codex R5）：宿主侧 DB_PATH 只能看 export 的值，漏了「容器内 .env/compose 配置、
// 宿主未 export」的正常运维场景。增强：从运行中容器读实际生效值，两侧任一非默认就拒绝。
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

test('R3-新② trap 陷阱：stop 后 armed 标记写入失败，app 仍被重启且旧库不动', () => {
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
  fs.writeFileSync(path.join(failBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
      TEST_FAIL_INSTALL_TARGET: path.join(dataDir, '.restore-in-progress', 'replace-armed'),
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 73, `armed 标记写入失败应保留原退出码：\n${r.stdout}\n${r.stderr}`)
  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const startCalls = calls.filter((c) => c[0] === 'compose' && c[1] === 'start')
  assert.ok(startCalls.length >= 1, `trap 应调用 start app（实际 start 调用 ${startCalls.length} 次）`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'CURRENT-POST-STOP', '最终 mv 未发生，旧库必须原样保留')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '安全退出应释放私有 stage/锁')
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
  fs.writeFileSync(path.join(failBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
test('R4-P1②：快照是 pre-restore.db 的符号链接 → stop 前 stage 原内容再还原', () => {
  const { dataDir, backupsDir } = scene('symlink-1hop', 'CURRENT-BROKEN')
  makeSnapshot(path.join(backupsDir, 'pre-restore.db'), 'ORIGINAL')
  const snap = path.join(backupsDir, 'snap.db')
  fs.symlinkSync('pre-restore.db', snap)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'ORIGINAL', '还原内容必须是快照真身')
  // 🔴 修复前：未提前 stage → 现场留存段用当前 app.db 覆盖 pre-restore.db 真身，
  //    后续 install 读到的是刚覆盖进去的 CURRENT-BROKEN，ORIGINAL 静默丢失。
  //    修复后：stop 前已把 ORIGINAL 固化并校验进私有 stage；现场留存照常把 CURRENT-BROKEN 写进
  //    pre-restore.db（给下次反悔），最终 mv 的仍是 stage 里的 ORIGINAL。
  assert.equal(
    readMarker(path.join(backupsDir, 'pre-restore.db')),
    'CURRENT-BROKEN',
    '🔴 pre-restore.db 应更新为本次还原前的现场（给下一次反悔）',
  )
  assert.ok(
    !fs.existsSync(path.join(dataDir, '.restore-in-progress')),
    '私有 stage/锁应在还原完成后清理',
  )
})

// ② 多层链：mid.db -> snap.db -> pre-restore.db（循环解析到底后再 stage）
test('R4-P1②：快照是两层符号链接 → 循环追踪到底，仍能拦下', () => {
  const { dataDir, backupsDir } = scene('symlink-2hop', 'CURRENT')
  makeSnapshot(path.join(backupsDir, 'pre-restore.db'), 'ORIGINAL')
  fs.symlinkSync('pre-restore.db', path.join(backupsDir, 'snap.db'))
  fs.symlinkSync('snap.db', path.join(backupsDir, 'mid.db'))

  const r = runRestore(dataDir, backupsDir, path.join(backupsDir, 'mid.db'))
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'ORIGINAL')
  assert.equal(readMarker(path.join(backupsDir, 'pre-restore.db')), 'CURRENT')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '私有 stage/锁应被清理')
})

// ③ 符号链接目标是绝对路径（readlink 返回 /... 时走的另一条分支）
test('R4-P1②：符号链接目标为绝对路径 → 守卫同样识别', () => {
  const { dataDir, backupsDir } = scene('symlink-abs', 'CURRENT')
  const preRestore = path.join(backupsDir, 'pre-restore.db')
  makeSnapshot(preRestore, 'ORIGINAL')
  const snap = path.join(backupsDir, 'absl.db')
  fs.symlinkSync(preRestore, snap)

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `脚本应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'ORIGINAL')
  assert.equal(readMarker(preRestore), 'CURRENT')
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')))
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
test('P6-R2 TOCTOU：快照 symlink 在校验后被改指 → 仍安装已校验的私有 stage', () => {
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
if [ "$1" = "compose" ] && [ "$2" = "stop" ]; then
  /bin/rm -f "$TEST_SNAPSHOT_LINK"
  /bin/ln -s "$TEST_SWAPPED_TARGET" "$TEST_SNAPSHOT_LINK"
  exit 0
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(path.join(swapBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

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

  assert.equal(r.status, 0, `恢复应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(fs.realpathSync(snap), fs.realpathSync(swapped), '前置：stop 桩确实已把 symlink 改指未校验库')
  assert.equal(
    readMarker(path.join(dataDir, 'app.db')),
    'VALIDATED-GOOD',
    '🔴 最终安装必须钉住 quick_check 校验过的 SNAPSHOT_ABS，不能重新解原始 symlink',
  )
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
if [ "$1" = "compose" ] && [ "$2" = "stop" ]; then
  /bin/mv -f "$TEST_REPLACEMENT" "$TEST_SNAPSHOT_PATH"
  exit 0
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(path.join(swapBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

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
  assert.equal(calls.length, 1, '应恰有一次 quick_check 调用')
  const argv = JSON.parse(calls[0])
  const userIdx = argv.indexOf('--user')
  assert.ok(userIdx >= 0, '🔴 quick_check 必须带 --user（修复前缺此参数 → uid1000 读不了 root:root 0600）')
  assert.equal(argv[userIdx + 1], '0:0', '🔴 必须提权到 root')
})

test('P6-R2：非 uid1000 且使用默认 sudo 时，宿主文件头检查也必须经提权读取私有 stage', () => {
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
  fs.writeFileSync(path.join(logicalBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
printf '%s\\n' "$*" >> "$TEST_SUDO_LOG"
FAKE_ELEVATED=1 exec "$@"
`,
    { mode: 0o755 },
  )
  // 不能真的把测试文件 chown 给不存在的 uid2001/uid1000；记录后成功返回即可。
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
  */.restore-in-progress/snapshot.db)
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
    TEST_SUDO_LOG: sudoLog,
    TEST_CHOWN_LOG: sudoLog,
    TEST_HEAD_LOG: headLog,
  }
  delete env.SUDO
  const r = spawnSync('sh', [RESTORE_SH, snap], {
    cwd: REPO,
    env,
    encoding: 'utf8',
  })

  assert.equal(r.status, 0, `默认 sudo 路径也应成功：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'LOGICAL-UID-SNAPSHOT')
  assert.match(fs.readFileSync(sudoLog, 'utf8'), /chown .*\.restore-in-progress/, '锁目录属主调整应经 sudo')
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

// ============================================================================
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
test(`R7-P1②：真实 ${signal} 落在 mv 成功窗口 → start 前清掉旧 WAL/SHM，退出 ${exitCode}`, async () => {
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
  fs.writeFileSync(path.join(signalBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

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
      TEST_BLOCK_MV_TARGET: path.join(dataDir, 'app.db'),
      TEST_MV_DONE: mvDone,
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
    await waitForFile(mvDone)
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
  assert.equal(startStates.length, 1, '信号收尾应恰好尝试一次 start')
  assert.deepEqual(
    startStates[0],
    { walExists: false, shmExists: false },
    '🔴 docker compose start 被调用的那个瞬间，旧 WAL/SHM 必须已经不存在',
  )
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), '优雅信号收尾后应释放状态锁')
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
  fs.writeFileSync(path.join(killBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
      TEST_BLOCK_MV_TARGET: path.join(dataDir, 'app.db'),
      TEST_MV_DONE: mvDone,
      TEST_START_STATE: startStateFile,
      TEST_WAL_PATH: wal,
      TEST_SHM_PATH: shm,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = collectExit(child)
  await waitForFile(mvDone)
  killProcessGroup(child, 'SIGKILL')
  const killed = await exited

  const lock = path.join(dataDir, '.restore-in-progress')
  assert.equal(killed.code, null)
  assert.equal(killed.signal, 'SIGKILL', `应由不可捕获 SIGKILL 终止：\n${killed.stdout}\n${killed.stderr}`)
  assert.equal(fs.readFileSync(startStateFile, 'utf8'), '', 'SIGKILL 无 trap，不能假装已安全 start')
  assert.ok(fs.existsSync(path.join(lock, 'replace-armed')), '进程级 SIGKILL 后 armed 状态文件必须保留')
  assert.ok(!fs.existsSync(path.join(lock, 'snapshot.db')), 'stage 已被 mv，当前文件系统状态可判定数据库已替换')
  assert.ok(fs.existsSync(wal) && fs.existsSync(shm), '不可捕获信号下旧 sidecar 仍在，必须靠锁阻止误启动/再还原')

  const retry = runRestore(dataDir, backupsDir, snap)
  assert.equal(retry.status, 4, '🔴 下一次 restore 必须被持久锁阻断，不能踩着未清 sidecar 继续')
  assert.match(retry.stderr, /数据库可能已替换|旧 WAL\/SHM 尚待确认/)
  assert.doesNotMatch(retry.log, /"stop"|"start"/)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-SIGKILL', '数据库本体确实已完成原子替换')
})

// trap 还必须在 `docker compose stop app` **之前**安装。否则 stop 已把服务停下、父 shell 尚未来得及
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
if [ "$1" = "compose" ] && [ "$2" = "stop" ]; then
  : > "$TEST_STOP_ENTERED"
  while :; do sleep 1; done
fi
exec "${process.execPath}" "${path.join(binDir, 'docker-stub.mjs')}" "$@"
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(path.join(stopBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

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
  fs.writeFileSync(path.join(signalBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
      TEST_BLOCK_MV_TARGET: path.join(dataDir, 'app.db'),
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
    await waitForFile(mvEntered)
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
})

// ②a 反向窗口：正常路径已经清掉旧 sidecar、app 启动并为**新库**创建 WAL 后，readiness 失败
// 再进 EXIT trap 时绝不能重复 rm。否则恢复刚完成，应用的新提交又会被当成「旧 WAL」删掉。
test('R7-P1②：app 已启动后 EXIT trap 不得删除新库刚生成的 WAL/SHM', () => {
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
    },
    encoding: 'utf8',
  })

  const states = fs.readFileSync(startStateFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.equal(r.status, 1, 'readiness 超时应以 1 退出')
  assert.ok(states.length >= 2, '正常路径 start 后，EXIT trap 还会做一次幂等 start')
  assert.deepEqual(states[0], { walExists: false, shmExists: false }, '第一次 start 前旧 sidecar 已清干净')
  assert.deepEqual(
    states.at(-1),
    { walExists: true, shmExists: true },
    '🔴 第二次 start 前必须保留 app 为新库创建的 sidecar；false 说明 trap 在运行中误删新 WAL',
  )
  assert.ok(!fs.existsSync(path.join(dataDir, '.restore-in-progress')), 'readiness 失败但状态安全时应释放锁')
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
  fs.writeFileSync(path.join(failBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
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
      TEST_FAIL_RM_WAL: wal,
      TEST_FAIL_RM_SHM: shm,
    },
    encoding: 'utf8',
  })

  const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const starts = calls.filter((c) => c[0] === 'compose' && c[1] === 'start')
  assert.equal(r.status, 1, `sidecar 清理失败应以 1 退出：\n${r.stdout}\n${r.stderr}`)
  assert.equal(starts.length, 0, '🔴 旧 sidecar 未清掉时绝不能调用 start')
  assert.ok(fs.existsSync(wal) && fs.existsSync(shm), '前置：注入确实让旧 sidecar 保持存在')
  assert.match(r.stderr, /拒绝重启 app|app 保持停止/, '必须明确说明是为防混库而保持停机')
  assert.ok(fs.existsSync(path.join(dataDir, '.restore-in-progress', 'replace-armed')), '不安全失败必须保留 armed 锁')
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
    calls.filter((c) => c[0] === 'compose' && c[1] === 'start').length >= 1,
    '🔴 trap 仍须重启 app',
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
    timeout: 10_000,
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
