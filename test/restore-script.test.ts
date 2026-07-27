import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
if (args[1] === 'stop' || args[1] === 'start') process.exit(0)
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

// 建一个带 marker 行的真 WAL 库，用于分辨「还原出来的到底是哪一份」
function makeDb(p: string, marker: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.rmSync(p, { force: true })
  const d = new DatabaseSync(p)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('CREATE TABLE marker (v TEXT)')
  d.prepare('INSERT INTO marker (v) VALUES (?)').run(marker)
  d.close()
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

// ① 🔴🔴 必修 1 的核心回归：从 pre-restore.db 二次反悔
//    用户跑过一次 restore、发现还是不对，想拿 pre-restore.db 回到最初状态——最自然的路径。
//    修复前：脚本先用**当前 app.db** 重建同名的 pre-restore.db，把恢复源就地覆盖掉，
//    再 install 它 → app.db 原封不动还是坏的那份，而唯一回滚点已经没了。
//    最毒的是全程不报错：打印 ✅、/api/ready 也过（库合法、schema 版本也对），用户不会发现。
test('必修1：从 pre-restore.db 还原 → 拿到的是 ORIGINAL，不是被当前库覆盖后的内容', () => {
  const { dataDir, backupsDir } = scene('self-destruct', 'CURRENT-BROKEN')
  const snap = path.join(backupsDir, 'pre-restore.db')
  makeDb(snap, 'ORIGINAL')

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
  // 临时副本要清掉，不留垃圾
  assert.ok(
    !fs.existsSync(path.join(backupsDir, '.restore-src.db')),
    '临时副本 .restore-src.db 应被清理',
  )
})

// ①b 常规还原（快照是某份 backup-*.db）不受必修 1 的改动影响
test('必修1 回归：从 backup-*.db 常规还原仍正确，且现场存进 pre-restore.db', () => {
  const { dataDir, backupsDir } = scene('normal', 'CURRENT')
  const snap = path.join(backupsDir, 'backup-2026-07-26T01-00-00-a1b2c3.db')
  makeDb(snap, 'SNAPSHOT-A')

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
  makeDb(full, 'SNAPSHOT-B')
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

// ②b 完好的快照不能被 quick_check 误杀——尤其是**纯 cp 出来的**快照仍是 journal_mode=wal，
//     只读打开时 SQLite 要在同目录建 -wal/-shm，用错打开方式会把好快照判成坏的
test('建议3：纯 cp 出来的 wal 模式快照（非 VACUUM 产物）不被误判为损坏', () => {
  const { dataDir, backupsDir } = scene('walcopy', 'CURRENT')
  // 直接 cp 一个活动 WAL 库的主文件——保留 journal_mode=wal
  const live = path.join(backupsDir, 'live.db')
  makeDb(live, 'SNAPSHOT-C')
  const snap = path.join(backupsDir, 'copied.db')
  fs.copyFileSync(live, snap)
  {
    const d = new DatabaseSync(snap, { readOnly: true })
    const jm = d.prepare('PRAGMA journal_mode').get() as unknown as { journal_mode: string }
    d.close()
    assert.equal(jm.journal_mode, 'wal', '前置：这份快照确实是 wal 模式')
    // 上面这次只读打开会在同目录留下 -wal/-shm，清掉以免干扰
    fs.rmSync(snap + '-wal', { force: true })
    fs.rmSync(snap + '-shm', { force: true })
  }

  const r = runRestore(dataDir, backupsDir, snap)
  assert.equal(r.status, 0, `wal 模式的完好快照不该被拒：\n${r.stdout}\n${r.stderr}`)
  assert.equal(readMarker(path.join(dataDir, 'app.db')), 'SNAPSHOT-C')
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
  makeDb(snap, 'SNAPSHOT-D')

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
// P6-R2 复审三轮第 1 条回归：DB_PATH 覆盖 fail-closed 守卫
//
// backupPaths 尊重 DB_PATH，但 restore.sh 此前硬编码 `DB="$DATA_DIR/app.db"`，在 DB_PATH
// 覆盖时要么恢复到错误位置、要么 realpath 失败崩。解析 DB_PATH 的通用逻辑需要处理符号链接/相对
// 路径/cwd 不定/多级 ../，脚本层做不到以 Node 同样逻辑归一 → fail-closed 简单守卫：检测到
// DB_PATH≠默认值 → 拒绝运行 + 清晰报错。
// ============================================================================

test('复审三轮1：DB_PATH 覆盖且≠默认值 → fail-closed 拒绝运行', () => {
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
    assert.equal(r.status, 2, '🔴 检测到非默认 DB_PATH 必须以 exit 2 拒绝')
    assert.match(r.stderr, /不支持非默认 DB_PATH/, '🔴 必须清晰说明原因')
    assert.match(r.stderr, /不可忽略本错误/, '🔴 必须警告强行执行后果')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
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
